"""Pydantic bounds on RouteAnalyzeResponse enrichment and profile arrays (E3)."""

from __future__ import annotations

import unittest

from pydantic import ValidationError

from app.models.schemas import (
    CycleGenWarning,
    LatLon,
    RouteAnalyzeResponse,
    TrafficSignalPoint,
    _MAX_CONNECTION_LOG,
    _MAX_PROFILE_POINTS,
    _MAX_ROUTE_ENRICHMENT,
    _MAX_ROUTE_WARNINGS,
)


def _minimal_route_payload(*, n_geom: int = 5) -> dict:
    geom = [LatLon(lat=45.0 + i * 0.001, lon=6.0).model_dump() for i in range(n_geom)]
    seg = max(n_geom - 1, 1)
    return {
        "geometry": geom,
        "distance_m": 1000.0,
        "duration_s": 120.0,
        "segment_speeds_mps": [13.0] * seg,
        "segment_distances_m": [200.0] * seg,
        "elevations_m": [100.0] * n_geom,
        "traffic_signals": [],
        "bbox": (45.0, 6.0, 45.1, 6.1),
    }


class TestRouteAnalyzeSchema(unittest.TestCase):
    def test_accepts_max_geometry_and_enrichment(self) -> None:
        payload = _minimal_route_payload(n_geom=3)
        payload["geometry"] = [
            LatLon(lat=45.0, lon=6.0).model_dump() for _ in range(_MAX_PROFILE_POINTS)
        ]
        payload["elevations_m"] = [0.0] * _MAX_PROFILE_POINTS
        payload["segment_speeds_mps"] = [10.0] * (_MAX_PROFILE_POINTS - 1)
        payload["segment_distances_m"] = [1.0] * (_MAX_PROFILE_POINTS - 1)
        payload["traffic_signals"] = [
            TrafficSignalPoint(lat=45.0, lon=6.0).model_dump()
            for _ in range(_MAX_ROUTE_ENRICHMENT)
        ]
        RouteAnalyzeResponse.model_validate(payload)

    def test_rejects_oversized_geometry(self) -> None:
        payload = _minimal_route_payload()
        payload["geometry"] = [
            LatLon(lat=45.0, lon=6.0).model_dump()
            for _ in range(_MAX_PROFILE_POINTS + 1)
        ]
        with self.assertRaises(ValidationError):
            RouteAnalyzeResponse.model_validate(payload)

    def test_rejects_too_many_traffic_signals(self) -> None:
        payload = _minimal_route_payload()
        payload["traffic_signals"] = [
            TrafficSignalPoint(lat=45.0, lon=6.0).model_dump()
            for _ in range(_MAX_ROUTE_ENRICHMENT + 1)
        ]
        with self.assertRaises(ValidationError):
            RouteAnalyzeResponse.model_validate(payload)

    def test_rejects_too_many_osm_speed_limits(self) -> None:
        payload = _minimal_route_payload()
        payload["osm_speed_limits"] = [
            {
                "lat0": 45.0,
                "lon0": 6.0,
                "lat1": 45.01,
                "lon1": 6.01,
                "maxspeed_kmh": 50.0,
            }
            for _ in range(_MAX_ROUTE_ENRICHMENT + 1)
        ]
        with self.assertRaises(ValidationError):
            RouteAnalyzeResponse.model_validate(payload)

    def test_rejects_too_many_warnings(self) -> None:
        payload = _minimal_route_payload()
        payload["warnings"] = [
            CycleGenWarning(code="x", message="m").model_dump()
            for _ in range(_MAX_ROUTE_WARNINGS + 1)
        ]
        with self.assertRaises(ValidationError):
            RouteAnalyzeResponse.model_validate(payload)

    def test_rejects_too_many_connection_log_entries(self) -> None:
        payload = _minimal_route_payload()
        payload["connection_log"] = [{"provider": "osrm"}] * (_MAX_CONNECTION_LOG + 1)
        with self.assertRaises(ValidationError):
            RouteAnalyzeResponse.model_validate(payload)

    def test_rejects_elevation_geometry_mismatch(self) -> None:
        payload = _minimal_route_payload(n_geom=5)
        payload["elevations_m"] = [1.0] * 3
        with self.assertRaises(ValidationError):
            RouteAnalyzeResponse.model_validate(payload)

    def test_rejects_oversized_segment_speeds(self) -> None:
        payload = _minimal_route_payload(n_geom=10)
        payload["segment_speeds_mps"] = [1.0] * (_MAX_PROFILE_POINTS + 1)
        with self.assertRaises(ValidationError):
            RouteAnalyzeResponse.model_validate(payload)


if __name__ == "__main__":
    unittest.main()
