"""Unit tests for spatial corridor construction (stdlib unittest)."""

from __future__ import annotations

import math
import unittest

from app.models.schemas import (
    LatLon,
    RouteAnalyzeResponse,
    TrafficSignalPoint,
)
from app.services.spatial_processor import (
    align_speeds_to_points,
    build_slope_profile,
    build_slope_trapezoids,
    build_spatial_corridor,
    cumulative_distance_m,
    haversine_m,
    local_slope_rad,
    project_signals_onto_route,
    slope_from_elevation_trapezoids,
)


def _route(
    *,
    n: int = 8,
    with_zero_seg: bool = True,
    with_signals: bool = True,
    speeds: list[float] | None = None,
) -> RouteAnalyzeResponse:
    geometry = [LatLon(lat=48.85 + i * 0.0005, lon=2.35) for i in range(n)]
    if with_zero_seg and n >= 4:
        geometry[3] = LatLon(lat=geometry[2].lat, lon=geometry[2].lon)

    dists = [
        haversine_m(
            geometry[i].lat,
            geometry[i].lon,
            geometry[i + 1].lat,
            geometry[i + 1].lon,
        )
        for i in range(n - 1)
    ]
    elev = [10.0 + 2.0 * i for i in range(n)]
    if speeds is None:
        speeds = [13.89] * (n // 2) + [8.33] * (n - 1 - n // 2)

    signals: list[TrafficSignalPoint] = []
    if with_signals and n >= 5:
        signals = [
            TrafficSignalPoint(lat=geometry[2].lat + 0.00001, lon=2.35001, osm_id=1),
            TrafficSignalPoint(lat=geometry[2].lat + 0.00002, lon=2.35002, osm_id=2),
            TrafficSignalPoint(lat=geometry[-2].lat, lon=2.35, osm_id=3),
        ]

    return RouteAnalyzeResponse(
        geometry=geometry,
        distance_m=sum(dists),
        duration_s=120.0,
        segment_speeds_mps=speeds,
        segment_distances_m=dists,
        elevations_m=elev,
        traffic_signals=signals,
        bbox=(48.85, 2.35, 48.86, 2.36),
    )


class TestSpatialProcessor(unittest.TestCase):
    def test_haversine_known_scale(self) -> None:
        d = haversine_m(48.85, 2.35, 48.851, 2.35)
        self.assertGreater(d, 100.0)
        self.assertLess(d, 120.0)

    def test_cumulative_prefers_segments_and_handles_zero(self) -> None:
        route = _route(with_zero_seg=True)
        S = cumulative_distance_m(route.geometry, route.segment_distances_m)
        self.assertEqual(S[0], 0.0)
        self.assertEqual(len(S), len(route.geometry))
        self.assertTrue(any(abs(S[i] - S[i - 1]) < 1e-9 for i in range(1, len(S))))
        self.assertAlmostEqual(S[-1], sum(route.segment_distances_m), places=5)

    def test_cumulative_falls_back_to_haversine(self) -> None:
        geometry = [
            LatLon(lat=0.0, lon=0.0),
            LatLon(lat=0.001, lon=0.0),
        ]
        S = cumulative_distance_m(geometry, segment_distances_m=[])
        self.assertEqual(S[0], 0.0)
        self.assertAlmostEqual(S[1], haversine_m(0.0, 0.0, 0.001, 0.0), places=5)

    def test_align_speeds_pads_last(self) -> None:
        self.assertEqual(
            align_speeds_to_points(4, [10.0, 20.0, 30.0]),
            [10.0, 20.0, 30.0, 30.0],
        )
        self.assertEqual(align_speeds_to_points(3, []), [0.0, 0.0, 0.0])

    def test_slope_short_route_no_crash(self) -> None:
        S = [0.0, 10.0, 20.0]
        elev = [0.0, 1.0, 2.0]
        alpha = local_slope_rad(elev, S, smooth_window=11, smooth_polyorder=3)
        self.assertEqual(len(alpha), 3)
        self.assertTrue(all(math.isfinite(a) for a in alpha))

    def test_empty_signals(self) -> None:
        route = _route(with_signals=False)
        corridor = build_spatial_corridor(route)
        self.assertEqual(corridor.S_feux, [])
        self.assertTrue(all(e.kind != "traffic_signal" for e in corridor.events))

    def test_signal_dedup_and_events(self) -> None:
        route = _route()
        corridor = build_spatial_corridor(route, smooth_window=5, smooth_polyorder=2)
        self.assertEqual(len(corridor.S), len(route.geometry))
        self.assertEqual(len(corridor.V_limite), len(route.geometry))
        self.assertEqual(len(corridor.alpha), len(route.geometry))
        self.assertEqual(len(corridor.S_feux), 2)
        kinds = {e.kind for e in corridor.events}
        self.assertIn("traffic_signal", kinds)
        self.assertIn("speed_limit", kinds)

    def test_project_empty_geometry(self) -> None:
        self.assertEqual(project_signals_onto_route([], [], []), [])

    def test_full_corridor_empty_geometry(self) -> None:
        empty = RouteAnalyzeResponse(
            geometry=[],
            distance_m=0.0,
            duration_s=0.0,
            segment_speeds_mps=[],
            segment_distances_m=[],
            elevations_m=[],
            traffic_signals=[],
            bbox=(0.0, 0.0, 0.0, 0.0),
        )
        corridor = build_spatial_corridor(empty)
        self.assertEqual(corridor.S, [])
        self.assertEqual(corridor.events, [])


class TestTrapezoidSlope(unittest.TestCase):
    def test_constant_grade_alpha_and_pct(self) -> None:
        # Uniform samples every 10 m over 500 m, grade dz/ds = 0.05 → 5%
        S = [float(i * 10) for i in range(51)]
        elev = [0.05 * s for s in S]
        alpha, traps = slope_from_elevation_trapezoids(
            elev,
            S,
            trap_length_m=50.0,
            smooth_window=5,
            smooth_polyorder=2,
            sg_min_span_m=5.0,
        )
        expected = math.atan(0.05)
        self.assertEqual(len(alpha), len(S))
        self.assertTrue(all(abs(a - expected) < 1e-6 for a in alpha))
        self.assertTrue(traps)
        self.assertTrue(all(abs(t.slope_pct - 5.0) < 1e-6 for t in traps))
        profile = build_slope_profile(traps, elev, S, 50.0)
        self.assertTrue(profile.km_segments)
        self.assertAlmostEqual(profile.km_segments[0].mean_pct, 5.0, places=5)

    def test_trap_count_approx_total_over_L(self) -> None:
        total_m = 1000.0
        L = 50.0
        S = [float(i) for i in range(int(total_m) + 1)]
        elev = [0.0] * len(S)
        traps = build_slope_trapezoids(elev, S, L)
        expected = int(math.ceil(total_m / L))
        self.assertEqual(len(traps), expected)
        self.assertAlmostEqual(traps[0].s1_m - traps[0].s0_m, L, places=5)
        self.assertAlmostEqual(traps[-1].s1_m, total_m, places=5)

    def test_slope_profile_km_segments_present(self) -> None:
        S = [float(i * 5) for i in range(401)]  # 2000 m
        elev = [0.02 * s for s in S]
        traps = build_slope_trapezoids(elev, S, 50.0)
        profile = build_slope_profile(traps, elev, S, 50.0)
        self.assertEqual(profile.trap_length_m, 50.0)
        self.assertGreaterEqual(len(profile.km_segments), 2)
        for seg in profile.km_segments:
            self.assertGreaterEqual(len(seg.traps), 1)
            self.assertAlmostEqual(seg.mean_pct, 2.0, places=4)

    def test_spatial_z_kills_dem_sawtooth(self) -> None:
        """High-freq DEM noise must not survive as slope spikes (RN90 signature)."""
        from app.services.spatial_processor import smooth_elevation_spatial

        S = [float(i * 5) for i in range(201)]  # 1 km @ 5 m
        # True gentle valley grade ≈ −0.8 %, plus ±0.4 m DEM chatter
        elev = []
        for i, s in enumerate(S):
            z = 800.0 - 0.008 * s
            z += 0.4 if i % 2 == 0 else -0.4
            elev.append(z)
        # Raw step slope oscillates wildly
        raw_pct = []
        for i in range(1, len(S)):
            ds = S[i] - S[i - 1]
            raw_pct.append(100.0 * (elev[i] - elev[i - 1]) / ds)
        self.assertGreater(max(abs(p) for p in raw_pct), 5.0)

        z_s = smooth_elevation_spatial(S, elev, window_m=150.0)
        alpha, _traps = slope_from_elevation_trapezoids(
            z_s,
            S,
            trap_length_m=50.0,
            smooth_window=0,
            smooth_polyorder=2,
            sg_min_span_m=0.0,
        )
        pct = [100.0 * math.tan(a) for a in alpha]
        mean_pct = sum(pct) / len(pct)
        self.assertAlmostEqual(mean_pct, -0.8, delta=0.25)
        self.assertLess(max(abs(p - mean_pct) for p in pct), 1.5)

    def test_build_spatial_corridor_with_trap_length(self) -> None:
        # ~111 m / 0.001° lat → 20 points ≈ 2.1 km
        n = 20
        geometry = [LatLon(lat=48.85 + i * 0.001, lon=2.35) for i in range(n)]
        dists = [
            haversine_m(
                geometry[i].lat,
                geometry[i].lon,
                geometry[i + 1].lat,
                geometry[i + 1].lon,
            )
            for i in range(n - 1)
        ]
        S_preview = [0.0]
        for d in dists:
            S_preview.append(S_preview[-1] + d)
        elev = [0.05 * s for s in S_preview]
        route = RouteAnalyzeResponse(
            geometry=geometry,
            distance_m=sum(dists),
            duration_s=300.0,
            segment_speeds_mps=[13.89] * (n - 1),
            segment_distances_m=dists,
            elevations_m=elev,
            traffic_signals=[],
            bbox=(48.85, 2.35, 48.87, 2.36),
        )
        corridor = build_spatial_corridor(
            route,
            trap_length_m=50.0,
            smooth_window=5,
            smooth_polyorder=2,
            sg_min_span_m=10.0,
            max_grade=0.20,
        )
        self.assertEqual(len(corridor.alpha), n)
        self.assertIsNotNone(corridor.slope_profile)
        assert corridor.slope_profile is not None
        self.assertEqual(corridor.slope_profile.trap_length_m, 50.0)
        self.assertGreaterEqual(len(corridor.slope_profile.km_segments), 1)
        expected = math.atan(0.05)
        for a in corridor.alpha:
            self.assertAlmostEqual(a, expected, places=3)


if __name__ == "__main__":
    unittest.main()
