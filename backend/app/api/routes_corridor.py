"""Corridor API — POST /corridor/build."""

from __future__ import annotations

import math
import os
from uuid import uuid4

from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    CorridorBuildRequest,
    CorridorBuildResponse,
    SpatialCorridor,
)
from app.services.ephemeral_store import EphemeralStore
from app.services.spatial_processor import build_spatial_corridor

router = APIRouter(tags=["corridor"])

_MAX_CORRIDORS = int(os.getenv("CYCLEGEN_MAX_CORRIDORS", "64"))
_CORRIDOR_TTL_S = float(os.getenv("CYCLEGEN_CORRIDOR_TTL_S", "3600"))

# In-memory store for downstream agents (simulate / export / calibrate).
CORRIDOR_STORE: EphemeralStore[SpatialCorridor] = EphemeralStore(
    max_items=_MAX_CORRIDORS,
    ttl_s=_CORRIDOR_TTL_S,
    name="CORRIDOR_STORE",
)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _route_length_m(geometry: list) -> float:
    if len(geometry) < 2:
        return 0.0
    total = 0.0
    for i in range(1, len(geometry)):
        a, b = geometry[i - 1], geometry[i]
        total += _haversine_m(
            float(a.lat), float(a.lon), float(b.lat), float(b.lon)
        )
    return total


@router.post("/corridor/build", response_model=CorridorBuildResponse)
async def build_corridor(body: CorridorBuildRequest) -> CorridorBuildResponse:
    """Build SpatialCorridor (S, α, V_limite, S_feux, events) from a route payload."""
    if not body.route.geometry:
        raise HTTPException(status_code=400, detail="route.geometry must not be empty")

    max_pts = int(os.getenv("CYCLEGEN_MAX_ROUTE_POINTS", "12000"))
    max_km = float(os.getenv("CYCLEGEN_MAX_ROUTE_KM", "120"))
    n = len(body.route.geometry)
    if n > max_pts:
        raise HTTPException(
            status_code=400,
            detail=f"route.geometry too large ({n} points; max {max_pts})",
        )
    dist_m = float(getattr(body.route, "distance_m", 0.0) or 0.0)
    if dist_m <= 0:
        dist_m = _route_length_m(body.route.geometry)
    if dist_m > max_km * 1000.0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"route too long ({dist_m / 1000.0:.1f} km; "
                f"max {max_km:g} km)"
            ),
        )

    corridor = build_spatial_corridor(
        body.route,
        smooth_window=body.smooth_window,
        smooth_polyorder=body.smooth_polyorder,
        a_y_mps2=body.a_y_mps2,
        max_grade=body.max_grade,
        sg_min_span_m=body.sg_min_span_m,
        trap_length_m=body.trap_length_m,
        alpha_min_pct=body.alpha_min_pct,
        alpha_max_pct=body.alpha_max_pct,
        legal_smooth_mode=body.legal_smooth_mode,
        legal_smooth_window_m=body.legal_smooth_window_m,
        legal_min_run_m=body.legal_min_run_m,
        enable_speed_limits=body.enable_speed_limits,
        global_max_speed_kmh=body.global_max_speed_kmh,
        include_traffic_in_envelope=body.include_traffic_in_envelope,
        speed_sources=list(body.speed_sources or []) or None,
        speed_combine=body.speed_combine,
        elevation_sources=list(body.elevation_sources or []) or None,
        elevation_combine=body.elevation_combine,
        speed_min_kmh=body.speed_min_kmh,
        speed_max_kmh=body.speed_max_kmh,
    )
    corridor_id = uuid4().hex
    if not CORRIDOR_STORE.try_put(corridor_id, corridor):
        raise HTTPException(
            status_code=429,
            detail=(
                f"too many corridors in memory (max {CORRIDOR_STORE.max_items}); "
                "retry later or raise CYCLEGEN_MAX_CORRIDORS"
            ),
        )
    return CorridorBuildResponse(
        corridor=corridor,
        corridor_id=corridor_id,
        v_limite_legal=list(corridor.V_limite_legal),
        v_traffic=list(corridor.V_traffic),
        v_curve=list(corridor.V_curve),
        v_envelope=list(corridor.V_envelope),
        traffic_source=corridor.traffic_source,
        warnings=list(corridor.warnings),
    )
