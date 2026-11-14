"""Benchmark comparison: 1 Hz alignment, KPIs, recalibration hints."""

from __future__ import annotations

from typing import Any, Literal

import numpy as np


AlignMode = Literal["time", "distance"]


def _as_array(values: list[float] | np.ndarray | None) -> np.ndarray:
    if values is None:
        return np.array([], dtype=float)
    return np.asarray(values, dtype=float)


def _count_stops(v: np.ndarray, t: np.ndarray, *, thresh: float = 0.5) -> tuple[int, float]:
    """Return (stop_event_count, stopped_time_ratio) for v < thresh lasting ≥ 1 s."""
    if len(v) == 0 or len(t) == 0:
        return 0, 0.0
    stopped = v < thresh
    if len(t) > 1:
        dt = np.diff(t)
        stop_time = float(np.sum(dt[stopped[:-1]]))
        total = float(t[-1] - t[0]) if t[-1] > t[0] else float(len(t))
        ratio = stop_time / total if total > 0 else 0.0
    else:
        ratio = 1.0 if bool(stopped[0]) else 0.0

    events = 0
    i = 0
    n = len(stopped)
    while i < n:
        if not stopped[i]:
            i += 1
            continue
        j = i + 1
        while j < n and stopped[j]:
            j += 1
        end_t = float(t[j - 1]) if j - 1 < n else float(t[i])
        dur = end_t - float(t[i])
        # Inclusive span: add one sample step when uniform 1 Hz
        if j < n:
            dur = float(t[j] - t[i])
        elif len(t) > 1:
            dur = float(t[j - 1] - t[i]) + float(t[1] - t[0])
        if dur >= 0.99:
            events += 1
        i = j
    return events, ratio


def _trapz(y: np.ndarray, x: np.ndarray) -> float:
    if len(y) < 2:
        return 0.0
    return float(np.trapezoid(y, x) if hasattr(np, "trapezoid") else np.trapz(y, x))


def _accel_from_profile(
    profile: dict[str, Any], t: np.ndarray, v: np.ndarray
) -> np.ndarray:
    accel = profile.get("acceleration")
    if accel is not None and len(accel) == len(v):
        return _as_array(accel)
    if len(t) < 2:
        return np.zeros(1)
    dv = np.diff(v)
    dt = np.diff(t)
    dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
    return dv / dt


def _build_hints(kpis: dict[str, float | int]) -> list[str]:
    hints: list[str] = []
    bias = float(kpis["bias_v"])
    if bias > 1.5:
        hints.append(
            "Positive speed bias (>+1.5 m/s): try Eco driver profile, lower "
            "speed_factor / IDM desired speed, or check traffic envelope."
        )
    elif bias < -1.5:
        hints.append(
            "Negative speed bias (<-1.5 m/s): vehicle runs slower than reference — "
            "check congestion fallback, curve a_y, or overly cautious IDM."
        )

    stops_gen = int(kpis["stops_gen"])
    stops_ref = int(kpis["stops_ref"])
    if stops_ref > 0 and stops_gen < stops_ref * 0.7:
        hints.append(
            "Too few stops vs reference: review TLS stochasticity / green-wave "
            "rules or intersection density on the corridor."
        )
    elif stops_ref > 0 and stops_gen > stops_ref * 1.3:
        hints.append(
            "Too many stops vs reference: red lights may be over-triggered — "
            "relax TLS seed policy or arterial green-wave spacing."
        )

    p95_g = float(kpis["p95_abs_accel_gen"])
    p95_r = float(kpis["p95_abs_accel_ref"])
    if p95_r > 1e-6 and p95_g > p95_r * 1.3:
        hints.append(
            "Nervous dynamics (p95 |a| high): reduce Markov noise intensity "
            "or IDM a_max / increase b_comf."
        )
    elif p95_r > 1e-6 and p95_g < p95_r * 0.7:
        hints.append(
            "Dynamics too smooth vs reference: increase aggressiveness "
            "(Agressif profile / Markov) carefully."
        )

    if abs(float(kpis["delta_duration_pct"])) > 40.0:
        hints.append(
            "Duration differs by >40%: time-aligned RMSE mixes dissimilar "
            "schedules — prefer distributional KPIs or a same-route GPS reference."
        )
    return hints


def compute_comparison(
    profile: dict[str, Any],
    reference: dict[str, Any],
    *,
    align: AlignMode = "time",
) -> dict[str, Any]:
    time_gen = _as_array(profile.get("time"))
    v_gen = _as_array(profile.get("velocity"))
    s_gen_raw = profile.get("position")
    s_gen = _as_array(s_gen_raw)
    time_ref = _as_array(reference.get("time"))
    v_ref = _as_array(reference.get("velocity"))
    s_ref_raw = reference.get("position")
    s_ref = _as_array(s_ref_raw)

    if len(time_gen) == 0 or len(v_gen) == 0:
        raise ValueError("Generated profile is empty or invalid.")
    if len(time_ref) == 0 or len(v_ref) == 0:
        raise ValueError("Reference series is empty or invalid.")

    warnings: list[str] = []
    has_s_gen = len(s_gen) == len(v_gen) and len(s_gen) > 1
    has_s_ref = len(s_ref) == len(v_ref) and len(s_ref) > 1

    # Distances (full series)
    if has_s_gen:
        dist_gen = float(s_gen[-1] - s_gen[0])
    else:
        dist_gen = _trapz(v_gen, time_gen)
        if len(time_gen) > 1:
            s_gen = np.concatenate(
                [[0.0], np.cumsum(v_gen[:-1] * np.diff(time_gen))]
            )
        else:
            s_gen = np.zeros_like(v_gen)

    if has_s_ref:
        dist_ref = float(s_ref[-1] - s_ref[0])
    else:
        dist_ref = _trapz(v_ref, time_ref)
        if len(time_ref) > 1:
            s_ref = np.concatenate(
                [[0.0], np.cumsum(v_ref[:-1] * np.diff(time_ref))]
            )
        else:
            s_ref = np.zeros_like(v_ref)

    duration_gen = float(time_gen[-1] - time_gen[0]) if len(time_gen) else 0.0
    duration_ref = float(time_ref[-1] - time_ref[0]) if len(time_ref) else 0.0
    delta_duration_s = duration_gen - duration_ref
    delta_duration_pct = (
        (delta_duration_s / duration_ref * 100.0) if duration_ref > 0 else 0.0
    )
    delta_distance_m = dist_gen - dist_ref
    delta_distance_pct = (
        (delta_distance_m / dist_ref * 100.0) if dist_ref > 0 else 0.0
    )

    s_common: np.ndarray | None = None
    if align == "distance":
        if not (has_s_gen and has_s_ref):
            warnings.append(
                "Distance alignment unavailable (missing position); fell back to time."
            )
            align = "time"
        else:
            s_max = min(float(s_gen[-1]), float(s_ref[-1]))
            if s_max <= 1.0:
                warnings.append("Distance overlap too short; fell back to time.")
                align = "time"
            else:
                # ~1 m step, capped
                step = max(1.0, s_max / 2000.0)
                s_common = np.arange(0.0, s_max + step * 0.5, step)
                # Map s → v via time-parameterized interp on s
                v_gen_i = np.interp(s_common, s_gen, v_gen)
                v_ref_i = np.interp(s_common, s_ref, v_ref)
                # Synthetic time axis for chart: cumulative ds/v
                with np.errstate(divide="ignore", invalid="ignore"):
                    speed = np.maximum(v_gen_i, 0.1)
                    ds = np.diff(s_common, prepend=s_common[0])
                    ds[0] = 0.0
                    t_common = np.cumsum(ds / speed)
                v_gen_interp = v_gen_i
                v_ref_interp = v_ref_i

    if align == "time":
        t0_g, t0_r = float(time_gen[0]), float(time_ref[0])
        # Normalize to start at 0 for shared window
        tg = time_gen - t0_g
        tr = time_ref - t0_r
        t_max = min(float(tg[-1]), float(tr[-1]))
        if t_max < 1.0:
            raise ValueError("Overlapping duration < 1 s — cannot align.")
        t_common = np.arange(0.0, np.floor(t_max) + 1.0, 1.0)
        v_gen_interp = np.interp(t_common, tg, v_gen)
        v_ref_interp = np.interp(t_common, tr, v_ref)
        if abs(delta_duration_pct) > 25.0:
            warnings.append(
                "Large duration mismatch: RMSE uses shared [0, min(T)] window only."
            )

    diff = v_gen_interp - v_ref_interp
    rmse_v = float(np.sqrt(np.mean(diff**2)))
    mae_v = float(np.mean(np.abs(diff)))
    bias_v = float(np.mean(diff))

    stops_gen, stop_ratio_gen = _count_stops(v_gen, time_gen)
    stops_ref, stop_ratio_ref = _count_stops(v_ref, time_ref)

    accel_gen = _accel_from_profile(profile, time_gen, v_gen)
    accel_ref = _accel_from_profile(
        {"acceleration": None}, time_ref, v_ref
    )
    mean_abs_accel_gen = float(np.mean(np.abs(accel_gen))) if len(accel_gen) else 0.0
    mean_abs_accel_ref = float(np.mean(np.abs(accel_ref))) if len(accel_ref) else 0.0
    p95_abs_accel_gen = (
        float(np.percentile(np.abs(accel_gen), 95)) if len(accel_gen) else 0.0
    )
    p95_abs_accel_ref = (
        float(np.percentile(np.abs(accel_ref), 95)) if len(accel_ref) else 0.0
    )

    kpis: dict[str, float | int] = {
        "rmse_v": rmse_v,
        "mae_v": mae_v,
        "bias_v": bias_v,
        "delta_duration_pct": float(delta_duration_pct),
        "delta_duration_s": float(delta_duration_s),
        "delta_distance_pct": float(delta_distance_pct),
        "delta_distance_m": float(delta_distance_m),
        "stops_gen": int(stops_gen),
        "stops_ref": int(stops_ref),
        "stop_time_ratio_gen": float(stop_ratio_gen),
        "stop_time_ratio_ref": float(stop_ratio_ref),
        "mean_abs_accel_gen": mean_abs_accel_gen,
        "mean_abs_accel_ref": mean_abs_accel_ref,
        "p95_abs_accel_gen": p95_abs_accel_gen,
        "p95_abs_accel_ref": p95_abs_accel_ref,
    }

    hints = _build_hints(kpis)

    out: dict[str, Any] = {
        "align": align,
        "times": t_common.tolist(),
        "v_gen": v_gen_interp.tolist(),
        "v_ref": v_ref_interp.tolist(),
        "s_gen": s_common.tolist() if s_common is not None else None,
        "s_ref": s_common.tolist() if s_common is not None else None,
        "kpis": kpis,
        "recalibration_hints": hints,
        "ref_has_geo": bool(reference.get("has_geo")),
        "lat_ref": reference.get("lat"),
        "lon_ref": reference.get("lon"),
        "warnings": warnings,
    }
    return out
