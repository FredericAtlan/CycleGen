"""Batch scenario runs (same corridor, multiple IDM arms) — scenarios C/D."""

from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    ScenarioArmKpis,
    ScenarioArmResult,
    ScenarioRunRequest,
    ScenarioRunResponse,
)
from app.services.kinematic_solver import IDMSolver
from app.services.profile_metrics import compare_profile_arms, profile_kpis

router = APIRouter(prefix="/scenario", tags=["Scenario"])


@router.post("/run", response_model=ScenarioRunResponse)
def run_scenario(body: ScenarioRunRequest) -> ScenarioRunResponse:
    if not body.corridor.S:
        raise HTTPException(status_code=400, detail="corridor.S must not be empty")
    max_pts = int(os.getenv("CYCLEGEN_MAX_ROUTE_POINTS", "12000"))
    if len(body.corridor.S) > max_pts:
        raise HTTPException(
            status_code=400,
            detail=f"corridor.S too large ({len(body.corridor.S)} points; max {max_pts})",
        )
    if not body.arms:
        raise HTTPException(status_code=400, detail="At least one arm required")

    warnings: list[str] = []
    arm_payloads: list[dict] = []

    for arm in body.arms:
        overrides = None
        if arm.driver_params is not None:
            overrides = {
                k: v
                for k, v in {
                    "a_max": arm.driver_params.a_max,
                    "b_comf": arm.driver_params.b_comf,
                    "speed_factor": arm.driver_params.speed_factor,
                    "T": arm.driver_params.T,
                    "T_h": arm.driver_params.T_h,
                    "s0": arm.driver_params.s0,
                    "jerk_max": arm.driver_params.jerk_max,
                    "jerk_brake_max": arm.driver_params.jerk_brake_max,
                }.items()
                if v is not None
            } or None
        try:
            solver = IDMSolver(
                body.corridor,
                arm.driver_profile,
                seed=arm.seed,
                max_speed_mps=(
                    float(arm.max_speed_kmh) / 3.6
                    if arm.max_speed_kmh is not None
                    else None
                ),
                param_overrides=overrides,
                tls_override=arm.tls_override,
            )
            profile = solver.solve()
            profile = profile.model_copy(
                update={
                    "traffic_source": body.corridor.traffic_source,
                    "warnings": list(body.corridor.warnings or []),
                }
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=400,
                detail=f"Arm '{arm.id}' failed: {exc}",
            ) from exc

        pdata = profile.model_dump()
        kpis = profile_kpis(pdata)
        arm_payloads.append(
            {
                "id": arm.id,
                "label": arm.label or arm.id,
                "profile": profile,
                "profile_dict": pdata,
                "kpis": kpis,
                "time": pdata["time"],
                "velocity": pdata["velocity"],
            }
        )

    compared = compare_profile_arms(
        [
            {
                "id": a["id"],
                "label": a["label"],
                "profile": a["profile_dict"],
            }
            for a in arm_payloads
        ],
        reference_id=body.reference_arm_id,
    )
    results: list[ScenarioArmResult] = []
    for arm in arm_payloads:
        k = arm["kpis"]
        results.append(
            ScenarioArmResult(
                id=arm["id"],
                label=arm["label"],
                profile=arm["profile"],
                kpis=ScenarioArmKpis(**k),
                time=arm["time"],
                velocity=arm["velocity"],
            )
        )

    if body.corridor.traffic_source == "osrm_freeflow":
        warnings.append(
            "Traffic envelope is OSRM freeflow — peak vs night will not differ "
            "until Mapbox traffic is available."
        )

    return ScenarioRunResponse(
        arms=results,
        reference_id=str(compared["reference_id"]),
        deltas=compared["deltas"],
        warnings=warnings,
    )
