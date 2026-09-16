"""Multi-router orchestrator: parallel HERE + Mapbox + OSRM with S-alignment.

The primary router (first in the ordered list) dictates the geometry / S-axis.
Secondary routers' vertex-level V_legal, V_traffic and Z are projected onto
that primary axis via nearest-S mapping.

Layered goals
-------------
1. Ergonomics: the UI ticks a set of routers, backend returns per-router series
   ready to combine into V_legal = combine(cochés).
2. Robustness: routers with missing keys / API errors don't crash the request;
   they surface as ``router_status`` entries so the UI can hint the user.
3. No duplicate work: OSM maxspeed enrichment stays in ``data_fetcher`` on the
   primary bbox; router services only fetch what they know natively.

The service is intentionally stateless: hand it an async client and it returns
``MultiRouteResult`` with per-router payloads and the composed primary payload.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Iterable

from app.models.schemas import CycleGenWarning, LatLon, RoutingProfile
from app.services.routing.base import RouteTrafficResult
from app.services.routing.here_router import HereRouter
from app.services.routing.mapbox_router import MapboxRouter
from app.services.routing.osrm_router import OsrmRouter

logger = logging.getLogger(__name__)

# Canonical short keys used across API surface (schemas, front, docs).
ROUTER_KEY: dict[RoutingProfile, str] = {
    RoutingProfile.HERE_ADAS: "here",
    RoutingProfile.MAPBOX_TRAFFIC: "mapbox",
    RoutingProfile.CAR_OSRM: "osrm",
}

# Preferred primary order when the caller passes an empty list.
DEFAULT_PRIORITY: list[RoutingProfile] = [
    RoutingProfile.HERE_ADAS,
    RoutingProfile.MAPBOX_TRAFFIC,
    RoutingProfile.CAR_OSRM,
]


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------


def router_available(profile: RoutingProfile) -> bool:
    """Return True when the router has enough env config to run."""
    if profile == RoutingProfile.HERE_ADAS:
        return bool(os.getenv("HERE_API_KEY", "").strip())
    if profile == RoutingProfile.MAPBOX_TRAFFIC:
        return bool(os.getenv("MAPBOX_ACCESS_TOKEN", "").strip())
    if profile == RoutingProfile.CAR_OSRM:
        # OSRM always usable via public demo or self-hosted URL.
        return True
    return False


def resolve_router_selection(
    requested: Iterable[RoutingProfile] | None,
) -> list[RoutingProfile]:
    """Order & filter routers, keeping only those with runtime availability.

    - Preserves caller order (first = primary).
    - If nothing is passed, uses ``DEFAULT_PRIORITY`` filtered by availability.
    - Guarantees at least one entry — falls back to OSRM.
    """
    ordered: list[RoutingProfile] = []
    seen: set[RoutingProfile] = set()
    for p in requested or []:
        if p in seen:
            continue
        seen.add(p)
        ordered.append(p)
    if not ordered:
        ordered = [p for p in DEFAULT_PRIORITY if router_available(p)]
    if not ordered:
        ordered = [RoutingProfile.CAR_OSRM]
    return ordered


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------


@dataclass
class MultiRouteResult:
    """Aggregated multi-router outcome ready to feed RouteAnalyzeResponse."""

    primary_profile: RoutingProfile
    primary: RouteTrafficResult
    routers_used: list[str] = field(default_factory=list)
    router_status: dict[str, str] = field(default_factory=dict)
    # Vertex-aligned legal / traffic speeds per router (m/s).
    legal_by_router: dict[str, list[float]] = field(default_factory=dict)
    traffic_by_router: dict[str, list[float]] = field(default_factory=dict)
    # Vertex-aligned elevations per source (m).
    elevations_by_source: dict[str, list[float]] = field(default_factory=dict)
    warnings: list[CycleGenWarning] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Router construction
# ---------------------------------------------------------------------------


def _build_router(
    profile: RoutingProfile,
    *,
    client,
    request_json: Callable[..., Awaitable[Any]] | None,
    osrm_base_url: str,
):
    if profile == RoutingProfile.HERE_ADAS:
        return HereRouter(client=client, request_json=request_json)
    if profile == RoutingProfile.MAPBOX_TRAFFIC:
        osrm_fallback = OsrmRouter(
            base_url=osrm_base_url,
            client=client,
            request_json=request_json,
        )
        return MapboxRouter(
            client=client,
            request_json=request_json,
            fallback=osrm_fallback,
        )
    return OsrmRouter(
        base_url=osrm_base_url,
        client=client,
        request_json=request_json,
    )


# ---------------------------------------------------------------------------
# S-axis alignment
# ---------------------------------------------------------------------------


_EARTH_M = 6_371_000.0


def _haversine_m(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    p0, p1 = math.radians(lat0), math.radians(lat1)
    dphi = math.radians(lat1 - lat0)
    dlmb = math.radians(lon1 - lon0)
    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(p0) * math.cos(p1) * math.sin(dlmb / 2.0) ** 2
    )
    return 2.0 * _EARTH_M * math.asin(min(1.0, math.sqrt(a)))


def _cumulative_S(coords: list[LatLon], segment_distances_m: list[float]) -> list[float]:
    n = len(coords)
    if n == 0:
        return []
    if n == 1:
        return [0.0]
    S = [0.0]
    for i in range(n - 1):
        ds = 0.0
        if i < len(segment_distances_m):
            v = float(segment_distances_m[i])
            if math.isfinite(v) and v >= 0:
                ds = v
        if ds <= 0.0:
            ds = _haversine_m(
                coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon
            )
        S.append(S[-1] + ds)
    return S


def _project_vertex_series_onto_primary(
    primary_coords: list[LatLon],
    primary_S: list[float],
    secondary_coords: list[LatLon],
    secondary_S: list[float],
    secondary_vertex_values: list[float],
) -> list[float]:
    """Project a per-vertex series from the secondary geometry onto primary S.

    Uses a simple nearest-S mapping: for each primary vertex si, find the
    secondary vertex whose S is closest (linear scan over sorted arrays).
    Assumes both S vectors are monotonic and start at 0.
    """
    n_p = len(primary_S)
    n_s = min(len(secondary_S), len(secondary_vertex_values))
    if n_p == 0:
        return []
    if n_s == 0 or not secondary_coords:
        return [0.0] * n_p

    # Rescale secondary S so total length matches primary — routers rarely
    # agree to the metre, but the geometric shape does. Rescaling keeps
    # relative section positions consistent.
    total_p = primary_S[-1] if n_p > 1 else 0.0
    total_s = secondary_S[-1] if n_s > 1 else 0.0
    if total_p > 0.0 and total_s > 0.0 and abs(total_p - total_s) / total_p > 0.02:
        ratio = total_p / total_s
        scaled_S = [s * ratio for s in secondary_S[:n_s]]
    else:
        scaled_S = list(secondary_S[:n_s])

    out: list[float] = []
    j = 0
    for si in primary_S:
        while j + 1 < n_s and scaled_S[j + 1] <= si:
            j += 1
        # Nearest between j and j+1.
        best = j
        if j + 1 < n_s:
            if abs(scaled_S[j + 1] - si) < abs(scaled_S[j] - si):
                best = j + 1
        v = secondary_vertex_values[best]
        out.append(float(v) if math.isfinite(v) else 0.0)
    return out


def _segment_speeds_to_vertex(
    n_vertices: int, segment_speeds_mps: list[float]
) -> list[float]:
    """Convert n-1 edge speeds to n vertex speeds (last vertex = last edge)."""
    if n_vertices <= 0:
        return []
    if not segment_speeds_mps:
        return [0.0] * n_vertices
    out = [
        float(v) if math.isfinite(float(v)) else 0.0 for v in segment_speeds_mps
    ]
    while len(out) < n_vertices:
        out.append(out[-1] if out else 0.0)
    return out[:n_vertices]


def _vertex_to_segment_speeds(vertex_speeds: list[float]) -> list[float]:
    """Convert n vertex speeds back to n-1 edge speeds (start-of-edge value)."""
    if len(vertex_speeds) < 2:
        return []
    return list(vertex_speeds[:-1])


# ---------------------------------------------------------------------------
# Public orchestrator
# ---------------------------------------------------------------------------


async def analyze_multi_router(
    *,
    start: tuple[float, float],
    end: tuple[float, float],
    vias: list[tuple[float, float]] | None,
    depart_at: datetime,
    requested_profiles: Iterable[RoutingProfile] | None,
    client,
    request_json: Callable[..., Awaitable[Any]] | None,
    osrm_base_url: str,
) -> MultiRouteResult:
    """Fan-out to every configured router, keep the primary geometry, project rest."""
    profiles = resolve_router_selection(requested_profiles)

    router_status: dict[str, str] = {}
    tasks: list[asyncio.Task[RouteTrafficResult] | None] = []
    active_profiles: list[RoutingProfile] = []

    for profile in profiles:
        key = ROUTER_KEY[profile]
        if not router_available(profile):
            router_status[key] = "skipped:no_key"
            continue
        router = _build_router(
            profile,
            client=client,
            request_json=request_json,
            osrm_base_url=osrm_base_url,
        )
        tasks.append(
            asyncio.create_task(
                router.route(start, end, vias=vias, depart_at=depart_at),
                name=f"router:{key}",
            )
        )
        active_profiles.append(profile)

    if not tasks:
        # Force OSRM as a last resort to keep the pipeline alive.
        active_profiles = [RoutingProfile.CAR_OSRM]
        osrm = OsrmRouter(
            base_url=osrm_base_url, client=client, request_json=request_json
        )
        tasks = [
            asyncio.create_task(
                osrm.route(start, end, vias=vias, depart_at=depart_at),
                name="router:osrm",
            )
        ]

    results: list[tuple[RoutingProfile, RouteTrafficResult | Exception]] = []
    gathered = await asyncio.gather(*tasks, return_exceptions=True)
    for profile, res in zip(active_profiles, gathered):
        results.append((profile, res))

    # Pick primary: first successful in requested order.
    primary_profile: RoutingProfile | None = None
    primary: RouteTrafficResult | None = None
    for profile, res in results:
        key = ROUTER_KEY[profile]
        if isinstance(res, Exception):
            msg = str(res)[:200]
            router_status[key] = f"error:{msg}"
            logger.warning("Router %s failed: %s", key, msg)
            continue
        router_status[key] = "ok"
        if primary_profile is None:
            primary_profile = profile
            primary = res

    if primary is None or primary_profile is None:
        # All routers failed — raise the first exception for observability.
        for _, res in results:
            if isinstance(res, Exception):
                raise res
        raise RuntimeError("No router returned a valid result")

    # Primary S-axis.
    primary_S = _cumulative_S(primary.geometry, primary.segment_distances_m)
    n_primary = len(primary.geometry)

    # Per-router aligned series.
    legal_by_router: dict[str, list[float]] = {}
    traffic_by_router: dict[str, list[float]] = {}
    elevations_by_source: dict[str, list[float]] = {}
    routers_used: list[str] = []
    warnings: list[CycleGenWarning] = list(primary.warnings)

    for profile, res in results:
        key = ROUTER_KEY[profile]
        if isinstance(res, Exception):
            continue
        routers_used.append(key)
        if profile == primary_profile:
            legal_vertex = _segment_speeds_to_vertex(
                n_primary, res.segment_speeds_legal_mps
            )
            traffic_vertex = _segment_speeds_to_vertex(
                n_primary, res.segment_speeds_traffic_mps
            )
            legal_by_router[key] = legal_vertex
            traffic_by_router[key] = traffic_vertex
            if res.elevations_m and len(res.elevations_m) == n_primary:
                elevations_by_source[key] = [float(z) for z in res.elevations_m]
            continue

        # Secondary → project on primary S.
        sec_S = _cumulative_S(res.geometry, res.segment_distances_m)
        sec_legal_vertex = _segment_speeds_to_vertex(
            len(res.geometry), res.segment_speeds_legal_mps
        )
        sec_traffic_vertex = _segment_speeds_to_vertex(
            len(res.geometry), res.segment_speeds_traffic_mps
        )
        legal_by_router[key] = _project_vertex_series_onto_primary(
            primary.geometry,
            primary_S,
            res.geometry,
            sec_S,
            sec_legal_vertex,
        )
        traffic_by_router[key] = _project_vertex_series_onto_primary(
            primary.geometry,
            primary_S,
            res.geometry,
            sec_S,
            sec_traffic_vertex,
        )
        if res.elevations_m and len(res.elevations_m) == len(res.geometry):
            elevations_by_source[key] = _project_vertex_series_onto_primary(
                primary.geometry,
                primary_S,
                res.geometry,
                sec_S,
                [float(z) for z in res.elevations_m],
            )
        for w in res.warnings:
            warnings.append(
                CycleGenWarning(
                    code=f"router_secondary:{key}:{w.code}",
                    message=f"[{key}] {w.message}",
                    s0=w.s0,
                    s1=w.s1,
                    source=w.source,
                )
            )

    return MultiRouteResult(
        primary_profile=primary_profile,
        primary=primary,
        routers_used=routers_used,
        router_status=router_status,
        legal_by_router=legal_by_router,
        traffic_by_router=traffic_by_router,
        elevations_by_source=elevations_by_source,
        warnings=warnings,
    )
