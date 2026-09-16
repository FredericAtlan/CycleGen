#!/usr/bin/env python3
"""Recette N90 — validate CycleGen kinematic pipeline against AVL CRUISE.

Loads the bundled AVL N90 (BSM→Albertville) reference, synthesises a corridor
from its own geometry/slope/speed-limit, then runs the calibration grid.

Target metrics (per ``docs/avl_n90_cinematic_upgrade``):
  - RMSE_v          ≤ 2.5   m/s
  - RMSE_a          ≤ 0.25  m/s²
  - |ΔT_total|      ≤ 3     %
  - p95 |jerk|      ≤ 0.8   m/s³

Prints a green ✔ per target met, red ✘ per miss.

Usage:
    cd backend && ../.venv/bin/python ../scripts/recette_n90.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow running from repo root or backend/
_HERE = Path(__file__).resolve().parent
_BACKEND = _HERE.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.models.schemas import DriverProfile  # noqa: E402
from app.services.n90_calibrator import (  # noqa: E402
    run_n90_calibration,
    synth_corridor_from_reference,
)

TARGETS = {
    "rmse_v": 2.5,
    "rmse_a": 0.25,
    "delta_duration_pct_abs": 3.0,
    "p95_jerk": 0.8,
}


def _ok(v: bool) -> str:
    return "\033[32m✔\033[0m" if v else "\033[31m✘\033[0m"


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true", help="Small grid (~8 arms) for smoke test.")
    ap.add_argument("--a-y", type=float, default=3.5, help="Comfort lateral accel (m/s²)")
    args = ap.parse_args()

    print("Recette N90 — building corridor from AVL reference…", flush=True)
    corridor = synth_corridor_from_reference(reference_id="avl_n90_bcb", a_y_mps2=args.a_y)
    print(
        f"  corridor: {len(corridor.S)} samples, "
        f"L = {corridor.S[-1] / 1000:.2f} km, "
        f"α ∈ [{min(corridor.alpha):.4f}, {max(corridor.alpha):.4f}] rad, "
        f"a_y = {args.a_y} m/s²",
        flush=True,
    )

    if args.quick:
        grid_kwargs = dict(
            a_max_grid=[2.0, 2.6],
            b_comf_grid=[2.0],
            T_grid=[1.5],
            T_h_grid=[4.0],
            s0_grid=[2.0],
            jerk_max_grid=[1.5],
            jerk_brake_max_grid=[3.0],
            speed_factor_grid=[1.05, 1.15],
        )
    else:
        grid_kwargs = dict(
            a_max_grid=[2.0, 2.6, 3.2],
            b_comf_grid=[1.6, 2.0, 2.6],
            T_grid=[1.2, 1.5],
            T_h_grid=[3.5, 4.5],
            s0_grid=[2.0],
            jerk_max_grid=[1.5],
            jerk_brake_max_grid=[3.0],
            speed_factor_grid=[1.05, 1.15, 1.25],
        )

    print(
        f"Running calibration grid ({'quick' if args.quick else 'full'} — expect "
        f"{'~1 min' if args.quick else '~5–10 min'})…",
        flush=True,
    )
    result = run_n90_calibration(
        corridor=corridor,
        corridor_id="recette-n90",
        reference_id="avl_n90_bcb",
        driver_profile=DriverProfile.NORMAL,
        seed=42,
        lambda_a=4.0,
        mu_dt=0.08,
        max_arms=64,
        **grid_kwargs,
    )
    best = result["arms"][0]
    print(f"\nBest arm: {best.id}")
    print(f"  score          = {best.score:.4f}")
    print(f"  RMSE_v         = {best.rmse_v:.3f} m/s     (target ≤ {TARGETS['rmse_v']})")
    print(f"  RMSE_a         = {best.rmse_a:.3f} m/s²    (target ≤ {TARGETS['rmse_a']})")
    print(
        f"  ΔT_total       = {best.delta_duration_s:+.1f} s "
        f"({best.delta_duration_pct:+.2f} %)  (target |·| ≤ {TARGETS['delta_duration_pct_abs']} %)"
    )
    if best.p95_abs_jerk is not None:
        print(f"  p95 |jerk|     = {best.p95_abs_jerk:.3f} m/s³  (target ≤ {TARGETS['p95_jerk']})")
    print(f"  Δdistance      = {best.delta_distance_m:+.0f} m")

    print("\nAcceptance:")
    hits = {
        "RMSE_v ≤ 2.5":     best.rmse_v <= TARGETS["rmse_v"],
        "RMSE_a ≤ 0.25":    best.rmse_a <= TARGETS["rmse_a"],
        "|ΔT_total| ≤ 3 %": abs(best.delta_duration_pct) <= TARGETS["delta_duration_pct_abs"],
    }
    if best.p95_abs_jerk is not None:
        hits["p95 |jerk| ≤ 0.8"] = best.p95_abs_jerk <= TARGETS["p95_jerk"]

    for label, ok in hits.items():
        print(f"  {_ok(ok)} {label}")

    print("\nRecommended DriverPhysics (paste into UI overrides):")
    print(json.dumps(result["recommended"].model_dump(), indent=2))
    print(f"\nReport written to: {result['written_json']}\n              & {result['written_markdown']}")

    return 0 if all(hits.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
