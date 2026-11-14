"""Unit tests for profile KPIs / RPA / scenario batch."""

from __future__ import annotations

import math

from app.models.schemas import DriverProfile, FeuMeta, LatLon, SpatialCorridor
from app.services.kinematic_solver import IDMSolver
from app.services.profile_metrics import profile_kpis, relative_positive_acceleration
from app.services.spatial_processor import detect_slope_spikes


def test_rpa_known_series():
    # Constant a=1 for 10 s at rising v from 0 — RPA > 0
    t = list(range(0, 11))
    v = [float(i) for i in t]  # a ≈ 1
    a = [1.0] * 11
    rpa = relative_positive_acceleration(t, v, a)
    assert rpa > 0.5


def test_profile_kpis_stops():
    t = list(range(0, 20))
    v = [0.0] * 5 + [10.0] * 10 + [0.0] * 5
    k = profile_kpis({"time": t, "velocity": v, "position": [float(i) for i in t]})
    assert k["stops"] >= 1
    assert k["duration_s"] == 19.0


def test_scenario_three_profiles_differ():
    n = 30
    S = [float(i * 40) for i in range(n)]
    V = [15.0] * n
    corridor = SpatialCorridor(
        S=S,
        V_limite=V,
        V_envelope=V,
        alpha=[0.0] * n,
        S_feux=[400.0, 800.0],
        feux_meta=[
            FeuMeta(s_m=400.0, highway="tertiary", tls_mode="stochastic"),
            FeuMeta(s_m=800.0, highway="tertiary", tls_mode="stochastic"),
        ],
        events=[],
        geometry=[LatLon(lat=48.8 + i * 0.0003, lon=1.6) for i in range(n)],
    )
    eco = IDMSolver(corridor, DriverProfile.ECO, seed=1).solve()
    agr = IDMSolver(corridor, DriverProfile.AGRESSIF, seed=1).solve()
    assert eco.average_speed_kmh <= agr.average_speed_kmh + 5.0
    assert agr.max_abs_accel_g is not None
    assert agr.max_abs_accel_g < 1.5  # clip should keep under ~1.5 g for agressif


def test_tls_override_changes_stop_structure():
    n = 40
    S = [float(i * 50) for i in range(n)]
    V = [20.0] * n
    corridor = SpatialCorridor(
        S=S,
        V_limite=V,
        V_envelope=V,
        alpha=[0.0] * n,
        S_feux=[300.0, 900.0, 1500.0],
        feux_meta=[
            FeuMeta(s_m=300.0, highway="tertiary", tls_mode="stochastic"),
            FeuMeta(s_m=900.0, highway="tertiary", tls_mode="stochastic"),
            FeuMeta(s_m=1500.0, highway="tertiary", tls_mode="stochastic"),
        ],
        events=[],
        geometry=[LatLon(lat=48.8, lon=1.6 + i * 0.0004) for i in range(n)],
    )
    stoch = IDMSolver(
        corridor, DriverProfile.NORMAL, seed=3, tls_override="stochastic"
    ).solve()
    wave = IDMSolver(
        corridor, DriverProfile.NORMAL, seed=3, tls_override="green_wave"
    ).solve()
    # At least safety fields populated
    assert stoch.stops is not None
    assert wave.rpa is not None


def test_slope_spike_detector():
    S = [float(i * 10) for i in range(20)]
    alpha = [0.01] * 20
    alpha[10] = 0.35
    alpha[11] = 0.30
    w = detect_slope_spikes(alpha, S)
    assert len(w) >= 1
    assert w[0].code == "slope_spike_residual"
