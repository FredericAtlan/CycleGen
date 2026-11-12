"""Geometry-lock IDM fit grid — pure logic (no threading / FastAPI).

Used by ``rs_jobs`` async runner and CLI wrappers.
"""

from __future__ import annotations

from typing import Any, Callable

from app.models.schemas import SpatialCorridor
from app.services.kinematic_solver import IDMSolver
from app.services.rs_compare import score_profiles


def ensure_pedal_defaults(params: dict[str, float]) -> dict[str, float]:
    out = dict(params)
    for k in ("pedal_tau_s", "vdes_tau_s", "descent_hold_gain"):
        out.setdefault(k, 0.0)
    return out


def fit_variants(base: dict[str, float]) -> list[tuple[str, dict[str, float]]]:
    """Small explicit grid — interactive jobs (not Maximus offline)."""
    base = ensure_pedal_defaults(base)
    a = float(base.get("a_max", 2.0))
    b = float(base.get("b_comf", 2.0))
    sf = float(base.get("speed_factor", 1.05))
    pedal = float(base.get("pedal_tau_s", 0.0))
    jerk = float(base.get("jerk_max", 1.5))
    return [
        ("base", {**base}),
        ("pedal_soft", {**base, "pedal_tau_s": max(pedal, 0.35)}),
        ("a_soft", {**base, "a_max": a * 0.92, "jerk_max": jerk * 0.9}),
        ("b_soft", {**base, "b_comf": b * 0.92}),
        ("sf_lo", {**base, "speed_factor": max(0.7, sf * 0.98)}),
        ("sf_hi", {**base, "speed_factor": min(1.35, sf * 1.02)}),
    ]


def run_geometry_lock_fit(
    *,
    corridor: SpatialCorridor,
    t_ref: list[float],
    v_ref: list[float],
    driver_profile: str = "Normal",
    driver_params: dict[str, float] | None = None,
    seed: int = 0,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    """Run IDM variants vs reference series; return best + arms."""
    if len(t_ref) != len(v_ref) or len(t_ref) < 3:
        raise ValueError("t_ref / v_ref length mismatch or too short")
    base_params = ensure_pedal_defaults(dict(driver_params or {}))
    variants = fit_variants(base_params)
    arms: list[dict[str, Any]] = []
    for i, (name, params) in enumerate(variants):
        if on_progress:
            on_progress((i + 0.2) / len(variants), f"variant {name}")
        solver = IDMSolver(
            corridor,
            driver_profile,
            seed=int(seed),
            param_overrides=params,
            enable_markov=False,
        )
        prof = solver.solve()
        sc = score_profiles(
            t_ref=t_ref,
            v_ref_mps=v_ref,
            t_cg=list(prof.time),
            v_cg_mps=list(prof.velocity),
        )
        arms.append(
            {
                "variant": name,
                "params": params,
                "compare": sc,
                "duration_s": prof.total_duration_s,
                "v_mean_kmh": prof.average_speed_kmh,
            }
        )
        if on_progress:
            on_progress((i + 1) / len(variants), f"done {name}")

    best = min(
        arms,
        key=lambda a: (
            a["compare"]["rmse_v_kmh"] + 4 * a["compare"]["osc"],
            -a["compare"]["fidelity_score"],
        ),
    )
    return {
        "best": best,
        "arms": arms,
        "n_variants": len(arms),
        "method": "geometry_lock_idm_grid",
    }
