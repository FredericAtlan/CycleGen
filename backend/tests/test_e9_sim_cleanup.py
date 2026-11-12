"""E9 — simulate stop auth, SUMO workdir cleanup, N90 calibration retention."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

from app.models.schemas import DriverProfile, LatLon, SpatialCorridor
from app.services.n90_calibrator import _retain_latest_stamped_calibration
from app.services.simulation_manager import (
    SIM_STORE,
    SimulationRecord,
    _cleanup_sumo_workdir,
    request_stop,
)


def _tiny_corridor(n: int = 5) -> SpatialCorridor:
    S = [float(i) * 10.0 for i in range(n)]
    return SpatialCorridor(
        S=S,
        V_limite=[15.0] * n,
        alpha=[0.0] * n,
        S_feux=[],
        events=[],
        geometry=[LatLon(lat=0.0, lon=i * 0.0001) for i in range(n)],
    )


class TestSimStopToken(unittest.TestCase):
    def setUp(self) -> None:
        from app.main import app

        self.client = TestClient(app)
        self.record = SimulationRecord(
            simulation_id="e9-stop-token",
            corridor=_tiny_corridor(),
            driver_profile=DriverProfile.NORMAL,
            engine="idm",
            seed=1,
            status="completed",
        )
        self.record.finalize(status="completed")
        SIM_STORE.put(self.record.simulation_id, self.record)

    def tearDown(self) -> None:
        SIM_STORE.discard(self.record.simulation_id)

    def test_stop_rejects_missing_token(self) -> None:
        r = self.client.post(f"/api/simulate/{self.record.simulation_id}/stop")
        self.assertEqual(r.status_code, 401)

    def test_stop_rejects_wrong_token(self) -> None:
        r = self.client.post(
            f"/api/simulate/{self.record.simulation_id}/stop?token=not-the-secret"
        )
        self.assertEqual(r.status_code, 401)

    def test_stop_accepts_ws_token(self) -> None:
        r = self.client.post(
            f"/api/simulate/{self.record.simulation_id}/stop"
            f"?token={self.record.ws_token}"
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["simulation_id"], self.record.simulation_id)


class TestSumoWorkdirCleanup(unittest.TestCase):
    def test_cleanup_removes_tracked_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp) / "sim123"
            work.mkdir()
            (work / "net.xml").write_text("<net/>", encoding="utf-8")
            rec = SimulationRecord(
                simulation_id="sim123",
                corridor=_tiny_corridor(3),
                driver_profile=DriverProfile.NORMAL,
                engine="sumo",
                seed=0,
                sumo_work_dir=work,
            )
            _cleanup_sumo_workdir(rec)
            self.assertFalse(work.exists())
            self.assertIsNone(rec.sumo_work_dir)

    def test_request_stop_cleans_workdir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp) / "e9-stop-clean"
            work.mkdir()
            rec = SimulationRecord(
                simulation_id="e9-stop-clean",
                corridor=_tiny_corridor(3),
                driver_profile=DriverProfile.NORMAL,
                engine="sumo",
                seed=0,
                status="completed",
                sumo_work_dir=work,
            )
            rec.finalize(status="completed")
            SIM_STORE.put(rec.simulation_id, rec)
            try:
                request_stop(rec.simulation_id)
                self.assertFalse(work.exists())
            finally:
                SIM_STORE.discard(rec.simulation_id)

    def test_store_evict_cleans_workdir(self) -> None:
        from app.services.simulation_manager import SimulationEphemeralStore

        store: SimulationEphemeralStore = SimulationEphemeralStore(
            max_items=1,
            ttl_s=3600,
            name="e9-evict",
            prefer_evict=lambda r: r.status != "running",
        )
        with tempfile.TemporaryDirectory() as tmp:
            work_a = Path(tmp) / "a"
            work_b = Path(tmp) / "b"
            work_a.mkdir()
            work_b.mkdir()
            rec_a = SimulationRecord(
                simulation_id="a",
                corridor=_tiny_corridor(3),
                driver_profile=DriverProfile.NORMAL,
                engine="sumo",
                seed=0,
                status="completed",
                sumo_work_dir=work_a,
            )
            rec_b = SimulationRecord(
                simulation_id="b",
                corridor=_tiny_corridor(3),
                driver_profile=DriverProfile.NORMAL,
                engine="sumo",
                seed=0,
                status="completed",
                sumo_work_dir=work_b,
            )
            store.put("a", rec_a)
            store.put("b", rec_b)
            self.assertFalse(work_a.exists())
            store.discard("b")
            self.assertFalse(work_b.exists())


class TestN90CalibrationRetention(unittest.TestCase):
    def test_retain_only_latest_stamped_pairs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            for i in range(25):
                p = out / f"n90_2026010{i:02d}T120000Z.json"
                p.write_text("{}", encoding="utf-8")
                p.with_suffix(".md").write_text("# x", encoding="utf-8")
                os.utime(p, (i + 1, i + 1))
            (out / "latest_n90.json").write_text("{}", encoding="utf-8")
            _retain_latest_stamped_calibration(out, keep=20)
            stamped = sorted(out.glob("n90_*.json"))
            self.assertEqual(len(stamped), 20)
            self.assertTrue((out / "latest_n90.json").is_file())


if __name__ == "__main__":
    unittest.main()
