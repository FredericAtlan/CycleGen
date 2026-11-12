"""Corridor events / feux caps (≤500) — prevent SpatialCorridor ValidationError."""

from __future__ import annotations

import unittest

from app.models.schemas import (
    DetectedEvent,
    LatLon,
    RouteAnalyzeResponse,
    TrafficSignalPoint,
)
from app.services.spatial_processor import (
    MAX_CORRIDOR_EVENTS,
    MAX_CORRIDOR_LIGHTS,
    _cap_corridor_events,
    build_events,
    build_spatial_corridor,
    haversine_m,
)


class TestCorridorEventsCap(unittest.TestCase):
    def test_build_events_caps_dense_speed_limits(self) -> None:
        n = 800
        S = [float(i) * 10.0 for i in range(n)]
        V = [10.0 + (i % 2) * 5.0 for i in range(n)]
        events = build_events(S, V, S_feux=[], scheduled_stops=None)
        self.assertLessEqual(len(events), MAX_CORRIDOR_EVENTS)
        self.assertTrue(any(e.kind == "speed_limit" for e in events))

    def test_cap_prefers_signals_over_speed(self) -> None:
        events = [
            DetectedEvent(s_m=float(i), kind="speed_limit", label="x", value=10.0)
            for i in range(600)
        ] + [
            DetectedEvent(
                s_m=float(i) + 0.1, kind="traffic_signal", label="tls", value=None
            )
            for i in range(50)
        ]
        capped = _cap_corridor_events(events)
        self.assertLessEqual(len(capped), MAX_CORRIDOR_EVENTS)
        n_sig = sum(1 for e in capped if e.kind == "traffic_signal")
        self.assertEqual(n_sig, 50)

    def test_build_spatial_corridor_many_signals_ok(self) -> None:
        n = 40
        geometry = [LatLon(lat=48.85 + i * 0.0005, lon=2.35) for i in range(n)]
        dists = [
            haversine_m(
                geometry[i].lat,
                geometry[i].lon,
                geometry[i + 1].lat,
                geometry[i + 1].lon,
            )
            for i in range(n - 1)
        ]
        signals = [
            TrafficSignalPoint(
                lat=geometry[i % n].lat + 0.00001 * (k % 3),
                lon=geometry[i % n].lon,
            )
            for i in range(n)
            for k in range(20)
        ]
        route = RouteAnalyzeResponse(
            geometry=geometry,
            distance_m=sum(dists),
            duration_s=120.0,
            segment_speeds_mps=[12.0] * (n - 1),
            segment_distances_m=dists,
            elevations_m=[100.0] * n,
            traffic_signals=signals,
            bbox=(2.35, 48.85, 2.35, 48.87),
            warnings=[],
        )
        corridor = build_spatial_corridor(route, a_y_mps2=3.5)
        self.assertLessEqual(len(corridor.events), MAX_CORRIDOR_EVENTS)
        self.assertLessEqual(len(corridor.S_feux), MAX_CORRIDOR_LIGHTS)
        self.assertLessEqual(len(corridor.feux_meta), MAX_CORRIDOR_LIGHTS)


if __name__ == "__main__":
    unittest.main()
