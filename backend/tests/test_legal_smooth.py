"""Unit tests for spatial V_legal filtering (majority / debounce)."""

from __future__ import annotations

from app.services.spatial_processor import smooth_legal_speeds_spatial


def _kmh(v: float) -> float:
    return v / 3.6


def test_majority_kills_short_plaque():
    """A 40 m plaque of 30 km/h inside a 50 km/h corridor is majority-voted out."""
    # samples every 10 m, 0..500 m
    S = [float(i * 10) for i in range(51)]
    V = [_kmh(50.0) for _ in S]
    # plaque 30 km/h from s=200..240 (40 m)
    for i, s in enumerate(S):
        if 200 <= s <= 240:
            V[i] = _kmh(30.0)

    out = smooth_legal_speeds_spatial(
        S, V, window_m=250.0, mode="majority", min_run_m=0.0
    )
    mid = next(i for i, s in enumerate(S) if s == 220)
    assert abs(out[mid] * 3.6 - 50.0) < 1.0


def test_min_run_debounce_absorbs_short_plateau():
    """After majority, a short remaining plateau is absorbed by min_run_m."""
    S = [float(i * 10) for i in range(41)]
    V = [_kmh(70.0) for _ in S]
    # short real change 50 km/h for 60 m (not enough if min_run=120)
    for i, s in enumerate(S):
        if 150 <= s < 210:
            V[i] = _kmh(50.0)

    out = smooth_legal_speeds_spatial(
        S, V, window_m=0.0, mode="none", min_run_m=120.0
    )
    # entire short plateau should be overwritten back to 70
    for i, s in enumerate(S):
        if 150 <= s < 210:
            assert abs(out[i] * 3.6 - 70.0) < 1.0


def test_mode_none_preserves_values():
    S = [0.0, 100.0, 200.0]
    V = [_kmh(30.0), _kmh(50.0), _kmh(70.0)]
    out = smooth_legal_speeds_spatial(
        S, V, window_m=250.0, mode="none", min_run_m=0.0
    )
    assert [round(v * 3.6) for v in out] == [30, 50, 70]
