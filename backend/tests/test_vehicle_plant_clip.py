"""VehiclePlant power / brake / retenue clip for IDM option B."""

from __future__ import annotations

import math
import unittest

from app.services.kinematic_solver import VehiclePlant, clip_vehicle_accel


class VehiclePlantClipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.plant = VehiclePlant(
            mass_kg=2556.0,
            f0_n=163.2,
            f1_n_per_kph=-0.0145,
            f2_n_per_kph2=0.0422,
            r_dyn_m=0.356,
            power_kw=80.0,
            tau_brake_max_nm=10000.0,
            regen_frac=0.40,
            engine_brake_frac=0.45,
        )

    def test_power_caps_hard_accel_at_speed(self) -> None:
        # At 20 m/s, P=80 kW → F_trac_max ≈ 4000 N → a ≲ 1.5 m/s² after road load.
        a_out = clip_vehicle_accel(4.0, 20.0, 0.0, self.plant)
        self.assertLess(a_out, 2.0)
        self.assertGreater(a_out, 0.5)

    def test_no_plant_passthrough(self) -> None:
        self.assertEqual(clip_vehicle_accel(2.5, 15.0, 0.05, None), 2.5)

    def test_descent_retenue_reduces_coast_accel(self) -> None:
        # Steep descent (~−8 %), near-coast command.
        alpha = math.atan(-0.08)
        a_free = clip_vehicle_accel(0.1, 15.0, alpha, None)
        a_hold = clip_vehicle_accel(0.1, 15.0, alpha, self.plant)
        # With plant, retenue should pull accel down vs unconstrained plant-less
        # path — compare plant with regen_frac=0 vs default.
        plant_no_regen = VehiclePlant(
            mass_kg=2556.0,
            f0_n=163.2,
            f1_n_per_kph=-0.0145,
            f2_n_per_kph2=0.0422,
            r_dyn_m=0.356,
            power_kw=80.0,
            tau_brake_max_nm=10000.0,
            regen_frac=0.0,
            engine_brake_frac=0.0,
        )
        a_no_hold = clip_vehicle_accel(0.1, 15.0, alpha, plant_no_regen)
        self.assertLess(a_hold, a_no_hold)
        self.assertLess(a_hold, a_free + 1e-9)


if __name__ == "__main__":
    unittest.main()
