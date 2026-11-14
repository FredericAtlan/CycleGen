"""Unit tests for curve speed smoothing and braking-feasible envelope."""

from __future__ import annotations

import math
import unittest

from app.models.schemas import LatLon
from app.services.curvature import (
    CURVE_ACTIVE_BELOW_MPS,
    MAX_ENVELOPE_GRADIENT_KMH_PER_M,
    NON_BINDING_V_MPS,
    R_SMOOTH_WINDOW_M,
    braking_feasible_speed,
    curve_speed_limit_mps,
    curvature_radius_m,
    envelope_max_gradient_kmh_per_m,
    smooth_envelope_spatial,
    smooth_radius_spatial,
    smooth_v_curve_spatial,
)


class TestVCurveSmooth(unittest.TestCase):
    def test_spatial_ma_softens_spike(self) -> None:
        S = [float(i * 10) for i in range(11)]  # 0..100 m
        V = [30.0] * 11
        V[5] = 10.0  # spike at 50 m
        out = smooth_v_curve_spatial(S, V, window_m=40.0)
        self.assertGreater(out[5], 10.0)
        self.assertLess(out[5], 30.0)

    def test_non_binding_preserved_on_straight(self) -> None:
        S = [0.0, 50.0, 100.0]
        V = [NON_BINDING_V_MPS] * 3
        out = smooth_v_curve_spatial(S, V, window_m=50.0)
        self.assertTrue(all(v >= CURVE_ACTIVE_BELOW_MPS for v in out))


class TestRadiusSpatialMedian(unittest.TestCase):
    def test_median_kills_phantom_hairpin(self) -> None:
        # Dense samples every 5 m — index SG would use ~100 m, but we use ±75 m.
        S = [float(i * 5) for i in range(61)]  # 0..300 m
        R = [500.0] * 61
        R[30] = 40.0  # single fake hairpin at 150 m
        out = smooth_radius_spatial(S, R, window_m=R_SMOOTH_WINDOW_M, method="median")
        self.assertGreater(out[30], 200.0)
        self.assertAlmostEqual(out[30], 500.0, delta=1.0)

    def test_curvature_radius_uses_spatial_not_index(self) -> None:
        # Nearly straight northbound with one kink (digitization)
        geometry: list[LatLon] = []
        for i in range(40):
            lat = 45.0 + i * 0.00008  # ~9 m steps
            lon = 6.0
            if i == 20:
                lon = 6.0 + 0.00015  # lateral kink → tiny circumradius
            geometry.append(LatLon(lat=lat, lon=lon))
        R = curvature_radius_m(geometry, smooth_window_m=150.0)
        # After spatial median, the kink must not dominate as a hairpin.
        self.assertGreater(min(R), 40.0)
        self.assertGreater(R[20], 80.0)


class TestEnvelopeContinuity(unittest.TestCase):
    def test_gradient_below_2_kmh_per_m(self) -> None:
        # Uneven spacing + stair-step legal + phantom curve dip
        S = [0.0]
        while S[-1] < 400.0:
            S.append(S[-1] + (3.0 if len(S) % 3 else 12.0))
        n = len(S)
        V_legal = [110.0 / 3.6] * n
        for i, s in enumerate(S):
            if 80.0 <= s <= 120.0:
                V_legal[i] = 50.0 / 3.6
        R = [800.0] * n
        # Inject fake hairpins every ~20 m on a straight
        for i, s in enumerate(S):
            if abs(s - 200.0) < 1.0 or abs(s - 250.0) < 1.0:
                R[i] = 40.0
        R_s = smooth_radius_spatial(S, R, window_m=150.0, method="median")
        V_curve = curve_speed_limit_mps(R_s, a_y_mps2=3.5)
        V_cible = [
            min(V_legal[i], V_curve[i])
            if V_curve[i] < CURVE_ACTIVE_BELOW_MPS
            else V_legal[i]
            for i in range(n)
        ]
        V_env = braking_feasible_speed(S, V_cible, b_plan_mps2=1.71)
        V_env = smooth_envelope_spatial(S, V_env, window_m=50.0)
        grad = envelope_max_gradient_kmh_per_m(S, V_env)
        self.assertLessEqual(
            grad,
            MAX_ENVELOPE_GRADIENT_KMH_PER_M + 1e-6,
            msg=f"envelope gradient {grad:.3f} km/h/m exceeds C0 budget",
        )


class TestBrakingFeasible(unittest.TestCase):
    def test_backward_ramp_before_slow_section(self) -> None:
        # Fast then abrupt wall to 10 m/s — must ramp down before the wall
        S = [0.0, 100.0, 200.0, 300.0]
        V = [40.0, 40.0, 10.0, 10.0]
        out = braking_feasible_speed(S, V, b_plan_mps2=2.0)
        self.assertLess(out[1], 40.0)
        self.assertGreaterEqual(out[1], 10.0)
        # Feasible: from out[1] can reach out[2] with b=2 over 100 m
        ds = 100.0
        v_cap = math.sqrt(out[2] ** 2 + 2.0 * 2.0 * ds)
        self.assertLessEqual(out[1], v_cap + 1e-6)


if __name__ == "__main__":
    unittest.main()
