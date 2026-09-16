"""HERE Routing API v8 router (ADAS maxSpeed + elevation polyline)."""

from __future__ import annotations

import logging
import math
import os
from datetime import datetime
from typing import Any

import flexpolyline
import httpx
from fastapi import HTTPException

from app.models.schemas import CycleGenWarning, LatLon
from app.services.routing.base import RouteTrafficResult, TrafficRouter
from app.services.secrets_redact import redact_secrets

logger = logging.getLogger(__name__)

HERE_ROUTING_URL = os.getenv(
    "HERE_ROUTING_URL", "https://router.hereapi.com/v8/routes"
).rstrip("/")

# Fallback posted speed when HERE omits maxSpeed on the first span (m/s).
_DEFAULT_LEGAL_MPS = 90.0 / 3.6


def _here_api_key() -> str:
    return os.getenv("HERE_API_KEY", "").strip()


def _haversine_m(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    r = 6_371_000.0
    p0, p1 = math.radians(lat0), math.radians(lat1)
    dphi = math.radians(lat1 - lat0)
    dlmb = math.radians(lon1 - lon0)
    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(p0) * math.cos(p1) * math.sin(dlmb / 2.0) ** 2
    )
    return 2.0 * r * math.asin(min(1.0, math.sqrt(a)))


def decode_here_polyline(encoded: str) -> list[tuple[float, float, float | None]]:
    """Decode Flexible Polyline → (lat, lon, alt_m|None)."""
    if not encoded:
        return []
    pts = flexpolyline.decode(encoded)
    out: list[tuple[float, float, float | None]] = []
    for p in pts:
        if len(p) >= 3:
            out.append((float(p[0]), float(p[1]), float(p[2])))
        elif len(p) >= 2:
            out.append((float(p[0]), float(p[1]), None))
    return out


def map_maxspeed_spans_to_points(
    n_points: int,
    spans: list[dict[str, Any]],
    *,
    default_mps: float = _DEFAULT_LEGAL_MPS,
) -> list[float]:
    """
    Map HERE section spans (maxSpeed in m/s, offset = polyline index) onto
    per-vertex legal speeds with strict forward-fill.
    """
    if n_points <= 0:
        return []
    speeds = [float("nan")] * n_points
    ordered = sorted(
        (s for s in spans if isinstance(s, dict)),
        key=lambda s: int(s.get("offset") or 0),
    )
    for span in ordered:
        offset = int(span.get("offset") or 0)
        if offset < 0 or offset >= n_points:
            continue
        raw = span.get("maxSpeed", span.get("speedLimit"))
        if raw is None:
            continue
        try:
            val = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(val) or val <= 0:
            continue
        # HERE documents maxSpeed in m/s; values > 80 are almost certainly km/h.
        if val > 80.0:
            val = val / 3.6
        speeds[offset] = val

    # Forward-fill; seed with default if leading spans lack maxSpeed.
    last = default_mps
    for i in range(n_points):
        if math.isfinite(speeds[i]):
            last = float(speeds[i])
        else:
            speeds[i] = last
    return [float(v) for v in speeds]


def _segment_distances(coords: list[tuple[float, float, float | None]]) -> list[float]:
    if len(coords) < 2:
        return []
    out: list[float] = []
    for i in range(len(coords) - 1):
        lat0, lon0, _ = coords[i]
        lat1, lon1, _ = coords[i + 1]
        out.append(_haversine_m(lat0, lon0, lat1, lon1))
    return out


def parse_here_routes_payload(payload: dict[str, Any]) -> RouteTrafficResult:
    """Parse HERE v8 JSON into RouteTrafficResult (all sections concatenated)."""
    routes = payload.get("routes") or []
    if not routes:
        raise HTTPException(status_code=502, detail="HERE returned no routes")
    sections = routes[0].get("sections") or []
    if not sections:
        raise HTTPException(status_code=502, detail="HERE route has no sections")

    all_coords: list[tuple[float, float, float | None]] = []
    legal_per_vertex: list[float] = []
    distance_m = 0.0
    duration_s = 0.0
    warnings: list[CycleGenWarning] = []
    missing_maxspeed = False

    for sec_i, section in enumerate(sections):
        encoded = section.get("polyline") or ""
        coords = decode_here_polyline(encoded)
        if not coords:
            continue

        # Drop duplicated junction vertex when concatenating sections.
        if all_coords and coords:
            lat0, lon0, _ = all_coords[-1]
            lat1, lon1, _ = coords[0]
            if abs(lat0 - lat1) < 1e-7 and abs(lon0 - lon1) < 1e-7:
                coords = coords[1:]
                offset_shift = 1
            else:
                offset_shift = 0
        else:
            offset_shift = 0

        if not coords:
            continue

        spans_raw = section.get("spans") or []
        # Adjust offsets when we dropped the first vertex of a section.
        adjusted_spans: list[dict[str, Any]] = []
        for sp in spans_raw:
            if not isinstance(sp, dict):
                continue
            sp2 = dict(sp)
            off = int(sp2.get("offset") or 0) - offset_shift
            if off < 0:
                continue
            sp2["offset"] = off
            if sp2.get("maxSpeed") is None and sp2.get("speedLimit") is None:
                missing_maxspeed = True
            adjusted_spans.append(sp2)

        sec_legal = map_maxspeed_spans_to_points(len(coords), adjusted_spans)
        if any(
            abs(v - _DEFAULT_LEGAL_MPS) < 1e-9 for v in sec_legal[:1]
        ) and not any(
            (s.get("maxSpeed") is not None or s.get("speedLimit") is not None)
            for s in adjusted_spans
        ):
            missing_maxspeed = True

        all_coords.extend(coords)
        legal_per_vertex.extend(sec_legal)

        summary = section.get("summary") or {}
        distance_m += float(summary.get("length") or 0.0)
        duration_s += float(summary.get("duration") or 0.0)

        if sec_i > 0:
            warnings.append(
                CycleGenWarning(
                    code="here_multi_section",
                    message=f"HERE section {sec_i} concatenated into route geometry.",
                    s0=0.0,
                    s1=distance_m,
                    source="HereRouter",
                )
            )

    if len(all_coords) < 2:
        raise HTTPException(status_code=502, detail="HERE returned empty geometry")

    # Segment speeds: one value per edge (n-1), from the start vertex of each edge.
    n = len(all_coords)
    if len(legal_per_vertex) != n:
        legal_per_vertex = map_maxspeed_spans_to_points(n, [])

    seg_legal = legal_per_vertex[:-1] if n >= 2 else list(legal_per_vertex)
    seg_dist = _segment_distances(all_coords)
    if distance_m <= 0.0:
        distance_m = float(sum(seg_dist))

    elevations: list[float] = []
    has_elev = False
    for _, _, alt in all_coords:
        if alt is not None and math.isfinite(alt):
            elevations.append(float(alt))
            has_elev = True
        else:
            elevations.append(0.0)

    if missing_maxspeed:
        warnings.append(
            CycleGenWarning(
                code="here_maxspeed_forward_fill",
                message="Some HERE spans lacked maxSpeed — previous limit forward-filled.",
                s0=0.0,
                s1=distance_m,
                source="HereRouter",
            )
        )

    return RouteTrafficResult(
        geometry=[LatLon(lat=c[0], lon=c[1]) for c in all_coords],
        distance_m=distance_m,
        duration_s=duration_s,
        segment_speeds_legal_mps=seg_legal,
        segment_speeds_traffic_mps=list(seg_legal),
        segment_distances_m=seg_dist,
        traffic_source="HERE/maxSpeed",
        warnings=warnings,
        elevations_m=elevations if has_elev else None,
    )


class HereRouter(TrafficRouter):
    """HERE Routing v8 — legal maxSpeed spans + 3D elevation polyline."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        client: httpx.AsyncClient | None = None,
        request_json=None,
        base_url: str | None = None,
    ) -> None:
        self.api_key = (api_key if api_key is not None else _here_api_key()).strip()
        self._client = client
        self._request_json = request_json
        self.base_url = (base_url or HERE_ROUTING_URL).rstrip("/")

    async def route(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        *,
        vias: list[tuple[float, float]] | None = None,
        depart_at: datetime,
    ) -> RouteTrafficResult:
        _ = depart_at  # free-flow / posted limits — no dynamic traffic envelope
        key = self.api_key or _here_api_key()
        if not key:
            raise HTTPException(
                status_code=503,
                detail="HERE_API_KEY missing — set it in the environment to use HERE/ADAS",
            )
        try:
            payload = await self._fetch(start, end, vias=vias, api_key=key)
            return parse_here_routes_payload(payload)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            safe = redact_secrets(exc)
            logger.warning("HERE routing failed: %s", safe)
            raise HTTPException(
                status_code=502, detail=f"HERE routing failed: {safe}"
            ) from exc

    async def _fetch(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        *,
        vias: list[tuple[float, float]] | None,
        api_key: str,
    ) -> dict[str, Any]:
        # HERE expects lat,lon (unlike Mapbox lon,lat path).
        params: list[tuple[str, str]] = [
            ("transportMode", "car"),
            ("origin", f"{start[0]:.6f},{start[1]:.6f}"),
            ("destination", f"{end[0]:.6f},{end[1]:.6f}"),
            ("return", "polyline,elevation,summary"),
            ("spans", "maxSpeed"),
            ("apiKey", api_key),
        ]
        for via in vias or []:
            params.append(("via", f"{via[0]:.6f},{via[1]:.6f}"))

        url = self.base_url
        if self._request_json is not None:
            # Convert list params for injectors that expect a dict (join via).
            as_dict: dict[str, Any] = {}
            vias_list: list[str] = []
            for k, v in params:
                if k == "via":
                    vias_list.append(v)
                else:
                    as_dict[k] = v
            if vias_list:
                as_dict["via"] = vias_list
            return await self._request_json("GET", url, params=as_dict, service="HERE")

        assert self._client is not None
        resp = await self._client.get(url, params=params)
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"HERE HTTP {resp.status_code}: {resp.text[:200]}",
            )
        return resp.json()
