"""Regression guard for the gravity-headroom fix.

Before the fix, when `-g·sin(α)` exceeded `params.a_max` (i.e. slopes
above ~6 % for the Eco/AVL a_max=0.6 m/s² preset), the IDM clamp
`a ∈ [-b_comf, a_max]` capped the wheel torque *before* gravity was
compensated. Result: `a_dyn = a_idm + a_grade ≤ a_max + a_grade < 0`, the
vehicle decelerated to a crawl (observed on the Col de l'Iseran export at
t≈160-241 s, 24 → 5.5 km/h over 30 s on a lacet at 7.4 %).

The fix in `kinematic_solver.py` promotes `a_max` to an *inertial* comfort
ceiling: the wheel is allowed to deliver up to `a_max + max(0, -a_grade)`
so that the *apparent* acceleration felt by the passenger still respects
`a_max`. On descents (`a_grade ≥ 0`) the correction degenerates to 0 and
the historical clamp is unchanged.

These tests fail without the fix and pass with it.
"""

from __future__ import annotations

import math
import unittest

from app.models.schemas import LatLon, SpatialCorridor
from app.services.kinematic_solver import IDMSolver


def _straight_corridor(
    alpha_pct: float,
    *,
    length_m: float = 3000.0,
    v_env_kmh: float = 50.0,
    n: int = 61,
) -> SpatialCorridor:
    """Straight (κ≈0), constant-slope corridor with a flat envelope."""
    ds = length_m / (n - 1)
    S = [i * ds for i in range(n)]
    v_env_mps = v_env_kmh / 3.6
    V = [v_env_mps] * n
    alpha_rad = math.atan(alpha_pct / 100.0)
    alpha = [alpha_rad] * n
    # Straight geometry aligned east; ~111 km per degree of longitude.
    geometry = [LatLon(lat=0.0, lon=i * ds / 111_000.0) for i in range(n)]
    return SpatialCorridor(
        S=S,
        V_limite=V,
        V_envelope=V,
        S_feux=[],
        alpha=alpha,
        V_curve=[1e6] * n,  # curvature never binding
        geometry=geometry,
        feux_meta=[],
        events=[],
    )


class TestClimbHoldsSpeed(unittest.TestCase):
    """The Iseran regression: Eco/AVL (a_max=0.6) on a 7.4 % climb."""

    def test_eco_avl_holds_speed_on_7_4pct_climb(self) -> None:
        """AVL-Eco (a_max=0.6 m/s²) must sustain V_env on a 7.4 % climb.

        Before the fix, on 7.4 % climb with a_max=0.6:
          a_grade = -g·sin(atan(0.074)) ≈ -0.724 m/s²
          a_dyn ≤ a_max + a_grade = -0.124 m/s²  (car ralentit sans fin)
        After the fix:
          a_max_eff = 0.6 + 0.724 = 1.324 m/s²
          a_dyn ≤ a_max_eff + a_grade = +0.6 m/s²  (passenger comfort respected)
        """
        v_env_kmh = 50.0
        corridor = _straight_corridor(
            alpha_pct=7.4, length_m=3000.0, v_env_kmh=v_env_kmh
        )
        solver = IDMSolver(
            corridor,
            driver_profile="Eco",
            seed=1,
            param_overrides={"a_max": 0.6, "b_comf": 0.53},
        )
        profile = solver.solve()

        # After the initial ramp-up (first 60 s), the vehicle must hold at
        # least 90 % of V_env. Without the fix, it collapses below 20 %.
        idx_settled = [i for i, t in enumerate(profile.time) if t >= 60.0]
        assert idx_settled, "profile too short"
        v_kmh_settled = [profile.velocity[i] * 3.6 for i in idx_settled]
        v_min_kmh = min(v_kmh_settled)
        self.assertGreaterEqual(
            v_min_kmh,
            0.90 * v_env_kmh,
            f"climb collapse: v_min={v_min_kmh:.1f} km/h "
            f"< 0.9·V_env={0.9 * v_env_kmh:.1f} km/h",
        )

    def test_passenger_comfort_ceiling_still_respected_in_climb(self) -> None:
        """The headroom fix must NOT let apparent accel exceed `a_max`.

        The fix promotes the wheel torque cap so that gravity gets
        compensated, but the resulting *inertial* acceleration
        `a_final ≈ a_wheel + a_grade` still respects the comfort ceiling.
        """
        corridor = _straight_corridor(alpha_pct=7.4, length_m=3000.0)
        a_max_driver = 0.6
        solver = IDMSolver(
            corridor,
            driver_profile="Eco",
            seed=1,
            param_overrides={"a_max": a_max_driver, "b_comf": 0.53},
        )
        profile = solver.solve()
        # `a_final` in the returned profile is `a_dyn` after jerk-limit clamp,
        # i.e. the apparent acceleration. Must respect the driver ceiling.
        # Small tolerance (1e-6) for FP jitter in the jerk limiter.
        a_max_apparent = max(profile.acceleration)
        self.assertLessEqual(
            a_max_apparent,
            a_max_driver + 1e-6,
            f"apparent accel {a_max_apparent:.4f} > a_max_driver={a_max_driver}",
        )

    def test_flat_road_unchanged_by_fix(self) -> None:
        """On flat road (a_grade=0), the headroom is 0 → identical behaviour.

        This guards against accidental changes to the well-tested flat
        regime — the fix must be inert here.
        """
        corridor = _straight_corridor(alpha_pct=0.0, length_m=3000.0)
        solver = IDMSolver(
            corridor,
            driver_profile="Eco",
            seed=1,
            param_overrides={"a_max": 0.6, "b_comf": 0.53},
        )
        profile = solver.solve()
        # Flat + Eco should never exceed a_max=0.6 m/s² apparent.
        self.assertLessEqual(max(profile.acceleration), 0.6 + 1e-6)
        # And should reach cruise speed (≥90 % of V_env=50 km/h; Eco has
        # speed_factor=0.95 → target 47.5 km/h ± FP jitter).
        v_cruise_kmh = max(profile.velocity) * 3.6
        self.assertGreaterEqual(v_cruise_kmh, 0.90 * 50.0)

    def test_descent_clamp_still_active(self) -> None:
        """On descent, `a_grade ≥ 0` → `max(0, -a_grade) = 0` → no change.

        The comfort ceiling on gravity-assisted acceleration remains
        exactly `a_max`; the fix is a no-op here.
        """
        corridor = _straight_corridor(alpha_pct=-5.0, length_m=3000.0)
        solver = IDMSolver(
            corridor,
            driver_profile="Eco",
            seed=1,
            param_overrides={"a_max": 0.6, "b_comf": 0.53},
        )
        profile = solver.solve()
        # On -5 % descent the wheel needs no push; apparent accel is bounded
        # by a_max=0.6 (comfort still bites even though gravity would allow
        # +0.49 m/s² of free assist).
        self.assertLessEqual(max(profile.acceleration), 0.6 + 1e-6)


if __name__ == "__main__":
    unittest.main()
