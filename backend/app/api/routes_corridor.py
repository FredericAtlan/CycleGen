"""Corridor API — POST /corridor/build."""

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    CorridorBuildRequest,
    CorridorBuildResponse,
    SpatialCorridor,
)
from app.services.spatial_processor import build_spatial_corridor

router = APIRouter(tags=["corridor"])

# In-memory store for downstream agents (simulate / export).
CORRIDOR_STORE: dict[str, SpatialCorridor] = {}


@router.post("/corridor/build", response_model=CorridorBuildResponse)
async def build_corridor(body: CorridorBuildRequest) -> CorridorBuildResponse:
    """Build SpatialCorridor (S, α, V_limite, S_feux, events) from a route payload."""
    if not body.route.geometry:
        raise HTTPException(status_code=400, detail="route.geometry must not be empty")

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
    )
    corridor_id = uuid4().hex
    CORRIDOR_STORE[corridor_id] = corridor
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
