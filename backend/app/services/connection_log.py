"""Request-scoped upstream connection log (HERE, Mapbox, OSRM, Overpass…)."""

from __future__ import annotations

import contextvars
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from typing import Any, Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.services.secrets_redact import redact_secrets

_SECRET_KEYS = frozenset(
    {
        "apikey",
        "api_key",
        "access_token",
        "token",
        "key",
        "authorization",
        "password",
        "secret",
    }
)

_log_var: contextvars.ContextVar[list["ConnectionLogEntry"] | None] = (
    contextvars.ContextVar("cyclegen_connection_log", default=None)
)


@dataclass
class ConnectionLogEntry:
    """One upstream hop visible in the API console."""

    t_ms: int
    provider: str
    phase: str  # start | ok | error | info
    method: str = ""
    host: str = ""
    path: str = ""
    url: str = ""
    status: int | str | None = None
    duration_ms: int | None = None
    detail: str | None = None
    bytes_hint: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _redact_params(params: dict[str, Any] | None) -> dict[str, Any] | None:
    if not params:
        return None
    out: dict[str, Any] = {}
    for k, v in params.items():
        if str(k).lower() in _SECRET_KEYS:
            out[k] = "***"
        elif isinstance(v, list):
            out[k] = [
                "***" if str(k).lower() in _SECRET_KEYS else x for x in v
            ]
        else:
            out[k] = v
    return out


def safe_url(url: str, params: dict[str, Any] | None = None) -> tuple[str, str, str]:
    """Return (host, path, full_url_redacted) for console display."""
    parts = urlsplit(url)
    host = parts.netloc or ""
    path = parts.path or "/"
    q = dict(parse_qsl(parts.query, keep_blank_values=True))
    if params:
        for k, v in params.items():
            if isinstance(v, list):
                # last wins for display
                q[k] = v[-1] if v else ""
            else:
                q[str(k)] = "" if v is None else str(v)
    redacted = {
        k: ("***" if k.lower() in _SECRET_KEYS else v) for k, v in q.items()
    }
    query = urlencode(redacted, doseq=True)
    full = urlunsplit((parts.scheme, host, path, query, ""))
    return host, path, full


def begin_connection_log() -> list[ConnectionLogEntry]:
    buf: list[ConnectionLogEntry] = []
    _log_var.set(buf)
    return buf


def get_connection_log() -> list[ConnectionLogEntry]:
    return list(_log_var.get() or [])


def clear_connection_log() -> None:
    _log_var.set(None)


@contextmanager
def connection_log_scope() -> Iterator[list[ConnectionLogEntry]]:
    buf = begin_connection_log()
    try:
        yield buf
    finally:
        clear_connection_log()


def record(
    *,
    provider: str,
    phase: str,
    method: str = "",
    url: str = "",
    params: dict[str, Any] | None = None,
    status: int | str | None = None,
    duration_ms: int | None = None,
    detail: str | None = None,
    bytes_hint: str | None = None,
) -> ConnectionLogEntry | None:
    buf = _log_var.get()
    if buf is None:
        return None
    host, path, full = ("", "", "")
    if url:
        host, path, full = safe_url(url, _redact_params(params))
    entry = ConnectionLogEntry(
        t_ms=_now_ms(),
        provider=provider,
        phase=phase,
        method=method.upper() if method else "",
        host=host,
        path=path,
        url=full,
        status=status,
        duration_ms=duration_ms,
        detail=str(redact_secrets(detail)) if detail else None,
        bytes_hint=bytes_hint,
    )
    buf.append(entry)
    return entry


def normalize_provider(service: str) -> str:
    s = (service or "upstream").strip()
    low = s.lower()
    if "here" in low:
        return "HERE"
    if "mapbox" in low:
        return "Mapbox"
    if "osrm" in low:
        return "OSRM"
    if "overpass" in low:
        return "Overpass"
    if "open-meteo" in low or "openmeteo" in low:
        return "Open-Meteo"
    if "open-elevation" in low or "openelevation" in low:
        return "Open-Elevation"
    if "opentopo" in low:
        return "OpenTopoData"
    if "nominatim" in low:
        return "Nominatim"
    return s
