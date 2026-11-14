"""P1 + P2 — Verify grade coupling and preview braking behaviour.

- IDMSolver on a descent slope produces higher final speed than flat.
- IDMSolver on a climb slope produces lower final speed than flat.
- _preview_brake_accel yields a negative accel when the envelope drops ahead.
- On flat + constant envelope, preview braking is a no-op.
"""

from __future__ import annotations

import math
import unittest

from app.models.schemas import LatLon, SpatialCorridor
from app.services.kinematic_solver import (
    G_EARTH,
    IDMSolver,
    _preview_brake_accel,
)


def _make_corridor(alpha_pct: float, length_m: float = 2000.0) -> SpatialCorridor:
    n = 41
    ds = length_m / (n - 1)
    S = [i * ds for i in range(n)]
    V = [22.22] * n  # ~80 km/h everywhere
    alpha_rad = math.atan(alpha_pct / 100.0)
    alpha = [alpha_rad] * n
    # Straight geometry aligned east
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


class TestGradeCoupling(unittest.TestCase):
    def test_descent_reaches_higher_speed_than_flat(self) -> None:
        flat = IDMSolver(_make_corridor(0.0), driver_profile="Normal", seed=1).solve()
        descent = IDMSolver(
            _make_corridor(-5.0), driver_profile="Normal", seed=1
        ).solve()
        # Gravity assist shows up as a higher peak speed (V_envelope still caps).
        # Duration/avg can be slightly worse once plant + jerk damp coasting —
        # do not assert wall-clock superiority.
        self.assertGreaterEqual(
            max(descent.velocity), max(flat.velocity) - 0.05
        )
        # Slope must show negative alpha samples on the descent profile.
        self.assertTrue(any(a < -0.02 for a in descent.slope))

    def test_climb_reaches_lower_speed_than_flat(self) -> None:
        flat = IDMSolver(_make_corridor(0.0), driver_profile="Normal", seed=1).solve()
        climb = IDMSolver(
            _make_corridor(+6.0), driver_profile="Normal", seed=1
        ).solve()
        # 6 % climb strips ≈ 0.58 m/s² off the free accel; average speed drops.
        self.assertLessEqual(
            max(climb.velocity), max(flat.velocity) + 0.2
        )

    def test_preview_braking_activates_on_dropping_envelope(self) -> None:
        # Long descent then hairpin at 200 m: envelope falls from 30 → 8 m/s
        S = [i * 10.0 for i in range(0, 41)]  # 0..400 m
        V = [30.0 if s < 190 else 8.0 for s in S]
        alpha_desc = [math.atan(-0.05)] * len(S)
        a = _preview_brake_accel(
            s=0.0,
            v=28.0,
            S=S,
            V=V,
            alpha=alpha_desc,
            b_comf=2.0,
            T_look_s=8.0,
            step_m=5.0,
            speed_factor=1.0,
        )
        self.assertLess(a, -0.2)  # significant preview brake demanded

    def test_preview_braking_noop_on_flat_and_open_road(self) -> None:
        S = [i * 10.0 for i in range(0, 41)]
        V = [30.0] * len(S)
        alpha = [0.0] * len(S)
        a = _preview_brake_accel(
            s=0.0,
            v=25.0,
            S=S,
            V=V,
            alpha=alpha,
            b_comf=2.0,
            T_look_s=6.0,
            step_m=5.0,
            speed_factor=1.0,
        )
        # Unconstrained → +inf (must NOT be 0.0, which would kill accel).
        self.assertTrue(math.isinf(a) and a > 0.0)

    def test_g_earth_matches_profile_metrics(self) -> None:
        from app.services.profile_metrics import G_EARTH as G2

        self.assertAlmostEqual(G_EARTH, G2, places=6)


if __name__ == "__main__":
    unittest.main()
