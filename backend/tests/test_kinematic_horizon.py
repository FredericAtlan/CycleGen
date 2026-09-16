"""Tests for scan horizon + critical envelope virtual leader."""

from __future__ import annotations

import unittest

from app.services.kinematic_solver import (
    _critical_envelope_leader,
    _kinematic_horizon_m,
    _scan_horizon_m,
)


class TestKinematicHorizon(unittest.TestCase):
    def test_scan_horizon_v_th(self) -> None:
        # D = v · T_h (Gemini UI)
        self.assertAlmostEqual(_scan_horizon_m(30.0, 4.0), 120.0, places=4)
        self.assertAlmostEqual(_scan_horizon_m(20.0, 5.0), 100.0, places=4)

    def test_legacy_kinematic_horizon(self) -> None:
        D = _kinematic_horizon_m(30.0, 1.4, 1.71)
        self.assertAlmostEqual(D, 30.0 * 1.4 + 900.0 / (2.0 * 1.71), places=4)

    def test_critical_leader_picks_hardest_brake(self) -> None:
        S = [0.0, 50.0, 100.0, 150.0, 200.0]
        V = [30.0, 30.0, 30.0, 10.0, 10.0]  # wall at 150 m
        v = 30.0
        D = _scan_horizon_m(v, 6.0)  # 180 m
        crit = _critical_envelope_leader(0.0, v, S, V, D, speed_factor=1.0)
        self.assertIsNotNone(crit)
        assert crit is not None
        L, v_lead = crit
        self.assertGreaterEqual(L, 100.0)
        self.assertLessEqual(L, 160.0)
        self.assertLess(v_lead, 15.0)

    def test_no_leader_on_flat_envelope(self) -> None:
        S = [0.0, 50.0, 100.0, 150.0]
        V = [30.0, 30.0, 30.0, 30.0]
        crit = _critical_envelope_leader(
            0.0, 30.0, S, V, 200.0, speed_factor=1.0
        )
        self.assertIsNone(crit)


if __name__ == "__main__":
    unittest.main()
