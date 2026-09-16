"""In-memory simulation state for Agent G (SUMO / IDM)."""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from app.models.schemas import (
    ConsolidatedProfile,
    DriverProfile,
    SimulationFrame,
    SpatialCorridor,
)
from app.services.kinematic_solver import IDMSolver, frames_to_profile
from app.services.sumo_bridge import (
    DEFAULT_WORK_DIR,
    SumoBridge,
    SumoNetworkError,
    SumoNotAvailableError,
)

logger = logging.getLogger(__name__)

EngineName = Literal["sumo", "idm"]
SimStatus = Literal["running", "completed", "stopped", "failed"]


@dataclass
class SimulationRecord:
    simulation_id: str
    corridor: SpatialCorridor
    driver_profile: DriverProfile
    engine: EngineName
    seed: int | None
    max_speed_mps: float | None = None
    param_overrides: dict[str, float] | None = None
    driver_zones: list[dict[str, Any]] | None = None
    tls_override: str = "auto"
    enable_markov: bool = False
    status: SimStatus = "running"
    frames: list[SimulationFrame] = field(default_factory=list)
    profile: ConsolidatedProfile | None = None
    error: str | None = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _worker: threading.Thread | None = field(default=None, repr=False)

    def append_frame(self, frame: SimulationFrame | dict[str, Any]) -> None:
        if isinstance(frame, dict):
            frame = SimulationFrame(
                t=float(frame.get("t", 0.0)),
                v=max(0.0, float(frame.get("v", 0.0))),
                a=float(frame.get("a", 0.0)),
                s=float(frame.get("s", 0.0)),
                alpha=float(frame.get("alpha", 0.0)),
                density=float(frame.get("density", 0.0)),
                vehicles=frame.get("vehicles") or [],
                tls_state=frame.get("tls_state"),
            )
        with self._lock:
            self.frames.append(frame)

    def snapshot_frames(self) -> list[SimulationFrame]:
        with self._lock:
            return list(self.frames)

    def finalize(self, status: SimStatus = "stopped") -> ConsolidatedProfile:
        with self._lock:
            if self.profile is not None and status == "stopped" and self.status in (
                "completed",
                "stopped",
            ):
                # Prefer already-built completed profile; mark stopped if requested
                if self.profile.status != status:
                    self.profile = self.profile.model_copy(update={"status": status})
                self.status = status
                return self.profile
            frames = list(self.frames)
            profile = frames_to_profile(frames, status=status)
            profile = profile.model_copy(
                update={
                    "traffic_source": getattr(self.corridor, "traffic_source", None),
                    "warnings": list(getattr(self.corridor, "warnings", []) or []),
                }
            )
            self.profile = profile
            self.status = status
            return profile


# Global store — keyed by simulation_id
SIM_STORE: dict[str, SimulationRecord] = {}


def get_simulation(simulation_id: str) -> SimulationRecord | None:
    return SIM_STORE.get(simulation_id)


def create_simulation(
    corridor: SpatialCorridor,
    driver_profile: DriverProfile,
    *,
    engine: EngineName = "sumo",
    seed: int | None = None,
    max_speed_mps: float | None = None,
    param_overrides: dict[str, float] | None = None,
    driver_zones: list[dict[str, Any]] | None = None,
    tls_override: str = "auto",
    enable_markov: bool = False,
) -> SimulationRecord:
    """Choose engine (SUMO if available unless forced idm), spawn worker, store record."""
    chosen: EngineName = "idm"
    if engine != "idm" and SumoBridge.available():
        chosen = "sumo"
    elif engine == "sumo" and not SumoBridge.available():
        logger.info("SUMO unavailable — forcing IDM for new simulation")
        chosen = "idm"

    sim_id = uuid.uuid4().hex
    record = SimulationRecord(
        simulation_id=sim_id,
        corridor=corridor,
        driver_profile=driver_profile,
        engine=chosen,
        seed=seed,
        max_speed_mps=max_speed_mps,
        param_overrides=param_overrides,
        driver_zones=driver_zones,
        tls_override=tls_override or "auto",
        enable_markov=bool(enable_markov),
    )
    SIM_STORE[sim_id] = record

    if chosen == "idm":
        _run_idm(record)
    else:
        worker = threading.Thread(
            target=_run_sumo_worker,
            args=(record,),
            name=f"sumo-{sim_id[:8]}",
            daemon=True,
        )
        record._worker = worker
        worker.start()

    return record


def request_stop(simulation_id: str) -> SimulationRecord | None:
    record = SIM_STORE.get(simulation_id)
    if record is None:
        return None
    record.stop_event.set()
    if record._worker is not None and record._worker.is_alive():
        record._worker.join(timeout=5.0)
    # If still running (IDM precomputed or SUMO finished), finalize
    if record.status == "running":
        record.finalize(status="stopped")
    elif record.profile is None:
        record.finalize(status="stopped")
    else:
        record.status = "stopped"
        record.profile = record.profile.model_copy(update={"status": "stopped"})
    return record


def _run_idm(record: SimulationRecord) -> None:
    try:
        solver = IDMSolver(
            record.corridor,
            record.driver_profile,
            seed=record.seed,
            max_speed_mps=record.max_speed_mps,
            param_overrides=record.param_overrides,
            driver_zones=record.driver_zones,
            tls_override=getattr(record, "tls_override", "auto") or "auto",
            enable_markov=bool(getattr(record, "enable_markov", False)),
        )
        frames = solver.generate_frames()
        with record._lock:
            record.frames = frames
            record.profile = frames_to_profile(
                frames, status="completed", safety=solver.last_safety
            )
            record.profile = record.profile.model_copy(
                update={
                    "traffic_source": getattr(record.corridor, "traffic_source", None),
                    "warnings": list(
                        getattr(record.corridor, "warnings", []) or []
                    ),
                }
            )
            record.status = "completed"
            record.engine = "idm"
    except Exception as exc:  # noqa: BLE001
        logger.exception("IDM solve failed: %s", exc)
        record.error = str(exc)
        record.finalize(status="failed")


def _run_sumo_worker(record: SimulationRecord) -> None:
    """Background SUMO stepping; falls back to IDM if prepare/start fails."""
    bridge = SumoBridge()
    work = Path(DEFAULT_WORK_DIR) / record.simulation_id
    try:
        bridge.prepare(
            record.corridor,
            record.driver_profile,
            work,
        )
        bridge.start_traci()
    except (SumoNotAvailableError, SumoNetworkError, OSError, RuntimeError) as exc:
        logger.warning(
            "SUMO start failed (%s) — switching simulation %s to IDM",
            exc,
            record.simulation_id,
        )
        record.error = f"sumo_fallback: {exc}"
        record.engine = "idm"
        _run_idm(record)
        return

    try:
        max_steps = 7200
        try:
            s_end = float((record.corridor.S or [0.0])[-1] or 0.0)
            # Allow ~3× freeflow at 8 m/s, with floor/ceiling for short/long trips
            max_steps = int(min(50_000, max(7200, (s_end / 8.0) * 3.0 + 600)))
        except Exception:  # noqa: BLE001
            pass
        for _ in range(max_steps):
            if record.stop_event.is_set():
                break
            bridge.step()
            snap = bridge.snapshot()
            record.append_frame(snap)
            if snap.get("ego_arrived"):
                break
        if record.stop_event.is_set():
            record.finalize(status="stopped")
        else:
            record.finalize(status="completed")
    except Exception as exc:  # noqa: BLE001
        logger.exception("SUMO mid-run failure: %s", exc)
        record.error = str(exc)
        # Keep partial frames; mark completed-ish so stop still returns a profile
        if record.frames:
            record.finalize(status="stopped")
        else:
            # Absolute failure with no frames — IDM rescue
            record.engine = "idm"
            _run_idm(record)
    finally:
        try:
            bridge.stop()
        except Exception:  # noqa: BLE001
            pass


async def replay_frames_ws(
    record: SimulationRecord,
    send_json,
    *,
    interval_s: float = 0.05,
) -> None:
    """Push frames to a WebSocket consumer (IDM replay or live catch-up).

    When the run is already finished (IDM precompute), stream in bursts with no
    per-frame sleep so long cycles are not truncated by client/proxy timeouts
    during a slow ~20 Hz replay (e.g. 6000 frames ≈ 5 min wall clock).
    """
    sent = 0
    while True:
        frames = record.snapshot_frames()
        finished = record.status != "running" or record.stop_event.is_set()
        # Burst when done; light pacing only while SUMO is still producing.
        pace = 0.0 if finished else interval_s
        while sent < len(frames):
            await send_json(frames[sent].model_dump())
            sent += 1
            if pace > 0:
                await asyncio.sleep(pace)
            elif sent % 64 == 0:
                # Yield so the event loop can flush the socket.
                await asyncio.sleep(0)
        if record.status != "running" and sent >= len(record.snapshot_frames()):
            break
        if record.stop_event.is_set() and sent >= len(record.snapshot_frames()):
            break
        await asyncio.sleep(0.05)
