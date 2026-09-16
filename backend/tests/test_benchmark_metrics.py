"""Unit tests for benchmark loader + metrics."""

from __future__ import annotations

import math

import numpy as np

from app.services.benchmark_loader import list_sources, load_reference
from app.services.benchmark_metrics import compute_comparison


def test_list_sources_includes_seeds():
    sources = list_sources()
    ids = {s["id"] for s in sources}
    assert "wltc_class3_proxy" in ids
    assert "nedc_proxy" in ids
    assert "demo_gps_richebourg_houdan" in ids
    demo = next(s for s in sources if s["id"] == "demo_gps_richebourg_houdan")
    assert demo["has_geo"] is True
    assert demo["n_points"] > 10


def test_list_sources_includes_regulatory_full():
    sources = list_sources()
    ids = {s["id"] for s in sources}
    for sid in (
        "wltc_class1",
        "wltc_class2",
        "wltc_class3",
        "nedc",
        "udds",
        "ftp75",
        "us06",
        "hwfet",
    ):
        assert sid in ids
    families = {s["family"] for s in sources}
    assert "regulatory" in families
    assert "ved" in families
    assert "geolife" in families
    wltc = next(s for s in sources if s["id"] == "wltc_class3")
    assert wltc["duration_s"] >= 1700
    assert wltc["family"] == "regulatory"


def test_renault_and_alpine_slope_stats_sane():
    sources = {s["id"]: s for s in list_sources()}
    renault = sources["renault_grossglockner_route_planner"]
    st = renault["stats"] or {}
    assert st.get("slope_mean_pct") is not None
    assert -14.0 <= st["slope_mean_pct"] <= -5.0
    assert -14.0 <= st["slope_min_pct"] <= -10.0
    assert -5.0 <= st["slope_max_pct"] <= 0.0

    for sid in (
        "grossglockner_descent",
        "iseran_descent",
        "stelvio_north_descent",
    ):
        st = sources[sid]["stats"] or {}
        assert st.get("slope_mean_pct") is not None
        assert -15.0 <= st["slope_min_pct"] <= 0.0
        assert -15.0 <= st["slope_mean_pct"] <= 2.0
        assert abs(st["slope_max_pct"]) <= 15.0
        assert abs(st.get("a_lat_max_mps2") or 0) <= 6.5 + 1e-6

    ref = load_reference("renault_grossglockner_route_planner")
    assert ref is not None and ref["slope"] is not None
    pct = [math.tan(a) * 100 for a in ref["slope"]]
    assert min(pct) >= -15.1
    assert max(pct) <= 0.1
    assert ref["has_geo"] is False
    assert ref.get("lat") in (None, [])


def test_load_reference_series_has_geo_for_ved():
    ref = load_reference("ved_veh202_trip1202")
    assert ref is not None
    assert ref["has_geo"] is True
    assert len(ref["lat"]) == len(ref["time"])
    assert len(ref["lon"]) == len(ref["time"])
    assert max(ref["velocity"]) < 55


def test_load_reference_wltc():
    ref = load_reference("wltc_class3_proxy")
    assert ref is not None
    assert len(ref["time"]) == len(ref["velocity"])
    assert ref["has_geo"] is False
    assert max(ref["velocity"]) < 50  # m/s sanity


def test_rmse_identical_series():
    t = list(range(0, 51))
    v = [10.0 + 0.1 * i for i in t]
    profile = {
        "time": t,
        "velocity": v,
        "position": [float(i * 10) for i in t],
        "acceleration": [0.1] * len(t),
    }
    ref = {"time": t, "velocity": v, "has_geo": False, "lat": None, "lon": None}
    out = compute_comparison(profile, ref, align="time")
    assert out["kpis"]["rmse_v"] < 1e-9
    assert out["kpis"]["bias_v"] == 0.0
    assert abs(out["kpis"]["delta_duration_s"]) < 1e-9


def test_rmse_known_offset():
    t = list(range(0, 21))
    v_ref = [5.0] * len(t)
    v_gen = [7.0] * len(t)  # +2 m/s bias
    profile = {
        "time": t,
        "velocity": v_gen,
        "position": [float(i * 7) for i in t],
        "acceleration": [0.0] * len(t),
    }
    ref = {"time": t, "velocity": v_ref, "has_geo": False}
    out = compute_comparison(profile, ref, align="time")
    assert math.isclose(out["kpis"]["rmse_v"], 2.0, abs_tol=1e-6)
    assert math.isclose(out["kpis"]["bias_v"], 2.0, abs_tol=1e-6)


def test_stop_counting():
    # 0-4s stopped, 5-9s moving, 10-14s stopped
    t = list(range(0, 16))
    v = [0.0] * 5 + [8.0] * 5 + [0.0] * 6
    profile = {
        "time": [float(x) for x in t],
        "velocity": v,
        "position": list(np.cumsum([0.0] + v[:-1])),
        "acceleration": [0.0] * len(t),
    }
    ref = {
        "time": [float(x) for x in t],
        "velocity": [0.0] * 8 + [8.0] * 8,
        "has_geo": False,
    }
    out = compute_comparison(profile, ref, align="time")
    assert out["kpis"]["stops_gen"] >= 1
    assert out["kpis"]["stop_time_ratio_gen"] > 0.3


def test_distance_align_fallback_warning():
    t = list(range(0, 11))
    profile = {
        "time": [float(x) for x in t],
        "velocity": [5.0] * len(t),
        "position": [],  # missing → fallback
        "acceleration": [0.0] * len(t),
    }
    ref = {"time": [float(x) for x in t], "velocity": [5.0] * len(t), "has_geo": False}
    out = compute_comparison(profile, ref, align="distance")
    assert out["align"] == "time"
    assert any("Distance alignment" in w for w in out["warnings"])
