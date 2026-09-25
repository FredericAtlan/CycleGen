"""Simulation API — start / WebSocket stream / stop (SUMO or IDM)."""

from __future__ import annotations

import logging
import os
import secrets

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.models.schemas import (
    SimulateStartRequest,
    SimulateStartResponse,
    SimulateStopResponse,
)
from app.services.simulation_manager import (
    SimulationCapacityError,
    create_simulation,
    get_simulation,
    replay_frames_ws,
    request_stop,
    wait_idm_done,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["simulate"])

# WebSocket path relative to API root (/api). Full URL: /api/simulate/ws/{id}?token=…
# Clients MUST pass the ``ws_token`` from SimulateStartResponse as query ``token``.
WS_PATH_TEMPLATE = "/api/simulate/ws/{simulation_id}"


@router.post("/simulate/start", response_model=SimulateStartResponse)
async def simulate_start(body: SimulateStartRequest) -> SimulateStartResponse:
    """Start a microscopic simulation (SUMO if available, else IDM)."""
    if not body.corridor.S:
        raise HTTPException(status_code=400, detail="corridor.S must not be empty")
    max_pts = int(os.getenv("CYCLEGEN_MAX_ROUTE_POINTS", "12000"))
    n = len(body.corridor.S)
    if n > max_pts:
        raise HTTPException(
            status_code=400,
            detail=f"corridor.S too large ({n} points; max {max_pts})",
        )
    if body.corridor.geometry and len(body.corridor.geometry) > max_pts:
        raise HTTPException(
            status_code=400,
            detail=f"corridor.geometry too large (max {max_pts})",
        )

    try:
        record = create_simulation(
            body.corridor,
            body.driver_profile,
            engine=body.engine,
            seed=body.seed,
            max_speed_mps=(
                float(body.max_speed_kmh) / 3.6
                if body.max_speed_kmh is not None
                else None
            ),
            param_overrides=(
                {
                    k: v
                    for k, v in {
                        "a_max": body.driver_params.a_max if body.driver_params else None,
                        "b_comf": body.driver_params.b_comf if body.driver_params else None,
                        "speed_factor": (
                            body.driver_params.speed_factor if body.driver_params else None
                        ),
                        "T": body.driver_params.T if body.driver_params else None,
                        "T_h": body.driver_params.T_h if body.driver_params else None,
                        "s0": body.driver_params.s0 if body.driver_params else None,
                        "jerk_max": (
                            body.driver_params.jerk_max if body.driver_params else None
                        ),
                        "jerk_brake_max": (
                            body.driver_params.jerk_brake_max
                            if body.driver_params
                            else None
                        ),
                    }.items()
                    if v is not None
                }
                or None
            ),
            driver_zones=(
                [z.model_dump() for z in body.driver_zones]
                if body.driver_zones
                else None
            ),
            tls_override=body.tls_override,
            enable_markov=body.enable_markov,
        )
    except SimulationCapacityError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc

    # IDM: wait off the event loop so /health and other clients stay responsive,
    # while preserving the historical contract that /start returns completed.
    if record.engine == "idm":
        await wait_idm_done(record)

    ws_path = WS_PATH_TEMPLATE.format(simulation_id=record.simulation_id)
    return SimulateStartResponse(
        simulation_id=record.simulation_id,
        engine=record.engine,
        ws_path=ws_path,
        ws_token=record.ws_token,
        status=record.status,
    )


@router.websocket("/simulate/ws/{simulation_id}")
async def simulate_ws(websocket: WebSocket, simulation_id: str) -> None:
    """Stream ``SimulationFrame`` JSON messages until the run ends.

    Mounted under the ``/api`` router prefix → full path
    ``/api/simulate/ws/{id}?token=<ws_token>``
    (matches ``SimulateStartResponse.ws_path`` + ``ws_token``).
    """
    record = get_simulation(simulation_id)
    if record is None:
        await websocket.close(code=4404)
        return

    token = websocket.query_params.get("token") or ""
    if (
        not token
        or len(token) != len(record.ws_token)
        or not secrets.compare_digest(token, record.ws_token)
    ):
        await websocket.close(code=4401)
        return

    await websocket.accept()

    async def send_json(payload: dict) -> None:
        await websocket.send_json(payload)

    try:
        await replay_frames_ws(record, send_json)
        await websocket.send_json({"event": "end", "status": record.status})
    except WebSocketDisconnect:
        logger.debug("WS client disconnected from %s", simulation_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("WS error on %s: %s", simulation_id, exc)
        try:
            await websocket.close(code=1011)
        except Exception:  # noqa: BLE001
            pass


@router.post("/simulate/{simulation_id}/stop", response_model=SimulateStopResponse)
async def simulate_stop(simulation_id: str) -> SimulateStopResponse:
    """Stop a running simulation and return a consolidated profile (partial OK)."""
    record = get_simulation(simulation_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown simulation_id")

    stopped = request_stop(simulation_id)
    assert stopped is not None
    profile = stopped.profile
    if profile is None:
        profile = stopped.finalize(status="stopped")

    return SimulateStopResponse(
        simulation_id=simulation_id,
        profile=profile,
    )
