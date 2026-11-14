"""Homologation: enable_markov=False yields identical runs (deterministic)."""

from __future__ import annotations

from app.models.schemas import LatLon, SpatialCorridor
from app.services.kinematic_solver import IDMSolver


def _corridor() -> SpatialCorridor:
    n = 30
    S = [float(i * 20) for i in range(n)]
    V = [20.0] * n
    alpha = [0.0] * n
    geom = [LatLon(lat=45.0 + i * 0.0001, lon=6.0) for i in range(n)]
    return SpatialCorridor(
        S=S,
        V_limite=V,
        V_limite_legal=V,
        V_traffic=V,
        V_curve=V,
        V_envelope=V,
        alpha=alpha,
        elevations_m=[800.0] * n,
        S_feux=[],
        events=[],
        geometry=geom,
    )


def test_markov_off_is_deterministic():
    c = _corridor()
    a = IDMSolver(c, "Normal", seed=1, enable_markov=False).solve()
    b = IDMSolver(c, "Normal", seed=99, enable_markov=False).solve()
    assert a.time == b.time
    assert a.velocity == b.velocity
    assert a.acceleration == b.acceleration
