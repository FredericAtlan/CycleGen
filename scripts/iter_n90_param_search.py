#!/usr/bin/env python3
"""Iterative N90 parameter search vs AVL — save full dataset for review.

Phases:
  1. Coarse grid around BCB
  2. Refine ± around top-K of phase 1
  3. Final micro-grid on the winner

Writes under ``backend/app/data/benchmark/calibration/``:
  - ``n90_iter_search_<stamp>.csv``  — one row per arm (all iterations)
  - ``n90_iter_search_<stamp>.json`` — full report + best params
  - ``latest_n90_iter.csv`` / ``latest_n90_iter.json`` — aliases
  - ``latest_n90_recommended.json`` — plug-and-play DriverPhysics only

Usage:
  cd backend && .venv/bin/python ../scripts/iter_n90_param_search.py
  cd backend && .venv/bin/python ../scripts/iter_n90_param_search.py --quick
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.models.schemas import DriverProfile  # noqa: E402
from app.services.benchmark_loader import load_reference  # noqa: E402
from app.services.benchmark_metrics import compute_comparison  # noqa: E402
from app.services.kinematic_solver import IDMSolver  # noqa: E402
from app.services.n90_calibrator import (  # noqa: E402
    CALIBRATION_DIR,
    synth_corridor_from_reference,
)

# BCB baseline (UI Standard AVL)
BCB = {
    "a_max": 2.58,
    "b_comf": 1.71,
    "T": 1.4,
    "T_h": 4.0,
    "s0": 2.5,
    "jerk_max": 0.96,
    "jerk_brake_max": 2.93,
    "speed_factor": 1.05,
}

PARAM_KEYS = list(BCB.keys())

CSV_COLUMNS = [
    "iter",
    "phase",
    "arm_id",
    "rank_in_phase",
    *PARAM_KEYS,
    "rmse_v",
    "rmse_v_kmh",
    "rmse_a",
    "delta_duration_pct",
    "delta_duration_s",
    "bias_v_mps",
    "mean_v_kmh",
    "max_v_kmh",
    "duration_s",
    "p95_abs_jerk",
    "score",
]


def _score(rmse_v: float, rmse_a: float, d_t_pct: float, *, lam: float, mu: float) -> float:
    return float(rmse_v) + lam * float(rmse_a) + mu * abs(float(d_t_pct))


def _arm_id(params: dict[str, float]) -> str:
    return (
        f"a{params['a_max']:.3f}_b{params['b_comf']:.3f}"
        f"_T{params['T']:.3f}_Th{params['T_h']:.2f}"
        f"_s0{params['s0']:.2f}_jm{params['jerk_max']:.2f}"
        f"_jb{params['jerk_brake_max']:.2f}_sf{params['speed_factor']:.3f}"
    )


def _unique_grid(values: list[float], ndigits: int = 4) -> list[float]:
    seen: set[float] = set()
    out: list[float] = []
    for v in values:
        r = round(float(v), ndigits)
        if r not in seen:
            seen.add(r)
            out.append(r)
    return sorted(out)


def _product_params(grids: dict[str, list[float]]) -> list[dict[str, float]]:
    keys = list(grids.keys())
    combos = itertools.product(*(grids[k] for k in keys))
    return [dict(zip(keys, c)) for c in combos]


def evaluate_arm(
    *,
    corridor,
    ref: dict[str, Any],
    params: dict[str, float],
    seed: int,
    lam: float,
    mu: float,
) -> dict[str, Any]:
    solver = IDMSolver(
        corridor,
        DriverProfile.NORMAL,
        seed=seed,
        param_overrides=params,
        tls_override="green_wave",
    )
    profile = solver.solve()
    pd = profile.model_dump()
    cmp = compute_comparison(pd, ref, align="time")
    k = cmp["kpis"]

    t_common = np.asarray(cmp["times"], dtype=float)
    t_gen = np.asarray(pd["time"], dtype=float)
    a_gen = np.asarray(pd["acceleration"], dtype=float)
    t_ref = np.asarray(ref["time"], dtype=float)
    a_ref_raw = ref.get("acceleration")
    if a_ref_raw is not None and len(a_ref_raw) == len(t_ref):
        a_ref = np.asarray(a_ref_raw, dtype=float)
    else:
        v_ref = np.asarray(ref["velocity"], dtype=float)
        dt = np.diff(t_ref)
        dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
        a_ref = np.concatenate([[0.0], np.diff(v_ref) / dt])
    a_gi = np.interp(t_common, t_gen, a_gen)
    a_ri = np.interp(t_common, t_ref, a_ref)
    rmse_a = float(np.sqrt(np.mean((a_gi - a_ri) ** 2)))

    if len(t_gen) > 2:
        dt = np.diff(t_gen)
        dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
        p95j = float(np.percentile(np.abs(np.diff(a_gen) / dt), 95))
    else:
        p95j = 0.0

    rmse_v = float(k["rmse_v"])
    d_t = float(k["delta_duration_pct"])
    row = {
        "arm_id": _arm_id(params),
        **{k: float(params[k]) for k in PARAM_KEYS},
        "rmse_v": rmse_v,
        "rmse_v_kmh": rmse_v * 3.6,
        "rmse_a": rmse_a,
        "delta_duration_pct": d_t,
        "delta_duration_s": float(k["delta_duration_s"]),
        "bias_v_mps": float(k["bias_v"]),
        "mean_v_kmh": float(pd["average_speed_kmh"]),
        "max_v_kmh": float(max(pd["velocity"]) * 3.6),
        "duration_s": float(pd["total_duration_s"]),
        "p95_abs_jerk": p95j,
        "score": _score(rmse_v, rmse_a, d_t, lam=lam, mu=mu),
    }
    return row


def phase_coarse(*, quick: bool) -> dict[str, list[float]]:
    if quick:
        return {
            "a_max": [2.0, 2.58, 3.0],
            "b_comf": [1.5, 1.71, 2.2],
            "T": [1.2, 1.4],
            "T_h": [3.5, 4.5],
            "s0": [2.0, 2.5],
            "jerk_max": [0.96, 1.5],
            "jerk_brake_max": [2.5, 2.93],
            "speed_factor": [0.98, 1.05, 1.10],
        }
    return {
        "a_max": [1.8, 2.2, 2.58, 2.9, 3.2],
        "b_comf": [1.4, 1.71, 2.0, 2.4],
        "T": [1.1, 1.4, 1.7],
        "T_h": [3.0, 4.0, 5.0],
        "s0": [2.0, 2.5],
        "jerk_max": [0.7, 0.96, 1.5],
        "jerk_brake_max": [2.0, 2.93, 3.5],
        "speed_factor": [0.95, 1.00, 1.05, 1.08, 1.12],
    }


def phase_refine(best: dict[str, Any], *, quick: bool) -> dict[str, list[float]]:
    """Local neighborhood around a winner — only vary high-impact knobs."""

    def nbr(key: str, step: float, n: int = 2) -> list[float]:
        c = float(best[key])
        vals = [c + i * step for i in range(-n, n + 1)]
        return _unique_grid(vals)

    # Freeze low-sensitivity knobs to keep Cartesian product tractable.
    if quick:
        return {
            "a_max": nbr("a_max", 0.15, 1),
            "b_comf": nbr("b_comf", 0.15, 1),
            "T": [float(best["T"])],
            "T_h": nbr("T_h", 0.4, 1),
            "s0": [float(best["s0"])],
            "jerk_max": [float(best["jerk_max"])],
            "jerk_brake_max": [float(best["jerk_brake_max"])],
            "speed_factor": nbr("speed_factor", 0.02, 1),
        }
    return {
        "a_max": nbr("a_max", 0.12, 2),
        "b_comf": nbr("b_comf", 0.12, 2),
        "T": nbr("T", 0.1, 1),
        "T_h": nbr("T_h", 0.35, 1),
        "s0": [float(best["s0"])],
        "jerk_max": nbr("jerk_max", 0.15, 1),
        "jerk_brake_max": [float(best["jerk_brake_max"])],
        "speed_factor": nbr("speed_factor", 0.015, 2),
    }


def phase_micro(best: dict[str, Any]) -> dict[str, list[float]]:
    def nbr(key: str, step: float) -> list[float]:
        c = float(best[key])
        return _unique_grid([c - step, c, c + step])

    return {
        "a_max": nbr("a_max", 0.05),
        "b_comf": nbr("b_comf", 0.05),
        "T": [float(best["T"])],
        "T_h": nbr("T_h", 0.15),
        "s0": [float(best["s0"])],
        "jerk_max": [float(best["jerk_max"])],
        "jerk_brake_max": [float(best["jerk_brake_max"])],
        "speed_factor": nbr("speed_factor", 0.01),
    }


def run_phase(
    name: str,
    grids: dict[str, list[float]],
    *,
    corridor,
    ref,
    seed: int,
    lam: float,
    mu: float,
    seen: set[str],
    all_rows: list[dict[str, Any]],
    iter_counter: list[int],
    max_arms: int | None = None,
) -> list[dict[str, Any]]:
    specs = _product_params(grids)
    if max_arms is not None and len(specs) > max_arms:
        # Uniform stride to keep coverage
        stride = max(1, len(specs) // max_arms)
        specs = specs[::stride][:max_arms]

    phase_rows: list[dict[str, Any]] = []
    print(f"\n=== Phase {name}: {len(specs)} candidates (after dedup vs seen) ===", flush=True)
    for params in specs:
        aid = _arm_id(params)
        if aid in seen:
            continue
        seen.add(aid)
        iter_counter[0] += 1
        try:
            row = evaluate_arm(
                corridor=corridor,
                ref=ref,
                params=params,
                seed=seed,
                lam=lam,
                mu=mu,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  FAIL {aid}: {exc}", flush=True)
            continue
        row["iter"] = iter_counter[0]
        row["phase"] = name
        phase_rows.append(row)
        all_rows.append(row)
        if len(phase_rows) % 5 == 0 or len(phase_rows) == 1:
            print(
                f"  [{len(phase_rows)}] score={row['score']:.3f} "
                f"RMSEv={row['rmse_v']:.3f} RMSEa={row['rmse_a']:.3f} "
                f"ΔT={row['delta_duration_pct']:+.2f}%  {aid}",
                flush=True,
            )

    phase_rows.sort(key=lambda r: r["score"])
    for i, r in enumerate(phase_rows):
        r["rank_in_phase"] = i + 1
    if phase_rows:
        b = phase_rows[0]
        print(
            f"  BEST {name}: score={b['score']:.3f} RMSE_v={b['rmse_v']:.3f} "
            f"RMSE_a={b['rmse_a']:.3f} ΔT={b['delta_duration_pct']:+.2f}%",
            flush=True,
        )
    return phase_rows


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in sorted(rows, key=lambda x: (x["score"], x["iter"])):
            w.writerow({c: r.get(c, "") for c in CSV_COLUMNS})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true", help="Smaller grids (~minutes).")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--lambda-a", type=float, default=4.0)
    ap.add_argument("--mu-dt", type=float, default=0.08)
    ap.add_argument("--a-y", type=float, default=3.5)
    ap.add_argument("--top-k-refine", type=int, default=3)
    args = ap.parse_args()

    CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    print("Loading AVL N90 + synth corridor…", flush=True)
    ref = load_reference("avl_n90_bcb")
    if not ref:
        print("ERROR: avl_n90_bcb reference missing", file=sys.stderr)
        return 1
    corridor = synth_corridor_from_reference("avl_n90_bcb", a_y_mps2=args.a_y)
    print(
        f"  corridor L={corridor.S[-1]/1000:.2f} km  n={len(corridor.S)}  a_y={args.a_y}",
        flush=True,
    )

    seen: set[str] = set()
    all_rows: list[dict[str, Any]] = []
    iter_counter = [0]

    # Always include exact BCB baseline
    bcb_grid = {k: [v] for k, v in BCB.items()}
    run_phase(
        "0_bcb_baseline",
        bcb_grid,
        corridor=corridor,
        ref=ref,
        seed=args.seed,
        lam=args.lambda_a,
        mu=args.mu_dt,
        seen=seen,
        all_rows=all_rows,
        iter_counter=iter_counter,
    )

    p1 = run_phase(
        "1_coarse",
        phase_coarse(quick=args.quick),
        corridor=corridor,
        ref=ref,
        seed=args.seed,
        lam=args.lambda_a,
        mu=args.mu_dt,
        seen=seen,
        all_rows=all_rows,
        iter_counter=iter_counter,
        max_arms=48 if args.quick else 160,
    )
    if not p1:
        print("No successful coarse arms", file=sys.stderr)
        return 2

    # Refine around top-K
    top = p1[: max(1, args.top_k_refine)]
    refine_rows: list[dict[str, Any]] = []
    for ti, seed_arm in enumerate(top):
        grids = phase_refine(seed_arm, quick=args.quick)
        refine_rows.extend(
            run_phase(
                f"2_refine_top{ti+1}",
                grids,
                corridor=corridor,
                ref=ref,
                seed=args.seed,
                lam=args.lambda_a,
                mu=args.mu_dt,
                seen=seen,
                all_rows=all_rows,
                iter_counter=iter_counter,
                max_arms=80 if args.quick else 200,
            )
        )

    pool = sorted(all_rows, key=lambda r: r["score"])
    winner = pool[0]
    run_phase(
        "3_micro",
        phase_micro(winner),
        corridor=corridor,
        ref=ref,
        seed=args.seed,
        lam=args.lambda_a,
        mu=args.mu_dt,
        seen=seen,
        all_rows=all_rows,
        iter_counter=iter_counter,
    )

    all_sorted = sorted(all_rows, key=lambda r: r["score"])
    for i, r in enumerate(all_sorted):
        r["global_rank"] = i + 1
    best = all_sorted[0]

    recommended = {k: float(best[k]) for k in PARAM_KEYS}
    recommended_meta = {
        "driver_profile": "Normal",
        "a_y_mps2": args.a_y,
        "physics": recommended,
        "metrics": {
            "rmse_v": best["rmse_v"],
            "rmse_v_kmh": best["rmse_v_kmh"],
            "rmse_a": best["rmse_a"],
            "delta_duration_pct": best["delta_duration_pct"],
            "delta_duration_s": best["delta_duration_s"],
            "bias_v_mps": best["bias_v_mps"],
            "mean_v_kmh": best["mean_v_kmh"],
            "max_v_kmh": best["max_v_kmh"],
            "p95_abs_jerk": best["p95_abs_jerk"],
            "score": best["score"],
        },
        "arm_id": best["arm_id"],
        "phase": best["phase"],
        "iter": best["iter"],
        "objective": {
            "formula": "RMSE_v + lambda_a * RMSE_a + mu_dt * |delta_T_pct|",
            "lambda_a": args.lambda_a,
            "mu_dt": args.mu_dt,
        },
        "reference_id": "avl_n90_bcb",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_arms_evaluated": len(all_sorted),
        "targets": {
            "rmse_v_mps": 2.5,
            "rmse_a_mps2": 0.25,
            "abs_delta_T_pct": 3.0,
        },
        "targets_met": {
            "rmse_v": best["rmse_v"] <= 2.5,
            "rmse_a": best["rmse_a"] <= 0.25,
            "delta_T": abs(best["delta_duration_pct"]) <= 3.0,
        },
    }

    report = {
        **recommended_meta,
        "bcb_baseline": BCB,
        "top10": [
            {
                "global_rank": r["global_rank"],
                "arm_id": r["arm_id"],
                "phase": r["phase"],
                "physics": {k: r[k] for k in PARAM_KEYS},
                "metrics": {
                    "rmse_v": r["rmse_v"],
                    "rmse_a": r["rmse_a"],
                    "delta_duration_pct": r["delta_duration_pct"],
                    "score": r["score"],
                },
            }
            for r in all_sorted[:10]
        ],
        "all_arms": all_sorted,
    }

    csv_path = CALIBRATION_DIR / f"n90_iter_search_{stamp}.csv"
    json_path = CALIBRATION_DIR / f"n90_iter_search_{stamp}.json"
    latest_csv = CALIBRATION_DIR / "latest_n90_iter.csv"
    latest_json = CALIBRATION_DIR / "latest_n90_iter.json"
    rec_json = CALIBRATION_DIR / "latest_n90_recommended.json"

    write_csv(csv_path, all_sorted)
    write_csv(latest_csv, all_sorted)
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    latest_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    rec_json.write_text(json.dumps(recommended_meta, indent=2) + "\n", encoding="utf-8")

    # Also refresh latest_n90.md style summary
    md = CALIBRATION_DIR / "latest_n90_iter.md"
    lines = [
        "# N90 iterative parameter search",
        "",
        f"Generated: `{recommended_meta['generated_at']}`",
        f"Arms evaluated: **{len(all_sorted)}**",
        "",
        "## Recommended DriverPhysics",
        "",
        "```json",
        json.dumps(recommended, indent=2),
        "```",
        "",
        f"- a_y_mps2: `{args.a_y}`",
        f"- RMSE_v: `{best['rmse_v']:.4f}` m/s ({best['rmse_v_kmh']:.2f} km/h)",
        f"- RMSE_a: `{best['rmse_a']:.4f}` m/s²",
        f"- ΔT: `{best['delta_duration_pct']:+.2f}` % ({best['delta_duration_s']:+.1f} s)",
        f"- score: `{best['score']:.4f}`",
        f"- arm: `{best['arm_id']}` (phase `{best['phase']}`)",
        "",
        "## Targets",
        "",
        f"- RMSE_v ≤ 2.5: {'✔' if recommended_meta['targets_met']['rmse_v'] else '✘'}",
        f"- RMSE_a ≤ 0.25: {'✔' if recommended_meta['targets_met']['rmse_a'] else '✘'}",
        f"- |ΔT| ≤ 3 %: {'✔' if recommended_meta['targets_met']['delta_T'] else '✘'}",
        "",
        "## Top 10",
        "",
        "| Rank | Phase | RMSE_v | RMSE_a | ΔT% | Score | sf | a_max | b_comf |",
        "|------|-------|--------|--------|-----|-------|----|-------|--------|",
    ]
    for r in all_sorted[:10]:
        lines.append(
            f"| {r['global_rank']} | {r['phase']} | {r['rmse_v']:.3f} | {r['rmse_a']:.3f} | "
            f"{r['delta_duration_pct']:+.2f} | {r['score']:.3f} | {r['speed_factor']:.3f} | "
            f"{r['a_max']:.3f} | {r['b_comf']:.3f} |"
        )
    lines.extend(
        [
            "",
            "## Files",
            "",
            f"- Full CSV: `{csv_path.name}`",
            f"- Full JSON: `{json_path.name}`",
            f"- Recommended only: `latest_n90_recommended.json`",
            "",
        ]
    )
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("\n=== BEST ===", flush=True)
    print(json.dumps(recommended_meta, indent=2), flush=True)
    print(f"\nCSV  → {csv_path}", flush=True)
    print(f"JSON → {json_path}", flush=True)
    print(f"REC  → {rec_json}", flush=True)
    print(f"MD   → {md}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
