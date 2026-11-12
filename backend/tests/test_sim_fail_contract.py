"""Failed IDM must expose status=failed with empty profile (no fake 1-pt OK)."""

from __future__ import annotations

import unittest
from unittest import mock

from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import DriverProfile, LatLon, SpatialCorridor
from app.services.simulation_manager import (
    SIM_STORE,
    SimulationRecord,
    _run_idm,
    create_simulation,
)


def _corridor(n: int = 8) -> SpatialCorridor:
    S = [float(i) * 10.0 for i in range(n)]
    V = [20.0] * n
    return SpatialCorridor(
        S=S,
        V_limite=V,
        V_envelope=V,
        alpha=[0.0] * n,
        S_feux=[],
        events=[],
        geometry=[LatLon(lat=45.0, lon=6.0 + i * 0.0001) for i in range(n)],
    )


class TestSimFailContract(unittest.TestCase):
    def setUp(self) -> None:
        self._sim_ids: list[str] = []

    def tearDown(self) -> None:
        for sid in self._sim_ids:
            SIM_STORE.discard(sid)

    def test_finalize_failed_empty_frames(self) -> None:
        rec = SimulationRecord(
            simulation_id="t-fail",
            corridor=_corridor(),
            driver_profile=DriverProfile.NORMAL,
            engine="idm",
            seed=1,
        )
        profile = rec.finalize(status="failed")
        self.assertEqual(rec.status, "failed")
        self.assertEqual(profile.status, "failed")
        self.assertEqual(len(profile.time), 0)
        self.assertEqual(len(profile.velocity), 0)
        self.assertEqual(len(profile.acceleration), 0)

    def test_run_idm_exception_leaves_empty_failed_profile(self) -> None:
        rec = SimulationRecord(
            simulation_id="t-idm-boom",
            corridor=_corridor(),
            driver_profile=DriverProfile.NORMAL,
            engine="idm",
            seed=1,
        )
        with mock.patch(
            "app.services.simulation_manager.IDMSolver",
            side_effect=RuntimeError("idm boom"),
        ):
            _run_idm(rec)
        self.assertEqual(rec.status, "failed")
        self.assertIsNotNone(rec.profile)
        assert rec.profile is not None
        self.assertEqual(rec.profile.status, "failed")
        self.assertEqual(len(rec.profile.time), 0)
        self.assertEqual(rec.frames, [])

    def test_start_returns_failed_status_on_idm_error(self) -> None:
        client = TestClient(app)
        payload = {
            "corridor": _corridor().model_dump(mode="json"),
            "driver_profile": "Normal",
            "engine": "idm",
            "tls_cycle_s": 75.0,
            "tls_green_s": 40.0,
        }
        with mock.patch(
            "app.services.simulation_manager.IDMSolver",
            side_effect=RuntimeError("idm boom"),
        ):
            r = client.post("/api/simulate/start", json=payload)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body.get("status"), "failed")
        sim_id = body["simulation_id"]
        self._sim_ids.append(sim_id)
        token = body["ws_token"]
        stop = client.post(f"/api/simulate/{sim_id}/stop", params={"token": token})
        self.assertEqual(stop.status_code, 200)
        profile = stop.json()["profile"]
        self.assertEqual(profile["status"], "failed")
        self.assertEqual(len(profile["time"]), 0)

    def test_create_simulation_forwards_tls_timing(self) -> None:
        captured: dict = {}

        class _FakeSolver:
            def __init__(self, *args, **kwargs) -> None:
                captured.update(kwargs)

            def generate_frames(self):
                return []

            last_safety: dict = {}

        with mock.patch(
            "app.services.simulation_manager.IDMSolver",
            side_effect=lambda *a, **k: _FakeSolver(*a, **k),
        ):
            rec = create_simulation(
                _corridor(),
                DriverProfile.NORMAL,
                engine="idm",
                tls_cycle_s=77.0,
                tls_green_s=33.0,
            )
            self._sim_ids.append(rec.simulation_id)
            if rec._worker is not None:
                rec._worker.join(timeout=5.0)
        self.assertEqual(captured.get("tls_cycle_s"), 77.0)
        self.assertEqual(captured.get("tls_green_s"), 33.0)


if __name__ == "__main__":
    unittest.main()
