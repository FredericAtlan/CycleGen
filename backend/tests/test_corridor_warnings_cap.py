"""Corridor warnings cap (≤500) and signal far-warning spam limit."""

from __future__ import annotations

import unittest

from app.models.schemas import (
    CycleGenWarning,
    LatLon,
    RouteAnalyzeResponse,
    TrafficSignalPoint,
    _MAX_ROUTE_WARNINGS,
)
from app.services.spatial_processor import (
    MAX_CORRIDOR_WARNINGS,
    MAX_SIGNAL_FAR_WARNINGS,
    build_spatial_corridor,
    cumulative_distance_m,
    haversine_m,
    project_signals_strict,
)


def _line_route(n: int = 20) -> tuple[list[LatLon], list[float]]:
    geometry = [LatLon(lat=48.85 + i * 0.0002, lon=2.35) for i in range(n)]
    S = cumulative_distance_m(geometry)
    return geometry, S


class TestCorridorWarningsCap(unittest.TestCase):
    def test_build_spatial_corridor_caps_warnings_at_500(self) -> None:
        n = 12
        geometry = [LatLon(lat=48.85 + i * 0.0003, lon=2.35) for i in range(n)]
        dists = [
            haversine_m(
                geometry[i].lat,
                geometry[i].lon,
                geometry[i + 1].lat,
                geometry[i + 1].lon,
            )
            for i in range(n - 1)
        ]
        flood = [
            CycleGenWarning(code=f"w{i}", message=f"noise {i}", source="test")
            for i in range(_MAX_ROUTE_WARNINGS + 80)
        ]
        # RouteAnalyzeResponse itself caps at 500 — inject via model_construct.
        route = RouteAnalyzeResponse.model_construct(
            geometry=geometry,
            distance_m=sum(dists),
            duration_s=60.0,
            segment_speeds_mps=[13.9] * (n - 1),
            segment_distances_m=dists,
            elevations_m=[10.0] * n,
            traffic_signals=[],
            bbox=(48.85, 2.35, 48.86, 2.36),
            warnings=flood,
        )
        corridor = build_spatial_corridor(route)
        self.assertEqual(len(corridor.warnings), MAX_CORRIDOR_WARNINGS)
        self.assertEqual(corridor.warnings[-1].code, "warnings_truncated")
        self.assertIn("dropped", corridor.warnings[-1].message.lower())
        # Pydantic contract: still within SpatialCorridor max_length.
        SpatialCorridor = type(corridor)
        SpatialCorridor.model_validate(corridor.model_dump())

    def test_project_signals_strict_caps_far_warnings(self) -> None:
        geometry, S = _line_route(30)
        # Far lateral offsets (~100 m east) so every signal is rejected.
        far_lon = 2.35 + 0.002
        signals = [
            TrafficSignalPoint(
                lat=geometry[i % len(geometry)].lat,
                lon=far_lon,
                osm_id=i,
            )
            for i in range(MAX_SIGNAL_FAR_WARNINGS + 40)
        ]
        feux, warnings = project_signals_strict(geometry, S, signals)
        self.assertEqual(feux, [])
        far = [w for w in warnings if w.code == "signal_rejected_5m"]
        self.assertEqual(len(far), MAX_SIGNAL_FAR_WARNINGS)
        self.assertLessEqual(len(warnings), MAX_SIGNAL_FAR_WARNINGS)


if __name__ == "__main__":
    unittest.main()
