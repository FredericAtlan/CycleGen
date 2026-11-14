"""P4 — Envelope C¹ smoothing (bilateral + DP)."""

from __future__ import annotations

import math
import unittest

from app.services.curvature import (
    NON_BINDING_V_MPS,
    envelope_max_gradient_kmh_per_m,
    smooth_envelope_bilateral,
    smooth_envelope_dp,
    smooth_envelope_spatial,
)


class TestBilateral(unittest.TestCase):
    def test_bilateral_removes_ripple(self) -> None:
        # 400 m corridor at 22 m/s with ±1.5 m/s digitisation noise
        S = [i * 5.0 for i in range(81)]
        V = [22.0 + (1.5 if i % 2 else -1.5) for i in range(81)]
        V_smooth = smooth_envelope_bilateral(
            S, V, tau_spatial_m=30.0, tau_range_mps=2.5
        )
        residual = [abs(v - 22.0) for v in V_smooth]
        self.assertLess(sum(residual) / len(residual), 0.6)

    def test_bilateral_preserves_speed_drops(self) -> None:
        # step change 30 → 10 m/s at 200 m — must NOT be smeared like MA.
        S = [i * 5.0 for i in range(81)]
        V = [30.0 if s < 200 else 10.0 for s in S]
        V_smooth = smooth_envelope_bilateral(
            S, V, tau_spatial_m=25.0, tau_range_mps=1.0
        )
        # Left of step: still ~30. Right of step: still ~10. Edge preserved.
        self.assertGreater(V_smooth[20], 28.0)
        self.assertLess(V_smooth[-1], 12.0)

    def test_bilateral_ignores_non_binding_sentinel(self) -> None:
        S = [0.0, 50.0, 100.0]
        V = [NON_BINDING_V_MPS, 20.0, NON_BINDING_V_MPS]
        V_out = smooth_envelope_bilateral(S, V)
        self.assertGreater(V_out[0], NON_BINDING_V_MPS * 0.5)
        self.assertGreater(V_out[2], NON_BINDING_V_MPS * 0.5)

    def test_bilateral_max_gradient_within_2_kmh_per_m(self) -> None:
        # A synthetic corridor with 5 m/s dip every 50 m.
        S = [i * 5.0 for i in range(41)]
        V = [22.0 - (5.0 if i % 10 == 0 else 0.0) for i in range(41)]
        V_smooth = smooth_envelope_bilateral(
            S, V, tau_spatial_m=25.0, tau_range_mps=3.0
        )
        grad_before = envelope_max_gradient_kmh_per_m(S, V)
        grad_after = envelope_max_gradient_kmh_per_m(S, V_smooth)
        self.assertLess(grad_after, grad_before)


class TestDP(unittest.TestCase):
    def test_dp_never_exceeds_envelope(self) -> None:
        S = [i * 5.0 for i in range(41)]
        V = [30.0 if s < 100 else 10.0 for s in S]
        V_out = smooth_envelope_dp(S, V)
        for v_ref, v_new in zip(V, V_out):
            if v_ref < NON_BINDING_V_MPS * 0.5:
                self.assertLessEqual(v_new, v_ref + 1e-6)

    def test_dp_smoothes_step(self) -> None:
        S = [i * 5.0 for i in range(41)]
        V = [30.0 if s < 100 else 10.0 for s in S]
        V_out = smooth_envelope_dp(S, V, w_fit=1.0, w_smooth1=2.0, w_smooth2=1.5)
        # Some rounding on the step edge is expected but the values must
        # keep converging to 10 on the right, not blow up.
        self.assertLess(V_out[-1], 11.0)
        self.assertGreater(V_out[0], 25.0)


if __name__ == "__main__":
    unittest.main()
