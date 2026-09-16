"""Calibration API — POST /calibrate/n90.

Runs a compact DriverPhysics grid on the AVL N90 (BSM→Albertville) reference,
returns the best-scoring arm + writes ``latest_n90.{json,md}`` under
``backend/app/data/benchmark/calibration/``. Frontend can then push the
recommended physics into the UI via one click.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.api.routes_corridor import CORRIDOR_STORE
from app.models.schemas import (
    N90CalibrateRequest,
    N90CalibrateResponse,
)
from app.services.n90_calibrator import run_n90_calibration

router = APIRouter(prefix="/calibrate", tags=["Calibration"])
logger = logging.getLogger(__name__)


@router.post("/n90", response_model=N90CalibrateResponse)
def calibrate_n90(body: N90CalibrateRequest) -> N90CalibrateResponse:
    corridor = CORRIDOR_STORE.get(body.corridor_id)
    if corridor is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Corridor '{body.corridor_id}' not found in memory. "
                "Rebuild it with /corridor/build first."
            ),
        )
    try:
        result = run_n90_calibration(
            corridor=corridor,
            corridor_id=body.corridor_id,
            reference_id=body.reference_id,
            driver_profile=body.driver_profile,
            seed=body.seed,
            lambda_a=body.lambda_a,
            mu_dt=body.mu_dt,
            a_max_grid=body.a_max_grid,
            b_comf_grid=body.b_comf_grid,
            T_grid=body.T_grid,
            T_h_grid=body.T_h_grid,
            s0_grid=body.s0_grid,
            jerk_max_grid=body.jerk_max_grid,
            jerk_brake_max_grid=body.jerk_brake_max_grid,
            speed_factor_grid=body.speed_factor_grid,
            max_arms=body.max_arms,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return N90CalibrateResponse(**result)
