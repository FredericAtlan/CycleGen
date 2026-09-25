"""P1 security guards: WS token, export size, SpatialCorridor, ephemeral store."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.models.schemas import (
    ConsolidatedProfile,
    DriverProfile,
    ExportRequest,
    LatLon,
    SpatialCorridor,
)
from app.services.ephemeral_store import EphemeralStore
from app.services.simulation_manager import (
    SIM_STORE,
    SimulationRecord,
)


def _tiny_corridor(n: int = 5) -> SpatialCorridor:
    S = [float(i) * 10.0 for i in range(n)]
    V = [15.0] * n
    return SpatialCorridor(
        S=S,
        V_limite=V,
        alpha=[0.0] * n,
        S_feux=[],
        events=[],
        geometry=[LatLon(lat=0.0, lon=i * 0.0001) for i in range(n)],
    )


def _tiny_profile(n: int = 5) -> ConsolidatedProfile:
    return ConsolidatedProfile(
        time=[float(i) for i in range(n)],
        velocity=[10.0] * n,
        position=[float(i) for i in range(n)],
        acceleration=[0.0] * n,
        slope=[0.0] * n,
        total_duration_s=float(max(n - 1, 0)),
        average_speed_kmh=36.0,
        status="completed",
    )


class TestP1Security(unittest.TestCase):
    def test_spatial_corridor_mismatch(self) -> None:
        with self.assertRaises(ValidationError) as ctx:
            SpatialCorridor(
                S=[0.0, 10.0, 20.0],
                V_limite=[15.0, 15.0],  # len 2 != 3
                alpha=[0.0, 0.0, 0.0],
                S_feux=[],
                events=[],
                geometry=[
                    LatLon(lat=0.0, lon=0.0),
                    LatLon(lat=0.0, lon=0.1),
                    LatLon(lat=0.0, lon=0.2),
                ],
            )
        msg = str(ctx.exception).lower()
        self.assertIn("v_limite", msg)

    def test_ephemeral_already_exists(self) -> None:
        """Updating an existing key succeeds even when the store is at capacity."""
        store: EphemeralStore[dict] = EphemeralStore(
            max_items=2,
            ttl_s=3600,
            name="p1",
            prefer_evict=lambda v: v.get("status") != "running",
        )
        self.assertTrue(store.try_put("a", {"status": "running"}))
        self.assertTrue(store.try_put("b", {"status": "running"}))
        # Key already exists — must not require a free slot.
        self.assertTrue(store.try_put("a", {"status": "running", "n": 2}))
        self.assertEqual(store.get("a"), {"status": "running", "n": 2})
        # New key while all hot → blocked.
        self.assertFalse(store.try_put("c", {"status": "running"}))

    def test_export_too_large(self) -> None:
        from app.main import app

        profile = _tiny_profile(20)
        body = ExportRequest(profile=profile, format="csv")
        with patch.dict(os.environ, {"CYCLEGEN_MAX_ROUTE_POINTS": "10"}):
            client = TestClient(app)
            resp = client.post("/api/export", json=body.model_dump())
        self.assertEqual(resp.status_code, 400)
        self.assertIn("too large", resp.json()["detail"])

    def test_ws_token_reject(self) -> None:
        from app.main import app

        corridor = _tiny_corridor()
        record = SimulationRecord(
            simulation_id="p1wsreject",
            corridor=corridor,
            driver_profile=DriverProfile.NORMAL,
            engine="idm",
            seed=1,
            status="completed",
        )
        SIM_STORE.put(record.simulation_id, record)
        try:
            client = TestClient(app)
            with self.assertRaises(Exception):
                # Wrong / missing token → close 4401 before accept.
                with client.websocket_connect(
                    f"/api/simulate/ws/{record.simulation_id}"
                ) as ws:
                    ws.receive_json()
            with self.assertRaises(Exception):
                with client.websocket_connect(
                    f"/api/simulate/ws/{record.simulation_id}?token=wrong-token"
                ) as ws:
                    ws.receive_json()
        finally:
            SIM_STORE.discard(record.simulation_id)


if __name__ == "__main__":
    unittest.main()
