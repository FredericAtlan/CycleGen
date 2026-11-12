"""Tests for rs_compare + async fit job runner."""

from __future__ import annotations

import math
import time
import unittest

from pydantic import ValidationError

from app.api.routes_calibrate import RouteStudioCompareRequest, RouteStudioFitJobRequest
from app.models.schemas import LatLon, SpatialCorridor, _MAX_PROFILE_POINTS
from app.services.rs_compare import fidelity_score, score_profiles
from app.services.rs_jobs import (
    FitJob,
    FitJobQueueFullError,
    MAX_PENDING,
    _JOBS,
    _LOCK,
    _MAX_COMPLETED_JOBS,
    _prune_completed_cap,
    _prune_expired_jobs,
    get_fit_job,
    submit_fit_job,
)


def _corridor_with_n_points(n: int) -> SpatialCorridor:
    S = [float(i) * 5.0 for i in range(n)]
    V = [20.0] * n
    alpha = [0.0] * n
    geom = [LatLon(lat=45.0 + i * 1e-5, lon=6.0) for i in range(n)]
    return SpatialCorridor(
        S=S,
        V_limite=V,
        V_envelope=V,
        alpha=alpha,
        S_feux=[],
        events=[],
        geometry=geom,
    )


def _corridor_dump_with_n_points(n: int) -> dict:
    S = [float(i) * 5.0 for i in range(n)]
    V = [20.0] * n
    alpha = [0.0] * n
    geom = [LatLon(lat=45.0 + i * 1e-5, lon=6.0).model_dump() for i in range(n)]
    return {
        "S": S,
        "V_limite": V,
        "V_envelope": V,
        "alpha": alpha,
        "S_feux": [],
        "events": [],
        "geometry": geom,
    }


def _tiny_corridor() -> SpatialCorridor:
    return _corridor_with_n_points(80)


class TestRsJobs(unittest.TestCase):
    def test_route_studio_requests_reject_oversized_ref_series(self) -> None:
        n = _MAX_PROFILE_POINTS + 1
        with self.assertRaises(ValidationError):
            RouteStudioCompareRequest(
                t_ref=[0.0] * n,
                v_ref=[1.0] * n,
                t_cg=[0.0, 1.0, 2.0],
                v_cg=[1.0, 1.0, 1.0],
            )
        with self.assertRaises(ValidationError):
            RouteStudioFitJobRequest(t_ref=[0.0] * n, v_ref=[1.0] * n)

    def test_fit_job_request_rejects_oversized_corridor(self) -> None:
        n = _MAX_PROFILE_POINTS + 1
        with self.assertRaises(ValidationError):
            RouteStudioFitJobRequest.model_validate(
                {
                    "corridor": _corridor_dump_with_n_points(n),
                    "t_ref": [0.0, 1.0, 2.0],
                    "v_ref": [1.0, 1.0, 1.0],
                }
            )

    def test_submit_fit_job_rejects_oversized_corridor(self) -> None:
        with self.assertRaises(ValidationError):
            submit_fit_job(
                {
                    "corridor": _corridor_dump_with_n_points(_MAX_PROFILE_POINTS + 1),
                    "t_ref": [0.0, 1.0, 2.0],
                    "v_ref": [1.0, 1.0, 1.0],
                    "driver_profile": "Normal",
                    "driver_params": {},
                    "seed": 0,
                }
            )

    def test_ttl_prunes_completed_not_running(self) -> None:
        now = time.time()
        done_id = "rsfit-ttl-done"
        run_id = "rsfit-ttl-run"
        queued_id = "rsfit-ttl-queued"
        with _LOCK:
            _JOBS[done_id] = FitJob(
                task_id=done_id,
                status="completed",
                finished_at=now - 7200,
            )
            _JOBS[run_id] = FitJob(
                task_id=run_id,
                status="running",
                created_at=now - 7200,
                started_at=now - 7200,
            )
            _JOBS[queued_id] = FitJob(
                task_id=queued_id,
                status="queued",
                created_at=now - 7200,
            )
        try:
            _prune_expired_jobs(now=now)
            with _LOCK:
                self.assertNotIn(done_id, _JOBS)
                self.assertIn(run_id, _JOBS)
                self.assertIn(queued_id, _JOBS)
        finally:
            with _LOCK:
                for tid in (done_id, run_id, queued_id):
                    _JOBS.pop(tid, None)

    def test_completed_jobs_capped(self) -> None:
        now = time.time()
        ids: list[str] = []
        with _LOCK:
            for i in range(_MAX_COMPLETED_JOBS + 5):
                tid = f"rsfit-cap-{i}"
                ids.append(tid)
                _JOBS[tid] = FitJob(
                    task_id=tid,
                    status="completed",
                    finished_at=now - 1000 + i,
                )
            _prune_completed_cap()
            remaining = [
                k for k, j in _JOBS.items() if j.status == "completed"
            ]
            self.assertLessEqual(len(remaining), _MAX_COMPLETED_JOBS)
        with _LOCK:
            for tid in ids:
                _JOBS.pop(tid, None)

    def test_get_fit_job_prunes_expired(self) -> None:
        now = time.time()
        done_id = "rsfit-get-prune-done"
        with _LOCK:
            _JOBS[done_id] = FitJob(
                task_id=done_id,
                status="failed",
                finished_at=now - 7200,
            )
        try:
            self.assertIsNone(get_fit_job("rsfit-missing"))
            with _LOCK:
                self.assertNotIn(done_id, _JOBS)
        finally:
            with _LOCK:
                _JOBS.pop(done_id, None)

    def test_submit_fit_job_rejects_when_queue_full(self) -> None:
        fake_ids: list[str] = []
        with _LOCK:
            for i in range(MAX_PENDING):
                tid = f"rsfit-fake-{i}"
                fake_ids.append(tid)
                _JOBS[tid] = FitJob(task_id=tid, status="queued")
        try:
            with self.assertRaisesRegex(FitJobQueueFullError, "queue full"):
                submit_fit_job(
                    {
                        "corridor": _tiny_corridor().model_dump(),
                        "t_ref": [0.0, 1.0, 2.0],
                        "v_ref": [1.0, 1.0, 1.0],
                        "driver_profile": "Normal",
                        "driver_params": {},
                        "seed": 0,
                    }
                )
        finally:
            with _LOCK:
                for tid in fake_ids:
                    _JOBS.pop(tid, None)

    def test_fidelity_score_bounds(self) -> None:
        self.assertEqual(fidelity_score(0, 0, osc=0), 100.0)
        score = fidelity_score(50, 100, osc=5)
        self.assertGreaterEqual(score, 0)
        self.assertLessEqual(score, 100)

    def test_score_profiles_identical(self) -> None:
        t = [i * 0.5 for i in range(40)]
        v = [10.0 + 0.1 * i for i in range(40)]
        sc = score_profiles(t_ref=t, v_ref_mps=v, t_cg=t, v_cg_mps=v)
        self.assertLess(sc["rmse_v_kmh"], 0.05)
        self.assertGreaterEqual(sc["fidelity_score"], 95)

    def test_submit_fit_job_completes(self) -> None:
        corr = _tiny_corridor()
        t = [i * 0.5 for i in range(60)]
        v = [12.0] * 60
        task_id = submit_fit_job(
            {
                "corridor": corr.model_dump(),
                "t_ref": t,
                "v_ref": v,
                "driver_profile": "Normal",
                "driver_params": {
                    "a_max": 2.0,
                    "b_comf": 2.0,
                    "speed_factor": 1.0,
                    "pedal_tau_s": 0.0,
                    "vdes_tau_s": 0.0,
                    "descent_hold_gain": 0.0,
                },
                "seed": 0,
            }
        )
        self.assertTrue(task_id.startswith("rsfit-"))
        deadline = time.time() + 30
        job = get_fit_job(task_id)
        while job and job.status in ("queued", "running") and time.time() < deadline:
            time.sleep(0.2)
            job = get_fit_job(task_id)
        self.assertIsNotNone(job)
        assert job is not None
        self.assertEqual(job.status, "completed", job.error)
        self.assertTrue(job.result)
        self.assertGreaterEqual(job.result["best"]["compare"]["fidelity_score"], 0)
        self.assertTrue(
            math.isfinite(job.result["best"]["compare"]["rmse_v_kmh"])
        )


if __name__ == "__main__":
    unittest.main()
