"""P3 — Adaptive curvature radius + R_min = 15 m."""

from __future__ import annotations

import math
import unittest

from app.models.schemas import LatLon
from app.services.curvature import (
    MIN_R_M,
    curve_speed_limit_mps,
    curvature_radius_m,
    smooth_radius_adaptive,
    smooth_radius_local_ls,
)


def _circle_geometry(radius_m: float, n_points: int = 90) -> list[LatLon]:
    """Return a partial-arc polyline on a horizontal circle around (0,0)."""
    lat0 = 45.0
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 78_710.0  # ~cos(45°) · 111320
    out: list[LatLon] = []
    for i in range(n_points):
        theta = i / (n_points - 1) * math.pi  # half circle
        x = radius_m * math.cos(theta)
        y = radius_m * math.sin(theta)
        out.append(
            LatLon(
                lat=lat0 + y / m_per_deg_lat,
                lon=x / m_per_deg_lon,
            )
        )
    return out


class TestRAdaptive(unittest.TestCase):
    def test_r_min_15_m_floor(self) -> None:
        self.assertEqual(MIN_R_M, 15.0)

    def test_hairpin_20_m_survives_adaptive_smoother(self) -> None:
        geom = _circle_geometry(radius_m=20.0, n_points=90)
        R = curvature_radius_m(geom, adaptive=True, use_local_ls=True)
        # Middle vertex should measure ≈ 20 m (± tolerance from LS fit)
        mid = R[len(R) // 2]
        self.assertLess(mid, 45.0)
        self.assertGreater(mid, 15.0)

    def test_adaptive_median_is_at_least_as_sharp_as_fixed_window(self) -> None:
        # Same synthetic hairpin, compare adaptive vs fixed 150 m window.
        S = [i * 1.0 for i in range(200)]
        R = [200.0] * 200
        for k in range(80, 120):
            R[k] = 20.0
        from app.services.curvature import smooth_radius_spatial

        R_fixed = smooth_radius_spatial(S, R, window_m=150.0, method="median")
        R_adapt = smooth_radius_adaptive(S, R)
        # Adaptive is never larger than fixed at the hairpin centre.
        self.assertLessEqual(R_adapt[100], R_fixed[100] + 1e-6)

    def test_adaptive_preserves_flat_r(self) -> None:
        S = [i * 5.0 for i in range(50)]
        R = [120.0] * 50
        R_out = smooth_radius_adaptive(S, R)
        for v in R_out:
            self.assertAlmostEqual(v, 120.0, places=3)

    def test_local_ls_produces_smoother_kappa_than_median(self) -> None:
        # Median tends to plateau; LS smooths transitions.
        S = [i * 5.0 for i in range(41)]
        R = [80.0 if i < 20 else 30.0 for i in range(41)]
        R_ls = smooth_radius_local_ls(S, R, halfspan_m=40.0)
        kappa_diffs = [
            abs(1.0 / R_ls[i + 1] - 1.0 / R_ls[i])
            for i in range(len(R_ls) - 1)
        ]
        # No single Δκ jump greater than the raw step change
        raw_step = abs(1.0 / 30.0 - 1.0 / 80.0)
        self.assertLess(max(kappa_diffs), raw_step)

    def test_curve_speed_at_r_min_15_matches_avl(self) -> None:
        # v = √(a_y · R). With a_y=2.5, R=15 m → 6.12 m/s ≈ 22 km/h.
        v = curve_speed_limit_mps([15.0], a_y_mps2=2.5)[0]
        self.assertAlmostEqual(v, math.sqrt(2.5 * 15.0), places=3)
        self.assertLess(v * 3.6, 25.0)  # < 25 km/h


if __name__ == "__main__":
    unittest.main()
