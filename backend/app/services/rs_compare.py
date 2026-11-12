"""Route Studio compare / fidelity — pure functions."""

from __future__ import annotations

import math
from typing import Any


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else float("nan")


def fidelity_score(
    rmse_v_kmh: float,
    delta_duration_pct: float,
    *,
    osc: float = 0.0,
) -> float:
    """Composite 0–100 score (same spirit as batch refit scripts)."""
    s = 100.0
    s -= min(40.0, abs(rmse_v_kmh) * 1.6)
    s -= min(25.0, abs(delta_duration_pct) * 0.8)
    s -= min(20.0, abs(osc) * 8.0)
    return round(max(0.0, min(100.0, s)), 2)


def align_velocity_kmh(
    t_ref: list[float],
    v_ref_mps: list[float],
    t_cg: list[float],
    v_cg_mps: list[float],
) -> tuple[list[float], list[float], list[float]]:
    """Resample CG velocity onto reference time grid (linear)."""
    n = min(len(t_ref), len(v_ref_mps))
    if n < 2 or len(t_cg) < 2:
        raise ValueError("need ≥2 samples on both series")
    t_r = [float(x) for x in t_ref[:n]]
    v_r = [float(x) * 3.6 for x in v_ref_mps[:n]]
    t_c = [float(x) for x in t_cg]
    v_c = [float(x) * 3.6 for x in v_cg_mps]
    out: list[float] = []
    j = 0
    for ti in t_r:
        while j + 1 < len(t_c) and t_c[j + 1] < ti:
            j += 1
        if j + 1 >= len(t_c):
            out.append(v_c[-1])
            continue
        t0, t1 = t_c[j], t_c[j + 1]
        if t1 <= t0:
            out.append(v_c[j])
            continue
        w = (ti - t0) / (t1 - t0)
        out.append(v_c[j] * (1 - w) + v_c[j + 1] * w)
    return t_r, v_r, out


def oscillation_index(v_kmh: list[float]) -> float:
    """Mean |Δv| / mean v — HF pumping proxy."""
    if len(v_kmh) < 3:
        return 0.0
    dvs = [abs(v_kmh[i] - v_kmh[i - 1]) for i in range(1, len(v_kmh))]
    mean_v = _mean([abs(x) for x in v_kmh if abs(x) > 1.0])
    if not math.isfinite(mean_v) or mean_v < 1e-3:
        return 0.0
    return float(_mean(dvs) / mean_v)


def score_profiles(
    *,
    t_ref: list[float],
    v_ref_mps: list[float],
    t_cg: list[float],
    v_cg_mps: list[float],
) -> dict[str, Any]:
    t, v_r, v_c = align_velocity_kmh(t_ref, v_ref_mps, t_cg, v_cg_mps)
    err = [(v_c[i] - v_r[i]) ** 2 for i in range(len(t))]
    mae = [abs(v_c[i] - v_r[i]) for i in range(len(t))]
    bias = [v_c[i] - v_r[i] for i in range(len(t))]
    rmse = math.sqrt(_mean(err)) if err else float("nan")
    dur_r = t[-1] - t[0] if len(t) > 1 else 0.0
    dur_c = (t_cg[-1] - t_cg[0]) if len(t_cg) > 1 else 0.0
    dT_pct = 100.0 * (dur_c - dur_r) / dur_r if dur_r > 1e-3 else 0.0
    osc = oscillation_index(v_c)
    score = fidelity_score(rmse, dT_pct, osc=osc)
    return {
        "n": len(t),
        "rmse_v_kmh": round(rmse, 3),
        "mae_v_kmh": round(_mean(mae), 3),
        "bias_v_kmh": round(_mean(bias), 3),
        "delta_duration_pct": round(dT_pct, 3),
        "duration_ref_s": round(dur_r, 2),
        "duration_cg_s": round(dur_c, 2),
        "osc": round(osc, 4),
        "fidelity_score": score,
    }
