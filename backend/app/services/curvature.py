"""Curvature radius R(s) and curve speed limit from polyline geometry."""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from app.models.schemas import LatLon

EARTH_RADIUS_M = 6_371_000.0
# P3 — Floor R: real alpine hairpins (Iseran / Stelvio / Grossglockner) are
# ~15–20 m; the previous 40 m floor effectively erased them. 15 m → ~19 km/h
# with a_y=2.5, matching AVL curve-speed calls on hairpins.
MIN_R_M = 15.0
MAX_R_M = 50_000.0
# Prefer triplets spanning ~chord_m so dense GPS kinks don't fake hairpins.
CURVATURE_CHORD_M = 25.0
# P3 — Adaptive median window on R (Peano-like). We clamp
# ``4·R_local`` between R_SMOOTH_WINDOW_MIN_M and R_SMOOTH_WINDOW_MAX_M.
# ``R_SMOOTH_WINDOW_M`` remains as the legacy fixed-window default.
R_SMOOTH_WINDOW_M = 150.0
R_SMOOTH_WINDOW_MIN_M = 25.0
R_SMOOTH_WINDOW_MAX_M = 250.0
R_SMOOTH_ADAPT_FACTOR = 4.0
# Tricube half-support (m) for local LS regression on curvature.
R_LOCAL_LS_HALFSPAN_M = 60.0
# Above this speed, the road is "effectively straight" for comfort — do not
# constrain the envelope (avoids ~1000 km/h spikes on long straights).
CURVE_ACTIVE_BELOW_MPS = 130.0 / 3.6  # ≈ 36.1 m/s
NON_BINDING_V_MPS = 1.0e6
# Validation: |ΔV_envelope| / Δs must stay below this (km/h per metre).
MAX_ENVELOPE_GRADIENT_KMH_PER_M = 2.0


def _to_local_xy(geometry: Sequence[LatLon]) -> np.ndarray:
    """Approximate local ENU meters (equirectangular) around first point."""
    if not geometry:
        return np.zeros((0, 2))
    lat0 = math.radians(geometry[0].lat)
    lon0 = math.radians(geometry[0].lon)
    xy = np.zeros((len(geometry), 2), dtype=float)
    for i, p in enumerate(geometry):
        lat = math.radians(p.lat)
        lon = math.radians(p.lon)
        xy[i, 0] = (lon - lon0) * math.cos(lat0) * EARTH_RADIUS_M
        xy[i, 1] = (lat - lat0) * EARTH_RADIUS_M
    return xy


def circumradius_m(p0: np.ndarray, p1: np.ndarray, p2: np.ndarray) -> float:
    """Circumradius of triangle p0-p1-p2; large R ≈ straight."""
    a = float(np.linalg.norm(p1 - p0))
    b = float(np.linalg.norm(p2 - p1))
    c = float(np.linalg.norm(p2 - p0))
    if a < 1e-3 or b < 1e-3 or c < 1e-3:
        return MAX_R_M
    area2 = abs(
        (p0[0] * (p1[1] - p2[1]) + p1[0] * (p2[1] - p0[1]) + p2[0] * (p0[1] - p1[1]))
    )
    if area2 < 1e-6:
        return MAX_R_M
    r = (a * b * c) / (2.0 * area2)
    return float(min(MAX_R_M, max(MIN_R_M, r)))


def _neighbor_index(cum_s: np.ndarray, i: int, target_m: float, *, forward: bool) -> int:
    """Index at least ``target_m`` along the polyline from vertex i."""
    n = len(cum_s)
    if forward:
        j = i + 1
        while j < n - 1 and (cum_s[j] - cum_s[i]) < target_m:
            j += 1
        return min(n - 1, j)
    j = i - 1
    while j > 0 and (cum_s[i] - cum_s[j]) < target_m:
        j -= 1
    return max(0, j)


def _polyline_cum_s(xy: np.ndarray) -> np.ndarray:
    if len(xy) == 0:
        return np.zeros(0, dtype=float)
    if len(xy) == 1:
        return np.zeros(1, dtype=float)
    ds = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    return np.concatenate([[0.0], np.cumsum(ds)])


def smooth_radius_spatial(
    S: Sequence[float],
    R: Sequence[float],
    *,
    window_m: float = R_SMOOTH_WINDOW_M,
    method: str = "median",
) -> list[float]:
    """Distance-based smoother on R(s) — never index windows (GPS ≠ equidistant).

    For each S_i, aggregate R_k for S_k ∈ [S_i − W/2, S_i + W/2].
    Median resists phantom hairpins from digitization noise.
    """
    n = min(len(S), len(R))
    if n == 0:
        return []
    if n == 1 or window_m <= 0:
        return [float(min(MAX_R_M, max(MIN_R_M, float(R[i])))) for i in range(n)]
    half = float(window_m) * 0.5
    S_arr = np.asarray([float(S[i]) for i in range(n)], dtype=float)
    R_arr = np.asarray(
        [float(min(MAX_R_M, max(MIN_R_M, float(R[i])))) for i in range(n)],
        dtype=float,
    )
    out = np.empty(n, dtype=float)
    j0 = 0
    j1 = 0
    use_median = method != "mean"
    for i in range(n):
        si = S_arr[i]
        while j0 < n and S_arr[j0] < si - half:
            j0 += 1
        if j1 < j0:
            j1 = j0
        while j1 < n and S_arr[j1] <= si + half:
            j1 += 1
        window = R_arr[j0:j1]
        if window.size == 0:
            out[i] = R_arr[i]
        elif use_median:
            out[i] = float(np.median(window))
        else:
            out[i] = float(np.mean(window))
    return np.clip(out, MIN_R_M, MAX_R_M).tolist()


def smooth_radius_adaptive(
    S: Sequence[float],
    R: Sequence[float],
    *,
    min_window_m: float = R_SMOOTH_WINDOW_MIN_M,
    max_window_m: float = R_SMOOTH_WINDOW_MAX_M,
    factor: float = R_SMOOTH_ADAPT_FACTOR,
) -> list[float]:
    """P3 — Adaptive median-window smoother: W_i = clamp(factor · R_i, min, max).

    Peano-inspired: window shrinks in hairpins so 20 m radii survive, and
    widens on straights to kill digitisation noise. Median stays robust.
    """
    n = min(len(S), len(R))
    if n == 0:
        return []
    if n == 1:
        return [float(min(MAX_R_M, max(MIN_R_M, float(R[0]))))]
    S_arr = np.asarray([float(S[i]) for i in range(n)], dtype=float)
    R_arr = np.asarray(
        [float(min(MAX_R_M, max(MIN_R_M, float(R[i])))) for i in range(n)],
        dtype=float,
    )
    lo = float(min_window_m)
    hi = float(max_window_m)
    f = float(factor)
    out = np.empty(n, dtype=float)
    for i in range(n):
        w = min(hi, max(lo, f * R_arr[i]))
        half = 0.5 * w
        si = S_arr[i]
        j0 = int(np.searchsorted(S_arr, si - half, side="left"))
        j1 = int(np.searchsorted(S_arr, si + half, side="right"))
        window = R_arr[j0:j1]
        if window.size == 0:
            out[i] = R_arr[i]
        else:
            out[i] = float(np.median(window))
    return np.clip(out, MIN_R_M, MAX_R_M).tolist()


def _tricube_weights(dist_m: np.ndarray, halfspan_m: float) -> np.ndarray:
    """Cleveland-tricube weights (0..1) for local LS regression."""
    x = np.abs(dist_m) / max(halfspan_m, 1e-9)
    w = np.zeros_like(x)
    mask = x < 1.0
    w[mask] = (1.0 - x[mask] ** 3) ** 3
    return w


def smooth_radius_local_ls(
    S: Sequence[float],
    R: Sequence[float],
    *,
    halfspan_m: float = R_LOCAL_LS_HALFSPAN_M,
) -> list[float]:
    """P3 — Locally-weighted least squares (Tricube) on R(s).

    Instead of a plain median we fit ``R ≈ a₀ + a₁·s + a₂·s²`` on the
    neighbourhood, weighted by Cleveland's tricube kernel. This produces a
    continuous κ = 1/R (no median plateaux) that respects sharp local dips.
    """
    n = min(len(S), len(R))
    if n == 0:
        return []
    if n < 3:
        return [float(min(MAX_R_M, max(MIN_R_M, float(R[i])))) for i in range(n)]
    S_arr = np.asarray([float(S[i]) for i in range(n)], dtype=float)
    R_arr = np.asarray(
        [float(min(MAX_R_M, max(MIN_R_M, float(R[i])))) for i in range(n)],
        dtype=float,
    )
    out = np.empty(n, dtype=float)
    for i in range(n):
        si = S_arr[i]
        j0 = int(np.searchsorted(S_arr, si - halfspan_m, side="left"))
        j1 = int(np.searchsorted(S_arr, si + halfspan_m, side="right"))
        if j1 - j0 < 3:
            out[i] = R_arr[i]
            continue
        x = S_arr[j0:j1] - si
        y = R_arr[j0:j1]
        w = _tricube_weights(x, halfspan_m)
        if not np.any(w > 1e-9):
            out[i] = R_arr[i]
            continue
        # Design matrix [1, x, x²]; weighted normal equations
        X = np.column_stack([np.ones_like(x), x, x * x])
        W = np.diag(w)
        try:
            beta = np.linalg.solve(X.T @ W @ X, X.T @ (w * y))
            out[i] = float(beta[0])  # value at x=0
        except np.linalg.LinAlgError:
            out[i] = float(np.average(y, weights=w))
    return np.clip(out, MIN_R_M, MAX_R_M).tolist()


def curvature_radius_m(
    geometry: Sequence[LatLon],
    *,
    smooth_window_m: float = R_SMOOTH_WINDOW_M,
    adaptive: bool = True,
    use_local_ls: bool = True,
) -> list[float]:
    """R(s) at each vertex via circumcircle of ~chord_m neighbors, then spatial smoother.

    Pipeline (P3):
      1. local R from ~25 m chord triplets
      2. **adaptive** median-window: ``W = clamp(4·R, 25, 250) m``
         → hairpins keep small windows, straights use wide windows.
      3. optional Tricube local LS regression to remove median-plateau
         staircases in κ(s) (default on).

    ``adaptive=False, use_local_ls=False`` reproduces the legacy fixed-window
    median for regression tests.
    """
    n = len(geometry)
    if n == 0:
        return []
    if n < 3:
        return [MAX_R_M] * n
    xy = _to_local_xy(geometry)
    cum_s = _polyline_cum_s(xy)
    r = np.full(n, MAX_R_M, dtype=float)
    chord = CURVATURE_CHORD_M
    for i in range(1, n - 1):
        i0 = _neighbor_index(cum_s, i, chord, forward=False)
        i2 = _neighbor_index(cum_s, i, chord, forward=True)
        if i0 == i or i2 == i:
            i0, i2 = i - 1, i + 1
        r[i] = circumradius_m(xy[i0], xy[i], xy[i2])
    r[0] = r[1]
    r[-1] = r[-2]

    if adaptive:
        r_smoothed = smooth_radius_adaptive(cum_s.tolist(), r.tolist())
    else:
        r_smoothed = smooth_radius_spatial(
            cum_s.tolist(), r.tolist(), window_m=smooth_window_m, method="median"
        )

    if use_local_ls:
        r_smoothed = smooth_radius_local_ls(cum_s.tolist(), r_smoothed)

    return r_smoothed


def curve_speed_limit_mps(
    R: Sequence[float],
    *,
    a_y_mps2: float | Sequence[float] = 2.5,
) -> list[float]:
    """Comfort lateral speed v = √(a_y · R).

    Not a posted speed limit. On straight geometry (large R) returns a
    non-binding sentinel so min(legal, traffic, curve) ignores it.

    ``a_y_mps2`` may be a scalar or a per-sample sequence (alpine zones /
    hairpin boost).
    """
    n = len(R)
    if isinstance(a_y_mps2, (int, float)):
        ay_seq = [max(0.5, float(a_y_mps2))] * n
    else:
        ay_list = list(a_y_mps2)
        if len(ay_list) != n:
            # Broadcast / pad / trim to match R length.
            if not ay_list:
                ay_list = [2.5]
            if len(ay_list) < n:
                ay_list = ay_list + [ay_list[-1]] * (n - len(ay_list))
            else:
                ay_list = ay_list[:n]
        ay_seq = [max(0.5, float(a)) for a in ay_list]
    out: list[float] = []
    for i, r in enumerate(R):
        v = math.sqrt(ay_seq[i] * max(MIN_R_M, float(r)))
        if v >= CURVE_ACTIVE_BELOW_MPS:
            out.append(NON_BINDING_V_MPS)
        else:
            out.append(v)
    return out


def alpine_ay_profile(
    R: Sequence[float],
    a_y_base: float,
    *,
    a_y_hairpin: float | None = None,
    r_hairpin_m: float = 35.0,
    r_blend_m: float = 20.0,
) -> list[float]:
    """Per-sample a_y: boost toward ``a_y_hairpin`` on tight alpine radii.

    Straight / large-R samples keep ``a_y_base`` (curve envelope usually
    non-binding there). Hairpins (R ≲ ``r_hairpin_m``) raise lateral comfort
    so Dynamique can track AVL Route Studio curve calls without lifting the
    whole-route a_y.
    """
    base = max(0.5, float(a_y_base))
    hair = max(base, float(a_y_hairpin) if a_y_hairpin is not None else base * 1.2)
    span = max(1.0, float(r_blend_m))
    out: list[float] = []
    for r in R:
        rr = float(r)
        if rr >= r_hairpin_m:
            out.append(base)
            continue
        # R = r_hairpin → 0, R = r_hairpin - span → 1
        t = max(0.0, min(1.0, (r_hairpin_m - rr) / span))
        out.append(base + t * (hair - base))
    return out


def smooth_v_curve_spatial(
    S: Sequence[float],
    V_curve: Sequence[float],
    *,
    window_m: float = 50.0,
) -> list[float]:
    """Spatial moving average on binding curve speeds (~50–100 m).

    Non-binding samples (straights) stay non-binding unless the window
    contains binding values — then the average of those binding speeds is used.
    Softens stair-steps from polyline digitization before IDM.
    """
    n = min(len(S), len(V_curve))
    if n == 0:
        return []
    if n == 1 or window_m <= 0:
        return list(V_curve[:n])
    half = float(window_m) * 0.5
    S_arr = [float(S[i]) for i in range(n)]
    V_arr = [float(V_curve[i]) for i in range(n)]
    out: list[float] = []
    j0 = 0
    j1 = 0
    for i in range(n):
        si = S_arr[i]
        while j0 < n and S_arr[j0] < si - half:
            j0 += 1
        if j1 < j0:
            j1 = j0
        while j1 < n and S_arr[j1] <= si + half:
            j1 += 1
        binding = [
            V_arr[j]
            for j in range(j0, j1)
            if V_arr[j] < CURVE_ACTIVE_BELOW_MPS
        ]
        if binding:
            out.append(sum(binding) / len(binding))
        else:
            out.append(V_arr[i])
    return out


def smooth_envelope_spatial(
    S: Sequence[float],
    V: Sequence[float],
    *,
    window_m: float = 50.0,
) -> list[float]:
    """Spatial MA on the final envelope — enforces approximate C⁰ continuity."""
    n = min(len(S), len(V))
    if n == 0:
        return []
    if n == 1 or window_m <= 0:
        return [float(V[i]) for i in range(n)]
    half = float(window_m) * 0.5
    S_arr = [float(S[i]) for i in range(n)]
    V_arr = [float(V[i]) for i in range(n)]
    out: list[float] = []
    j0 = 0
    j1 = 0
    for i in range(n):
        si = S_arr[i]
        while j0 < n and S_arr[j0] < si - half:
            j0 += 1
        if j1 < j0:
            j1 = j0
        while j1 < n and S_arr[j1] <= si + half:
            j1 += 1
        vals = [
            V_arr[j]
            for j in range(j0, j1)
            if math.isfinite(V_arr[j]) and V_arr[j] > 0.0
        ]
        out.append(sum(vals) / len(vals) if vals else V_arr[i])
    return out


def smooth_envelope_bilateral(
    S: Sequence[float],
    V: Sequence[float],
    *,
    tau_spatial_m: float = 40.0,
    tau_range_mps: float = 2.0,
    max_kernel_m: float | None = None,
) -> list[float]:
    """P4 — Edge-preserving bilateral filter on V_envelope(S).

    C¹ smoother that averages neighbours with weights ::

        w(i, j) = exp(-(ds/τ_s)²/2) · exp(-(dv/τ_r)²/2)

    Preserves genuine speed drops (V_curve, V_legal steps) while removing
    high-frequency ripple from digitisation. Bounded kernel radius keeps
    complexity O(n·k) with k << n.
    """
    n = min(len(S), len(V))
    if n == 0:
        return []
    if n == 1:
        return [float(V[0])]
    tau_s = max(1.0, float(tau_spatial_m))
    tau_r = max(0.1, float(tau_range_mps))
    kernel = max_kernel_m if max_kernel_m is not None else 3.0 * tau_s
    S_arr = np.asarray([float(S[i]) for i in range(n)], dtype=float)
    V_arr = np.asarray([float(V[i]) for i in range(n)], dtype=float)
    out = np.empty(n, dtype=float)

    j0 = 0
    j1 = 0
    inv2s2 = 1.0 / (2.0 * tau_s * tau_s)
    inv2r2 = 1.0 / (2.0 * tau_r * tau_r)
    for i in range(n):
        si = S_arr[i]
        vi = V_arr[i]
        # Non-binding sentinel: leave untouched to keep min-envelope behaviour.
        if vi >= NON_BINDING_V_MPS * 0.5:
            out[i] = vi
            continue
        while j0 < n and (si - S_arr[j0]) > kernel:
            j0 += 1
        if j1 < j0:
            j1 = j0
        while j1 < n and (S_arr[j1] - si) <= kernel:
            j1 += 1
        weight_sum = 0.0
        acc = 0.0
        for j in range(j0, j1):
            vj = V_arr[j]
            if vj >= NON_BINDING_V_MPS * 0.5 or not math.isfinite(vj) or vj <= 0.0:
                continue
            ds = S_arr[j] - si
            dv = vj - vi
            w = math.exp(-ds * ds * inv2s2) * math.exp(-dv * dv * inv2r2)
            acc += w * vj
            weight_sum += w
        out[i] = acc / weight_sum if weight_sum > 1e-12 else vi
    return out.tolist()


def smooth_envelope_dp(
    S: Sequence[float],
    V_env: Sequence[float],
    *,
    w_fit: float = 1.0,
    w_smooth1: float = 0.6,
    w_smooth2: float = 0.35,
    v_lower_mps: float = 0.0,
) -> list[float]:
    """P4 alternative — 1D quadratic programming on v(s) via tri-diagonal solve.

    Minimises ::

        Σ w1·(v_i - V_env_i)² + w2·(v_{i+1} - v_i)² + w3·(v_{i+2} - 2·v_{i+1} + v_i)²

    Solved as a symmetric positive-definite banded linear system. C¹ output
    (quadratic derivative penalty) that stays below V_env by construction of
    the fit term. Non-binding samples are frozen at the sentinel.
    """
    n = min(len(S), len(V_env))
    if n < 3:
        return list(V_env[:n])

    S_arr = np.asarray([float(S[i]) for i in range(n)], dtype=float)
    V_arr = np.asarray([float(V_env[i]) for i in range(n)], dtype=float)

    binding = V_arr < (NON_BINDING_V_MPS * 0.5)
    if binding.sum() < 3:
        return V_arr.tolist()

    # Build A = w1·I + w2·D1ᵀD1 + w3·D2ᵀD2 with unit-spacing normalisation
    # per-segment (s changes are baked into weights).
    ds = np.diff(S_arr)
    ds = np.where(ds <= 1e-6, 1.0, ds)  # guard 0-spacing
    inv_ds = 1.0 / ds

    A = np.zeros((n, n), dtype=float)
    b = np.zeros(n, dtype=float)

    # Fit term
    fit_w = np.where(binding, float(w_fit), float(w_fit) * 1e-3)
    A[np.diag_indices(n)] += fit_w
    b += fit_w * V_arr

    # First derivative penalty  Σ w2·((v_{i+1}-v_i)·inv_ds_i)²
    for i in range(n - 1):
        w = float(w_smooth1) * inv_ds[i] * inv_ds[i]
        A[i, i] += w
        A[i + 1, i + 1] += w
        A[i, i + 1] -= w
        A[i + 1, i] -= w

    # Second derivative penalty (uses mean spacing between i, i+1, i+2)
    for i in range(n - 2):
        h = 0.5 * (ds[i] + ds[i + 1])
        w = float(w_smooth2) / (h ** 4)
        # (v_{i+2} - 2 v_{i+1} + v_i)²
        idx = [i, i + 1, i + 2]
        coeff = np.array([1.0, -2.0, 1.0], dtype=float)
        for a_i, ai in enumerate(idx):
            for b_i, bi in enumerate(idx):
                A[ai, bi] += w * coeff[a_i] * coeff[b_i]

    try:
        v_new = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        return V_arr.tolist()

    # Never exceed the original envelope (binding samples only) and honour a lower bound.
    v_new = np.where(binding, np.minimum(v_new, V_arr), V_arr)
    v_new = np.maximum(v_new, float(v_lower_mps))
    return v_new.tolist()


def envelope_max_gradient_kmh_per_m(
    S: Sequence[float],
    V_mps: Sequence[float],
) -> float:
    """Max |ΔV|/Δs in km/h per metre (validation: must stay ≤ 2)."""
    n = min(len(S), len(V_mps))
    if n < 2:
        return 0.0
    worst = 0.0
    for i in range(1, n):
        ds = abs(float(S[i]) - float(S[i - 1]))
        if ds < 1e-6:
            continue
        dv_kmh = abs(float(V_mps[i]) - float(V_mps[i - 1])) * 3.6
        worst = max(worst, dv_kmh / ds)
    return float(worst)


def braking_feasible_speed(
    S: Sequence[float],
    V: Sequence[float],
    *,
    b_plan_mps2: float = 2.0,
) -> list[float]:
    """Backward fill: V[i] ≤ speed that can still brake to V[i+1] at b_plan.

    Removes envelope \"walls\" that force bang-bang look-ahead: the target
    speed profile already encodes a comfortable deceleration corridor.
    """
    n = min(len(S), len(V))
    if n == 0:
        return []
    b = max(0.3, float(b_plan_mps2))
    out = [float(V[i]) for i in range(n)]
    for i in range(n - 2, -1, -1):
        ds = max(float(S[i + 1]) - float(S[i]), 1e-3)
        v_next = max(0.0, out[i + 1])
        v_cap = math.sqrt(max(0.0, v_next * v_next + 2.0 * b * ds))
        if out[i] < NON_BINDING_V_MPS * 0.5:
            out[i] = min(out[i], v_cap)
        else:
            # Non-binding / huge sentinel — still cap if next is binding
            if v_next < CURVE_ACTIVE_BELOW_MPS:
                out[i] = min(out[i], v_cap)
    return out
