"""Async Route Studio fit jobs — thin runner over rs_geometry_fit."""

from __future__ import annotations

import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from app.models.schemas import SpatialCorridor, assert_spatial_corridor_fit_cap
from app.services.rs_geometry_fit import run_geometry_lock_fit

_EXEC = ThreadPoolExecutor(max_workers=2, thread_name_prefix="rs-fit")
_LOCK = threading.Lock()
_JOBS: dict[str, "FitJob"] = {}
MAX_PENDING = 8
_MAX_COMPLETED_JOBS = 32
_JOB_TTL_S = 3600


class FitJobQueueFullError(Exception):
    """Raised when too many fit jobs are queued or running."""


class FitCorridorTooLargeError(ValueError):
    """Raised when corridor.S exceeds Route Studio fit point cap."""


def _pending_job_count() -> int:
    return sum(
        1 for j in _JOBS.values() if j.status in ("queued", "running")
    )


@dataclass
class FitJob:
    task_id: str
    status: str = "queued"  # queued | running | completed | failed
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    progress: float = 0.0
    message: str = ""
    error: str | None = None
    result: dict[str, Any] | None = None


def _run_fit(job: FitJob, payload: dict[str, Any]) -> None:
    job.status = "running"
    job.started_at = time.time()
    job.message = "fitting"
    try:
        corridor = SpatialCorridor.model_validate(payload["corridor"])

        def on_progress(p: float, msg: str) -> None:
            job.progress = p
            job.message = msg

        result = run_geometry_lock_fit(
            corridor=corridor,
            t_ref=[float(x) for x in payload["t_ref"]],
            v_ref=[float(x) for x in payload["v_ref"]],
            driver_profile=str(payload.get("driver_profile") or "Normal"),
            driver_params=dict(payload.get("driver_params") or {}),
            seed=int(payload.get("seed") or 0),
            on_progress=on_progress,
        )
        best = result["best"]
        job.result = result
        job.status = "completed"
        job.message = (
            f"best={best['variant']} RMSE={best['compare']['rmse_v_kmh']} "
            f"score={best['compare']['fidelity_score']}"
        )
        job.progress = 1.0
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
        job.message = "failed"
    finally:
        job.finished_at = time.time()
        with _LOCK:
            _prune_jobs()


def _prune_expired_jobs(now: float | None = None) -> None:
    """Drop finished jobs older than TTL; never remove queued or running."""
    cutoff = (now if now is not None else time.time()) - _JOB_TTL_S
    dead = [
        k
        for k, j in _JOBS.items()
        if j.status in ("completed", "failed")
        and j.finished_at is not None
        and j.finished_at < cutoff
    ]
    for k in dead:
        _JOBS.pop(k, None)


def _prune_completed_cap() -> None:
    """Keep at most _MAX_COMPLETED_JOBS completed entries (oldest dropped first)."""
    completed = [
        (k, j)
        for k, j in _JOBS.items()
        if j.status == "completed" and j.finished_at is not None
    ]
    overflow = len(completed) - _MAX_COMPLETED_JOBS
    if overflow <= 0:
        return
    completed.sort(key=lambda item: item[1].finished_at or 0.0)
    for k, _ in completed[:overflow]:
        _JOBS.pop(k, None)


def _prune_jobs(now: float | None = None) -> None:
    _prune_expired_jobs(now=now)
    _prune_completed_cap()


def submit_fit_job(payload: dict[str, Any]) -> str:
    corridor_raw = payload.get("corridor")
    if corridor_raw is not None:
        corridor = SpatialCorridor.model_validate(corridor_raw)
        try:
            assert_spatial_corridor_fit_cap(corridor)
        except ValueError as exc:
            raise FitCorridorTooLargeError(str(exc)) from exc

    task_id = f"rsfit-{secrets.token_hex(16)}"
    job = FitJob(task_id=task_id)
    with _LOCK:
        _prune_jobs()
        if _pending_job_count() >= MAX_PENDING:
            raise FitJobQueueFullError(
                f"Route Studio fit queue full ({MAX_PENDING} pending jobs); retry later"
            )
        _JOBS[task_id] = job
    _EXEC.submit(_run_fit, job, payload)
    return task_id


def get_fit_job(task_id: str) -> FitJob | None:
    with _LOCK:
        _prune_jobs()
        return _JOBS.get(task_id)


def job_to_dict(job: FitJob) -> dict[str, Any]:
    return {
        "task_id": job.task_id,
        "status": job.status,
        "progress": round(job.progress, 3),
        "message": job.message,
        "error": job.error,
        "created_at": job.created_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "result": job.result,
    }
