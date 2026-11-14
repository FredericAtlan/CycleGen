"""Geocoding (OpenStreetMap) — address → lat/lon.

Photon (komoot) first, Nominatim as fallback: Nominatim rate-limits shared
cloud egress IPs (429), which cost seconds on every lookup.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import Any

import httpx
from fastapi import HTTPException

from app.services.data_fetcher import _curl_json

logger = logging.getLogger(__name__)

NOMINATIM_URL = os.getenv(
    "NOMINATIM_URL", "https://nominatim.openstreetmap.org/search"
).rstrip("/")
PHOTON_URL = os.getenv("PHOTON_URL", "https://photon.komoot.io/api").rstrip("/")

# Identifiable User-Agent, as required by the Nominatim usage policy.
GEOCODER_USER_AGENT = os.getenv(
    "GEOCODER_USER_AGENT",
    "CycleGen/0.1 (+https://github.com/FredericAtlan/CycleGen)",
)

# Nominatim public etiquette: ≤1 request / second (we use 1.1s margin).
_GEOCODE_MIN_INTERVAL_S = 1.1
_geocode_lock = threading.Lock()
_geocode_last_mono = 0.0
# Callers queue for a slot; beyond this backlog they get a 429.
_GEOCODE_MAX_WAIT_S = 5.0


def _reserve_geocode_slot() -> float:
    """Reserve the next Nominatim slot; return how long to wait before it."""
    global _geocode_last_mono
    with _geocode_lock:
        now = time.monotonic()
        start = max(now, _geocode_last_mono + _GEOCODE_MIN_INTERVAL_S)
        wait = start - now
        if wait > _GEOCODE_MAX_WAIT_S:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Geocode rate limit: max 1 request / {_GEOCODE_MIN_INTERVAL_S}s "
                    "(Nominatim etiquette). Retry shortly."
                ),
            )
        _geocode_last_mono = start
        return wait


async def _throttle_geocode() -> None:
    """In-process global rate limit for Nominatim (B10): wait for a free slot."""
    wait = _reserve_geocode_slot()
    if wait > 0:
        await asyncio.sleep(wait)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math

    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


async def _photon_search(
    client: httpx.AsyncClient,
    q: str,
    *,
    near_lat: float | None,
    near_lon: float | None,
    countrycodes: str,
) -> list[dict[str, Any]] | None:
    """Photon lookup, mapped to Nominatim-shaped hits {lat, lon, display_name}.

    Returns ``None`` when Photon is unreachable or answers with an error.
    """
    params: dict[str, str] = {"q": q, "limit": "5"}
    if near_lat is not None and near_lon is not None:
        params["lat"] = f"{near_lat}"
        params["lon"] = f"{near_lon}"
    try:
        resp = await client.get(
            PHOTON_URL,
            params=params,
            headers={"User-Agent": GEOCODER_USER_AGENT, "Accept": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
    except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
        logger.warning("Photon failed (%s); Nominatim fallback", exc)
        return None

    wanted = {c.strip().upper() for c in countrycodes.split(",") if c.strip()}
    hits: list[dict[str, Any]] = []
    for feat in (data or {}).get("features") or []:
        props = feat.get("properties") or {}
        coords = (feat.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        if wanted and str(props.get("countrycode") or "").upper() not in wanted:
            continue
        parts = [props.get(k) for k in ("name", "city", "postcode", "state", "country")]
        label = ", ".join(dict.fromkeys(str(p) for p in parts if p))
        hits.append({"lat": coords[1], "lon": coords[0], "display_name": label or q})
    return hits


async def _nominatim_search(
    client: httpx.AsyncClient,
    params: dict[str, str],
    headers: dict[str, str],
) -> Any:
    """Nominatim lookup (httpx, then system curl); 503 when both fail."""
    await _throttle_geocode()
    try:
        resp = await client.get(NOMINATIM_URL, params=params, headers=headers)
        if resp.status_code in {403, 406, 429, 502, 503, 504}:
            raise httpx.RequestError(f"HTTP {resp.status_code}", request=resp.request)
        resp.raise_for_status()
        return resp.json()
    except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
        logger.warning("Nominatim httpx failed (%s); curl fallback", exc)
    try:
        return await _curl_json("GET", NOMINATIM_URL, params=params)
    except (RuntimeError, ValueError) as curl_exc:
        logger.warning("Nominatim curl failed (%s)", curl_exc)
        raise HTTPException(
            status_code=503,
            detail="Geocoding service unavailable (Photon and Nominatim). Retry shortly.",
        ) from curl_exc


async def geocode_address(
    query: str,
    *,
    client: httpx.AsyncClient | None = None,
    near_lat: float | None = None,
    near_lon: float | None = None,
    countrycodes: str | None = None,
) -> dict[str, Any]:
    """Return {lat, lon, display_name} for the best match (Photon, then Nominatim).

    When ``near_lat``/``near_lon`` are set, prefer candidates close to that
    point (fixes ambiguous place names like « Richebourg » near Houdan).
    """
    q = (query or "").strip()
    if len(q) < 2:
        raise HTTPException(status_code=400, detail="Address query is too short")

    cc = (countrycodes if countrycodes is not None else os.getenv("GEOCODE_COUNTRYCODES", "fr")).strip()
    params: dict[str, str] = {
        "q": q,
        "format": "json",
        "limit": "5",
        "addressdetails": "0",
    }
    if cc:
        params["countrycodes"] = cc
    if near_lat is not None and near_lon is not None:
        # Prefer results near the sibling endpoint (~±0.6° ≈ 50–60 km).
        pad = 0.6
        params["viewbox"] = (
            f"{near_lon - pad},{near_lat + pad},{near_lon + pad},{near_lat - pad}"
        )
        params["bounded"] = "0"

    headers = {
        "User-Agent": GEOCODER_USER_AGENT,
        "Accept": "application/json",
    }

    owns = client is None
    if owns:
        client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
    assert client is not None
    payload: Any = None
    try:
        payload = await _photon_search(
            client, q, near_lat=near_lat, near_lon=near_lon, countrycodes=cc
        )
        if not payload:
            payload = await _nominatim_search(client, params, headers)
    finally:
        if owns:
            await client.aclose()

    if not isinstance(payload, list) or not payload:
        raise HTTPException(
            status_code=404,
            detail=f"No location found for address: {q}",
        )

    scored: list[tuple[float, dict[str, Any]]] = []
    for hit in payload:
        try:
            lat = float(hit["lat"])
            lon = float(hit["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if near_lat is not None and near_lon is not None:
            score = _haversine_km(near_lat, near_lon, lat, lon)
        else:
            # Without bias, keep Nominatim order (importance-ish).
            score = float(len(scored))
        scored.append((score, hit))

    if not scored:
        raise HTTPException(
            status_code=502,
            detail="Geocoder returned an invalid coordinate payload",
        )

    scored.sort(key=lambda x: x[0])
    hit = scored[0][1]
    lat = float(hit["lat"])
    lon = float(hit["lon"])
    display = str(hit.get("display_name") or q)
    return {"lat": lat, "lon": lon, "display_name": display, "query": q}
