"""Standalone profile KPIs (stops, RPA, accel) for scenario compare."""

from __future__ import annotations

from typing import Any

import numpy as np

from app.services.benchmark_metrics import _as_array, _count_stops, _trapz


G_EARTH = 9.80665


def relative_positive_acceleration(
    time_s: np.ndarray,
    velocity: np.ndarray,
    acceleration: np.ndarray | None = None,
) -> float:
    """RPA = Σ (a⁺ · v · Δt) / distance  [m/s²]."""
    t = _as_array(time_s)
    v = _as_array(velocity)
    if len(t) < 2 or len(v) < 2:
        return 0.0
    if acceleration is not None and len(acceleration) == len(v):
        a = _as_array(acceleration)
    else:
        dt = np.diff(t)
        dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
        a = np.concatenate([[0.0], np.diff(v) / dt])
    dist = _trapz(v, t)
    if dist <= 1e-3:
        return 0.0
    # Use mid-interval contributions
    a_pos = np.maximum(a[:-1], 0.0)
    v_mid = 0.5 * (v[:-1] + v[1:])
    dt = np.diff(t)
    numer = float(np.sum(a_pos * v_mid * dt))
    return numer / dist


def profile_kpis(profile: dict[str, Any]) -> dict[str, float | int]:
    """Aggregate kinematics KPIs for a single ConsolidatedProfile-like dict."""
    t = _as_array(profile.get("time"))
    v = _as_array(profile.get("velocity"))
    s = _as_array(profile.get("position"))
    a = _as_array(profile.get("acceleration")) if profile.get("acceleration") is not None else None

    if len(t) == 0 or len(v) == 0:
        return {
            "duration_s": 0.0,
            "distance_m": 0.0,
            "mean_speed_mps": 0.0,
            "mean_speed_kmh": 0.0,
            "stops": 0,
            "stop_time_ratio": 0.0,
            "mean_abs_accel": 0.0,
            "p95_abs_accel": 0.0,
            "rpa": 0.0,
            "max_abs_accel": float(profile.get("max_abs_accel") or 0.0),
            "max_abs_accel_g": float(profile.get("max_abs_accel_g") or 0.0),
            "markov_gate_fraction": float(profile.get("markov_gate_fraction") or 0.0),
            "clip_hit_count": int(profile.get("clip_hit_count") or 0),
        }

    duration = float(t[-1] - t[0]) if len(t) > 1 else 0.0
    if len(s) == len(v) and len(s) > 1:
        distance = float(max(0.0, s[-1] - s[0]))
    else:
        distance = _trapz(v, t)

    mean_v = float(distance / duration) if duration > 1e-6 else 0.0
    stops, stop_ratio = _count_stops(v, t)

    if a is None or len(a) != len(v):
        if len(t) >= 2:
            dt = np.diff(t)
            dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
            a = np.concatenate([[0.0], np.diff(v) / dt])
        else:
            a = np.zeros_like(v)

    abs_a = np.abs(a)
    mean_abs = float(np.mean(abs_a)) if len(abs_a) else 0.0
    p95 = float(np.percentile(abs_a, 95)) if len(abs_a) else 0.0
    max_abs = float(np.max(abs_a)) if len(abs_a) else 0.0
    if profile.get("max_abs_accel") is not None:
        max_abs = float(profile["max_abs_accel"])
    max_g = float(profile.get("max_abs_accel_g") or (max_abs / G_EARTH))

    rpa = relative_positive_acceleration(t, v, a)

    return {
        "duration_s": duration,
        "distance_m": distance,
        "mean_speed_mps": mean_v,
        "mean_speed_kmh": mean_v * 3.6,
        "stops": int(stops),
        "stop_time_ratio": float(stop_ratio),
        "mean_abs_accel": mean_abs,
        "p95_abs_accel": p95,
        "rpa": float(rpa),
        "max_abs_accel": max_abs,
        "max_abs_accel_g": max_g,
        "markov_gate_fraction": float(profile.get("markov_gate_fraction") or 0.0),
        "clip_hit_count": int(profile.get("clip_hit_count") or 0),
    }


def compare_profile_arms(
    arms: list[dict[str, Any]],
    *,
    reference_id: str | None = None,
) -> dict[str, Any]:
    """Compare multiple named arms; deltas vs reference arm (default first / Normal)."""
    if not arms:
        return {"arms": [], "reference_id": None, "deltas": {}}

    enriched = []
    for arm in arms:
        pid = str(arm.get("id") or arm.get("label") or "")
        kpis = profile_kpis(arm.get("profile") or arm)
        enriched.append(
            {
                "id": pid,
                "label": str(arm.get("label") or pid),
                "kpis": kpis,
                "time": list((arm.get("profile") or arm).get("time") or []),
                "velocity": list((arm.get("profile") or arm).get("velocity") or []),
            }
        )

    ref_id = reference_id
    if ref_id is None:
        for cand in ("normal", "Normal", "night", "Night"):
            hit = next((a for a in enriched if a["id"] == cand or a["label"] == cand), None)
            if hit:
                ref_id = hit["id"]
                break
        if ref_id is None:
            ref_id = enriched[0]["id"]

    ref = next((a for a in enriched if a["id"] == ref_id), enriched[0])
    deltas: dict[str, dict[str, float]] = {}
    for arm in enriched:
        if arm["id"] == ref["id"]:
            continue
        rk, ak = ref["kpis"], arm["kpis"]
        deltas[arm["id"]] = {
            "delta_duration_s": float(ak["duration_s"]) - float(rk["duration_s"]),
            "delta_stops": float(ak["stops"]) - float(rk["stops"]),
            "delta_mean_speed_kmh": float(ak["mean_speed_kmh"])
            - float(rk["mean_speed_kmh"]),
            "delta_rpa": float(ak["rpa"]) - float(rk["rpa"]),
            "delta_p95_abs_accel": float(ak["p95_abs_accel"])
            - float(rk["p95_abs_accel"]),
        }

    return {"arms": enriched, "reference_id": ref["id"], "deltas": deltas}
