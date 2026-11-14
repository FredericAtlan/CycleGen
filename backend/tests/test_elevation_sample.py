"""Unit tests for elevation subsample / interpolate helpers."""

from app.services.data_fetcher import (
    _elevation_sample_indices,
    _interpolate_elevations,
)


def test_sample_indices_keeps_ends_and_cap():
    idxs = _elevation_sample_indices(2931, 400)
    assert idxs[0] == 0
    assert idxs[-1] == 2930
    assert len(idxs) <= 400
    assert idxs == sorted(idxs)
    assert len(idxs) == len(set(idxs))


def test_sample_indices_passthrough_when_small():
    assert _elevation_sample_indices(10, 400) == list(range(10))


def test_interpolate_linear_ramp():
    # samples at 0, 5, 10 with z = 0, 50, 100 → midpoint i=2.5 ≈ between 0 and 5
    n = 11
    sample_idx = [0, 5, 10]
    sample_z = [0.0, 50.0, 100.0]
    out = _interpolate_elevations(n, sample_idx, sample_z)
    assert len(out) == n
    assert out[0] == 0.0
    assert out[5] == 50.0
    assert out[10] == 100.0
    assert abs(out[2] - 20.0) < 1e-9
    assert abs(out[7] - 70.0) < 1e-9
