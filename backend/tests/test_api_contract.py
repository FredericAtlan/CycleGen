"""Layer B — API contract tests (FastAPI TestClient, no external network).

Covers rejection / health paths that guard DoS and empty payloads.
Does not call geocoding, routers, or elevation providers.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from fastapi.testclient import TestClient

from app.main import app


def _minimal_route(*, geometry: list, distance_m: float = 1000.0) -> dict:
    n = max(len(geometry), 1)
    return {
        "geometry": geometry,
        "distance_m": distance_m,
        "duration_s": 60.0,
        "segment_speeds_mps": [10.0] * max(n - 1, 1),
        "segment_distances_m": [distance_m / max(n - 1, 1)] * max(n - 1, 1),
        "elevations_m": [100.0] * n,
        "traffic_signals": [],
        "bbox": [0.0, 0.0, 1.0, 1.0],
    }


def _minimal_corridor(*, S: list[float]) -> dict:
    n = len(S)
    zeros = [0.0] * n
    ones = [13.0] * n
    return {
        "S": S,
        "V_limite": ones,
        "V_limite_legal": ones,
        "V_traffic": ones,
        "V_curve": ones,
        "V_envelope": ones,
        "alpha": zeros,
        "elevations_m": zeros,
        "S_feux": [],
        "events": [],
        "geometry": [{"lat": 45.0, "lon": 5.0}] * n,
    }


def _minimal_profile(*, n: int = 3) -> dict:
    return {
        "time": [float(i) for i in range(n)],
        "velocity": [10.0] * n,
        "position": [float(i) * 10.0 for i in range(n)],
        "acceleration": [0.0] * n,
        "slope": [0.0] * n,
        "total_duration_s": float(max(n - 1, 0)),
        "average_speed_kmh": 36.0,
        "status": "completed",
    }


class TestApiContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)

    def test_health_ok(self) -> None:
        r = self.client.get("/health")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body.get("status"), "ok")
        self.assertEqual(body.get("service"), "cyclegen-api")

    def test_corridor_build_rejects_empty_geometry(self) -> None:
        payload = {"route": _minimal_route(geometry=[])}
        r = self.client.post("/api/corridor/build", json=payload)
        self.assertEqual(r.status_code, 400)
        self.assertIn("empty", str(r.json().get("detail", "")).lower())

    def test_corridor_build_rejects_oversize_points(self) -> None:
        with mock.patch.dict(os.environ, {"CYCLEGEN_MAX_ROUTE_POINTS": "3"}):
            geometry = [
                {"lat": 45.0 + i * 0.001, "lon": 5.0 + i * 0.001}
                for i in range(5)
            ]
            payload = {"route": _minimal_route(geometry=geometry, distance_m=500.0)}
            r = self.client.post("/api/corridor/build", json=payload)
        self.assertEqual(r.status_code, 400)
        detail = str(r.json().get("detail", "")).lower()
        self.assertTrue(
            "too large" in detail or "max" in detail,
            msg=detail,
        )

    def test_simulate_start_rejects_empty_S(self) -> None:
        payload = {
            "corridor": _minimal_corridor(S=[]),
            "driver_profile": "Normal",
            "engine": "idm",
        }
        r = self.client.post("/api/simulate/start", json=payload)
        self.assertEqual(r.status_code, 400)
        self.assertIn("empty", str(r.json().get("detail", "")).lower())

    def test_export_accepts_small_profile(self) -> None:
        """Happy-path export under the shared route-point cap."""
        payload = {"profile": _minimal_profile(n=5), "format": "csv"}
        r = self.client.post("/api/export", json=payload)
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r.headers.get("content-type", ""))

    def test_export_rejects_oversize_profile(self) -> None:
        """POST /api/export rejects profiles longer than CYCLEGEN_MAX_ROUTE_POINTS."""
        with mock.patch.dict(os.environ, {"CYCLEGEN_MAX_ROUTE_POINTS": "3"}):
            payload = {"profile": _minimal_profile(n=8), "format": "csv"}
            r = self.client.post("/api/export", json=payload)
        self.assertEqual(r.status_code, 400)
        detail = str(r.json().get("detail", "")).lower()
        self.assertTrue(
            "too large" in detail or "max" in detail or "oversiz" in detail,
            msg=detail,
        )


if __name__ == "__main__":
    unittest.main()
