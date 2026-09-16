#!/usr/bin/env python3
"""Fast N90 param sweep (~1–2 min) — saves full CSV/JSON for review.

Uses a small hand-picked + micro-neighborhood set (not full Cartesian grid).
"""

from __future__ import annotations

import csv
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
from app.services.n90_calibrator import CALIBRATION_DIR, synth_corridor_from_reference  # noqa: E402

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

# Best mid-run candidate from interrupted long search (score ≈ 4.99)
SEED_BEST = {
    "a_max": 2.0,
    "b_comf": 1.35,
    "T": 1.4,
    "T_h": 4.1,
    "s0": 2.5,
    "jerk_max": 1.5,
    "jerk_brake_max": 2.5,
    "speed_factor": 1.0,
}

KEYS = list(BCB.keys())

CSV_COLS = [
    "rank",
    "arm_id",
    "note",
    *KEYS,
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


def arm_id(p: dict[str, float]) -> str:
    return (
        f"a{p['a_max']:.3f}_b{p['b_comf']:.3f}_T{p['T']:.3f}"
        f"_Th{p['T_h']:.2f}_s0{p['s0']:.2f}"
        f"_jm{p['jerk_max']:.2f}_jb{p['jerk_brake_max']:.2f}"
        f"_sf{p['speed_factor']:.3f}"
    )


def score(rmse_v: float, rmse_a: float, dt: float) -> float:
    return rmse_v + 4.0 * rmse_a + 0.08 * abs(dt)


def evaluate(corridor, ref, params: dict[str, float], note: str) -> dict[str, Any]:
    sol = IDMSolver(
        corridor,
        DriverProfile.NORMAL,
        seed=42,
        param_overrides=params,
        tls_override="green_wave",
    )
    pd = sol.solve().model_dump()
    cmp = compute_comparison(pd, ref, align="time")
    k = cmp["kpis"]
    t_c = np.asarray(cmp["times"])
    a_g = np.interp(t_c, np.asarray(pd["time"]), np.asarray(pd["acceleration"]))
    a_r = np.interp(t_c, np.asarray(ref["time"]), np.asarray(ref["acceleration"]))
    rmse_a = float(np.sqrt(np.mean((a_g - a_r) ** 2)))
    t = np.asarray(pd["time"])
    a = np.asarray(pd["acceleration"])
    if len(t) > 2:
        dt = np.diff(t)
        dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
        p95j = float(np.percentile(np.abs(np.diff(a) / dt), 95))
    else:
        p95j = 0.0
    rmse_v = float(k["rmse_v"])
    dtp = float(k["delta_duration_pct"])
    return {
        "arm_id": arm_id(params),
        "note": note,
        **{k: float(params[k]) for k in KEYS},
        "rmse_v": rmse_v,
        "rmse_v_kmh": rmse_v * 3.6,
        "rmse_a": rmse_a,
        "delta_duration_pct": dtp,
        "delta_duration_s": float(k["delta_duration_s"]),
        "bias_v_mps": float(k["bias_v"]),
        "mean_v_kmh": float(pd["average_speed_kmh"]),
        "max_v_kmh": float(max(pd["velocity"]) * 3.6),
        "duration_s": float(pd["total_duration_s"]),
        "p95_abs_jerk": p95j,
        "score": score(rmse_v, rmse_a, dtp),
    }


def candidates() -> list[tuple[dict[str, float], str]]:
    out: list[tuple[dict[str, float], str]] = []
    out.append((dict(BCB), "bcb_baseline"))
    out.append((dict(SEED_BEST), "seed_from_long_search"))

    # Micro neighborhood around seed — 3 axes only (18 arms)
    for da in (-0.15, 0.0, 0.15):
        for db in (-0.15, 0.0, 0.15):
            for dsf in (-0.02, 0.0, 0.02):
                p = dict(SEED_BEST)
                p["a_max"] = round(SEED_BEST["a_max"] + da, 3)
                p["b_comf"] = round(SEED_BEST["b_comf"] + db, 3)
                p["speed_factor"] = round(SEED_BEST["speed_factor"] + dsf, 3)
                out.append((p, "micro_seed"))

    # A few extras from diagnostic / UI presets
    extras = [
        ({**BCB, "a_max": 2.0, "b_comf": 1.6, "speed_factor": 1.05}, "diag_like"),
        ({**BCB, "a_max": 1.85, "b_comf": 1.5, "speed_factor": 1.0, "T_h": 4.5, "jerk_max": 1.5, "jerk_brake_max": 2.5}, "refine_log_best2"),
        ({**SEED_BEST, "a_max": 2.1, "b_comf": 1.4, "speed_factor": 1.02}, "seed_tweak"),
        ({**SEED_BEST, "jerk_max": 0.96, "jerk_brake_max": 2.93}, "seed_bcb_jerk"),
        ({**SEED_BEST, "T": 1.2}, "seed_T12"),
        ({**SEED_BEST, "T": 1.6}, "seed_T16"),
    ]
    out.extend(extras)

    # Dedup by arm_id
    seen: set[str] = set()
    uniq: list[tuple[dict[str, float], str]] = []
    for p, note in out:
        aid = arm_id(p)
        if aid in seen:
            continue
        seen.add(aid)
        uniq.append((p, note))
    return uniq


def main() -> int:
    CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print("Fast N90 sweep…", flush=True)
    ref = load_reference("avl_n90_bcb")
    assert ref
    corridor = synth_corridor_from_reference("avl_n90_bcb", a_y_mps2=3.5)
    cands = candidates()
    print(f"  {len(cands)} arms  L={corridor.S[-1]/1000:.1f} km", flush=True)

    rows: list[dict[str, Any]] = []
    for i, (p, note) in enumerate(cands, 1):
        row = evaluate(corridor, ref, p, note)
        rows.append(row)
        print(
            f"  [{i}/{len(cands)}] score={row['score']:.3f} "
            f"v={row['rmse_v']:.3f} a={row['rmse_a']:.3f} "
            f"ΔT={row['delta_duration_pct']:+.2f}%  {note}",
            flush=True,
        )

    rows.sort(key=lambda r: r["score"])
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    best = rows[0]

    physics = {k: float(best[k]) for k in KEYS}
    recommended = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reference_id": "avl_n90_bcb",
        "driver_profile": "Normal",
        "a_y_mps2": 3.5,
        "n_arms": len(rows),
        "mode": "fast_micro",
        "physics": physics,
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
        "note": best["note"],
        "targets": {"rmse_v": 2.5, "rmse_a": 0.25, "abs_delta_T_pct": 3.0},
        "targets_met": {
            "rmse_v": best["rmse_v"] <= 2.5,
            "rmse_a": best["rmse_a"] <= 0.25,
            "delta_T": abs(best["delta_duration_pct"]) <= 3.0,
        },
        "bcb_baseline": BCB,
        "top10": [
            {
                "rank": r["rank"],
                "note": r["note"],
                "physics": {k: r[k] for k in KEYS},
                "rmse_v": r["rmse_v"],
                "rmse_a": r["rmse_a"],
                "delta_duration_pct": r["delta_duration_pct"],
                "score": r["score"],
            }
            for r in rows[:10]
        ],
    }

    report = {**recommended, "all_arms": rows}

    csv_path = CALIBRATION_DIR / f"n90_fast_search_{stamp}.csv"
    json_path = CALIBRATION_DIR / f"n90_fast_search_{stamp}.json"
    latest_csv = CALIBRATION_DIR / "latest_n90_iter.csv"
    latest_json = CALIBRATION_DIR / "latest_n90_iter.json"
    rec_path = CALIBRATION_DIR / "latest_n90_recommended.json"
    md_path = CALIBRATION_DIR / "latest_n90_iter.md"

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in CSV_COLS})
    latest_csv.write_text(csv_path.read_text(encoding="utf-8"), encoding="utf-8")
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    latest_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    rec_path.write_text(json.dumps(recommended, indent=2) + "\n", encoding="utf-8")

    md = [
        "# N90 fast parameter search",
        "",
        f"Generated: `{recommended['generated_at']}` · **{len(rows)}** arms (~2 min)",
        "",
        "## Recommended DriverPhysics",
        "",
        "```json",
        json.dumps(physics, indent=2),
        "```",
        "",
        f"- RMSE_v: `{best['rmse_v']:.4f}` m/s ({best['rmse_v_kmh']:.2f} km/h) "
        f"{'✔' if recommended['targets_met']['rmse_v'] else '✘'} ≤ 2.5",
        f"- RMSE_a: `{best['rmse_a']:.4f}` m/s² "
        f"{'✔' if recommended['targets_met']['rmse_a'] else '✘'} ≤ 0.25",
        f"- ΔT: `{best['delta_duration_pct']:+.2f}` % "
        f"{'✔' if recommended['targets_met']['delta_T'] else '✘'} |·| ≤ 3",
        f"- score: `{best['score']:.4f}` · note: `{best['note']}`",
        "",
        "## Top 10",
        "",
        "| Rank | note | RMSE_v | RMSE_a | ΔT% | score | sf | a_max | b_comf |",
        "|------|------|--------|--------|-----|-------|----|-------|--------|",
    ]
    for r in rows[:10]:
        md.append(
            f"| {r['rank']} | {r['note']} | {r['rmse_v']:.3f} | {r['rmse_a']:.3f} | "
            f"{r['delta_duration_pct']:+.2f} | {r['score']:.3f} | {r['speed_factor']:.3f} | "
            f"{r['a_max']:.3f} | {r['b_comf']:.3f} |"
        )
    md.extend(
        [
            "",
            "## Files to verify",
            "",
            f"- `{csv_path.name}` — tous les bras",
            f"- `{json_path.name}` — rapport complet",
            "- `latest_n90_recommended.json` — params à coller dans l’UI",
            "- `latest_n90_iter.csv` — alias latest",
            "",
        ]
    )
    md_path.write_text("\n".join(md) + "\n", encoding="utf-8")

    print("\n=== BEST ===", flush=True)
    print(json.dumps(recommended, indent=2), flush=True)
    print(f"\nCSV  {csv_path}", flush=True)
    print(f"JSON {json_path}", flush=True)
    print(f"REC  {rec_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
