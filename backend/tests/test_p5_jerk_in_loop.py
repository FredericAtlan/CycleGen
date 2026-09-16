"""P5 — Jerk asymétrique applied INSIDE the IDM loop (not post)."""

from __future__ import annotations

import math
import unittest

from app.models.schemas import LatLon, SpatialCorridor
from app.services.kinematic_solver import (
    IDMSolver,
    PROFILE_PARAMS,
    _apply_jerk_limit,
)


def _corridor(v_env_mps: float = 22.0) -> SpatialCorridor:
    n = 41
    ds = 25.0
    S = [i * ds for i in range(n)]
    return SpatialCorridor(
        S=S,
        V_limite=[v_env_mps] * n,
        V_envelope=[v_env_mps] * n,
        S_feux=[],
        alpha=[0.0] * n,
        V_curve=[1e6] * n,
        geometry=[LatLon(lat=0.0, lon=i * ds / 111_000.0) for i in range(n)],
        feux_meta=[],
        events=[],
    )


class TestJerkInLoop(unittest.TestCase):
    def test_asymmetric_jerk_limit_helper(self) -> None:
        # Accel step: 0 → 3 with jerk_accel=1.5 → clipped to prev + 1.5*dt
        out = _apply_jerk_limit(3.0, 0.0, 1.5, 1.0, jerk_brake=3.0)
        self.assertAlmostEqual(out, 1.5, places=6)
        # Brake step: 0 → -3 with jerk_brake=3.0 → clipped to prev - 3.0*dt
        out = _apply_jerk_limit(-3.0, 0.0, 1.5, 1.0, jerk_brake=3.0)
        self.assertAlmostEqual(out, -3.0, places=6)

    def test_p95_jerk_stays_under_normal_target(self) -> None:
        # On a flat straight corridor at posted speed, the Normal driver's
        # inline jerk cap (1.5 accel / 3.0 brake) keeps 95th percentile
        # under ~2 m/s³ over the whole cycle.
        solver = IDMSolver(_corridor(), driver_profile="Normal", seed=1)
        profile = solver.solve()
        import numpy as np

        t = np.asarray(profile.time)
        a = np.asarray(profile.acceleration)
        if len(t) < 3:
            self.skipTest("profile too short")
        dt = np.diff(t)
        dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
        jerk = np.abs(np.diff(a) / dt)
        p95 = float(np.percentile(jerk, 95))
        self.assertLess(p95, 2.5)

    def test_sumo_vtype_matches_python_profile_params(self) -> None:
        """P5 alignment: SUMO vTypes (accel/decel) mirror PROFILE_PARAMS."""
        import xml.etree.ElementTree as ET
        from pathlib import Path

        vtypes = Path(__file__).resolve().parents[2] / "sumo" / "templates" / "vtypes.add.xml"
        self.assertTrue(vtypes.is_file())
        tree = ET.parse(vtypes)
        root = tree.getroot()
        found = {}
        for v in root.findall("vType"):
            found[v.get("id")] = v
        for driver, params in PROFILE_PARAMS.items():
            vt = found.get(driver.value)
            self.assertIsNotNone(vt, f"vType {driver.value} missing")
            self.assertEqual(vt.get("carFollowModel"), "IDM")
            self.assertAlmostEqual(float(vt.get("accel")), params.a_max, delta=0.05)
            self.assertAlmostEqual(float(vt.get("decel")), params.b_comf, delta=0.05)
            self.assertAlmostEqual(
                float(vt.get("speedFactor")), params.speed_factor, delta=0.03
            )


if __name__ == "__main__":
    unittest.main()
