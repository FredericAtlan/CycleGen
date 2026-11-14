"""Unit tests for sparse Markov TPM + conditional TLS / IDM solver."""

from __future__ import annotations

import random
import unittest

from app.models.schemas import DriverProfile, FeuMeta, LatLon, SpatialCorridor
from app.services.kinematic_solver import IDMSolver, _plan_lights, _speed_envelope
from app.services.markov_noise import MarkovNoiseGenerator, load_tpm


class TestMarkovTpm(unittest.TestCase):
    def test_rows_sum_to_one(self) -> None:
        for profile in DriverProfile:
            data = load_tpm(profile)
            tpm = data["tpm"]
            self.assertTrue(tpm, msg=f"empty tpm for {profile}")
            for key, row in tpm.items():
                s = sum(float(v) for v in row.values())
                self.assertAlmostEqual(s, 1.0, places=4, msg=f"{profile}/{key}")

    def test_missing_state_returns_zero(self) -> None:
        gen = MarkovNoiseGenerator("normal")
        rng = random.Random(0)
        n = gen.sample_noise(200.0, 0.0, is_critical_braking=False, rng=rng)
        self.assertEqual(n, 0.0)

    def test_critical_braking_forces_zero(self) -> None:
        gen = MarkovNoiseGenerator("agressif")
        rng = random.Random(1)
        n = gen.sample_noise(12.0, 0.5, is_critical_braking=True, rng=rng)
        self.assertEqual(n, 0.0)
        n2 = gen.sample_noise(12.0, -1.5, is_critical_braking=False, rng=rng)
        self.assertEqual(n2, 0.0)

    def test_eco_noise_smaller_than_agressif(self) -> None:
        rng_e = random.Random(7)
        rng_a = random.Random(7)
        eco = MarkovNoiseGenerator("eco")
        agr = MarkovNoiseGenerator("agressif")
        samples_e = [abs(eco.sample_noise(12.0, 0.0, rng=rng_e)) for _ in range(80)]
        samples_a = [abs(agr.sample_noise(12.0, 0.0, rng=rng_a)) for _ in range(80)]
        self.assertLess(sum(samples_e) / len(samples_e), sum(samples_a) / len(samples_a))


class TestConditionalTls(unittest.TestCase):
    def _corridor(self, metas: list[FeuMeta]) -> SpatialCorridor:
        S = [0.0, 500.0, 1000.0, 1500.0]
        V = [13.9, 13.9, 13.9, 13.9]
        return SpatialCorridor(
            S=S,
            V_limite=V,
            V_envelope=V,
            alpha=[0.0] * 4,
            S_feux=[m.s_m for m in metas],
            feux_meta=metas,
            events=[],
            geometry=[LatLon(lat=48.8 + i * 0.001, lon=2.3) for i in range(4)],
        )

    def test_green_wave_deterministic(self) -> None:
        metas = [
            FeuMeta(s_m=500.0, highway="primary", tls_mode="green_wave"),
            FeuMeta(s_m=1200.0, highway="primary", tls_mode="green_wave"),
        ]
        c = self._corridor(metas)
        V = _speed_envelope(c)
        a = _plan_lights(c, seed=1, tls_cycle_s=90.0, tls_green_s=35.0, V=V)
        b = _plan_lights(c, seed=99, tls_cycle_s=90.0, tls_green_s=35.0, V=V)
        self.assertEqual(
            [(p.s_m, p.is_red, p.stop_duration_s) for p in a],
            [(p.s_m, p.is_red, p.stop_duration_s) for p in b],
        )

    def test_dense_primary_second_light_seed_dependent(self) -> None:
        """Dense primary: spatial assign marks 2nd light stochastic — honor meta."""
        metas = [
            FeuMeta(s_m=400.0, highway="primary", tls_mode="green_wave"),
            FeuMeta(s_m=700.0, highway="primary", tls_mode="stochastic"),
        ]
        c = self._corridor(metas)
        V = _speed_envelope(c)
        firsts = [
            _plan_lights(c, seed=s, tls_cycle_s=90.0, tls_green_s=35.0, V=V)[0]
            for s in (1, 2, 3)
        ]
        self.assertTrue(
            all(
                (p.is_red, p.stop_duration_s) == (firsts[0].is_red, firsts[0].stop_duration_s)
                for p in firsts
            )
        )
        seconds = set()
        for s in range(40):
            p1 = _plan_lights(c, seed=s, tls_cycle_s=90.0, tls_green_s=35.0, V=V)[1]
            seconds.add((p1.is_red, round(p1.stop_duration_s, 4)))
        self.assertGreater(len(seconds), 1)

    def test_tls_override_forces_green_wave(self) -> None:
        metas = [
            FeuMeta(s_m=400.0, highway="tertiary", tls_mode="stochastic"),
            FeuMeta(s_m=900.0, highway="tertiary", tls_mode="stochastic"),
        ]
        c = self._corridor(metas)
        V = _speed_envelope(c)
        a = _plan_lights(
            c, seed=1, tls_cycle_s=90.0, tls_green_s=35.0, V=V, tls_override="green_wave"
        )
        b = _plan_lights(
            c, seed=99, tls_cycle_s=90.0, tls_green_s=35.0, V=V, tls_override="green_wave"
        )
        self.assertEqual(
            [(p.is_red, p.stop_duration_s) for p in a],
            [(p.is_red, p.stop_duration_s) for p in b],
        )

    def test_stochastic_seed_reproducible(self) -> None:
        metas = [
            FeuMeta(s_m=400.0, highway="tertiary", tls_mode="stochastic"),
            FeuMeta(s_m=800.0, highway="secondary", tls_mode="stochastic"),
        ]
        c = self._corridor(metas)
        V = _speed_envelope(c)
        a = _plan_lights(c, seed=7, tls_cycle_s=90.0, tls_green_s=35.0, V=V)
        b = _plan_lights(c, seed=7, tls_cycle_s=90.0, tls_green_s=35.0, V=V)
        self.assertEqual(
            [(p.is_red, p.stop_duration_s) for p in a],
            [(p.is_red, p.stop_duration_s) for p in b],
        )


class TestIdmMarkovAsymmetric(unittest.TestCase):
    def test_solve_uses_envelope_and_completes(self) -> None:
        n = 20
        S = [float(i * 50) for i in range(n)]
        V = [20.0] * 10 + [8.0] * 10
        corridor = SpatialCorridor(
            S=S,
            V_limite=[25.0] * n,
            V_envelope=V,
            alpha=[0.0] * n,
            S_feux=[],
            feux_meta=[],
            events=[],
            geometry=[LatLon(lat=48.8, lon=2.3 + i * 0.0004) for i in range(n)],
        )
        solver = IDMSolver(corridor, DriverProfile.NORMAL, seed=0)
        frames = solver.generate_frames()
        self.assertGreater(len(frames), 5)
        self.assertAlmostEqual(frames[-1].s, S[-1], delta=1.0)
        vmax = max(fr.v for fr in frames)
        self.assertLessEqual(vmax, 22.0)


if __name__ == "__main__":
    unittest.main()
