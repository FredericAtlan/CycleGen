"""Smoke tests for the N90 calibration grid."""

from __future__ import annotations

import math
import unittest
from pathlib import Path

from app.models.schemas import DriverProfile, LatLon, SpatialCorridor
from app.services.n90_calibrator import (
    DEFAULT_GRIDS,
    build_grid,
    run_n90_calibration,
)


def _tiny_corridor(length_m: float = 1000.0) -> SpatialCorridor:
    n = 21
    ds = length_m / (n - 1)
    S = [i * ds for i in range(n)]
    V = [15.0] * n  # ~54 km/h
    alpha = [math.atan(-0.02)] * n
    geometry = [LatLon(lat=0.0, lon=i * ds / 111_000.0) for i in range(n)]
    return SpatialCorridor(
        S=S,
        V_limite=V,
        V_envelope=V,
        S_feux=[],
        alpha=alpha,
        V_curve=[1e6] * n,
        geometry=geometry,
        feux_meta=[],
        events=[],
    )


class TestN90Calibrator(unittest.TestCase):
    def test_build_grid_respects_max_arms(self) -> None:
        arms = build_grid(
            a_max_grid=None,
            b_comf_grid=None,
            T_grid=None,
            T_h_grid=None,
            s0_grid=None,
            jerk_max_grid=None,
            jerk_brake_max_grid=None,
            speed_factor_grid=None,
            max_arms=12,
        )
        self.assertLessEqual(len(arms), 12)
        # Uniqueness
        ids = {a.id for a in arms}
        self.assertEqual(len(ids), len(arms))

    def test_build_grid_rejects_huge_product(self) -> None:
        """Product pre-check must fire before itertools.product materialises."""
        big = list(range(10))  # 10^5 = 100_000 > 50_000 hard cap
        with self.assertRaises(ValueError) as ctx:
            build_grid(
                a_max_grid=big,
                b_comf_grid=big,
                T_grid=big,
                T_h_grid=big,
                s0_grid=big,
                jerk_max_grid=[1.0],
                jerk_brake_max_grid=[1.0],
                speed_factor_grid=[1.0],
                max_arms=96,
            )
        self.assertIn("too large", str(ctx.exception).lower())

    def test_build_grid_caps_axis_length(self) -> None:
        oversized = list(range(40))
        arms = build_grid(
            a_max_grid=oversized,
            b_comf_grid=[2.0],
            T_grid=[1.5],
            T_h_grid=[4.0],
            s0_grid=[2.0],
            jerk_max_grid=[1.5],
            jerk_brake_max_grid=[3.0],
            speed_factor_grid=[1.0],
            max_arms=64,
        )
        # Axis capped at 32 → product 32, under max_arms*20.
        self.assertEqual(len(arms), 32)

    def test_build_grid_default_keys_are_valid(self) -> None:
        expected = {
            "a_max",
            "b_comf",
            "T",
            "T_h",
            "s0",
            "jerk_max",
            "jerk_brake_max",
            "speed_factor",
        }
        self.assertEqual(set(DEFAULT_GRIDS.keys()), expected)

    def test_run_calibration_short_grid(self) -> None:
        # 2×1×1×1×1×1×1×1 = 2 arms, fast enough for CI.
        corridor = _tiny_corridor()
        result = run_n90_calibration(
            corridor=corridor,
            corridor_id="test-corridor",
            reference_id="avl_n90_bcb",
            driver_profile=DriverProfile.NORMAL,
            seed=1,
            lambda_a=4.0,
            mu_dt=0.08,
            a_max_grid=[1.6, 2.4],
            b_comf_grid=[2.0],
            T_grid=[1.5],
            T_h_grid=[4.0],
            s0_grid=[2.0],
            jerk_max_grid=[1.5],
            jerk_brake_max_grid=[3.0],
            speed_factor_grid=[1.05],
            max_arms=4,
        )
        self.assertEqual(result["n_arms"], 2)
        self.assertIn("best_arm_id", result)
        self.assertTrue(Path(result["written_json"]).is_file())
        self.assertTrue(Path(result["written_markdown"]).is_file())
        # Best arm scores are ordered
        scores = [a.score for a in result["arms"]]
        self.assertEqual(scores, sorted(scores))


if __name__ == "__main__":
    unittest.main()
