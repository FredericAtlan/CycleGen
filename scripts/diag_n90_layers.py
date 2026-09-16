#!/usr/bin/env python3
"""Layer-by-layer diagnostic: CycleGen models vs AVL N90 reference.

Compares slope / legal / curve / envelope / IDM (ablation grade+preview)
and writes JSON consumed by the diagnostic canvas.
"""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.models.schemas import DriverProfile, LatLon  # noqa: E402
from app.services.benchmark_loader import BENCHMARK_DIR, load_reference  # noqa: E402
from app.services.benchmark_metrics import compute_comparison  # noqa: E402
from app.services.curvature import (  # noqa: E402
    CURVE_ACTIVE_BELOW_MPS,
    curve_speed_limit_mps,
    curvature_radius_m,
)
from app.services.kinematic_solver import IDMSolver  # noqa: E402
import app.services.kinematic_solver as ks  # noqa: E402
from app.services.n90_calibrator import synth_corridor_from_reference  # noqa: E402
from app.services.spatial_processor import (  # noqa: E402
    slope_from_elevation_trapezoids,
    smooth_elevation_spatial,
)

OUT = BACKEND / "app" / "data" / "benchmark" / "calibration" / "diag_n90_layers.json"

BCB = {
    "a_max": 2.58,
    "b_comf": 1.71,
    "jerk_max": 0.96,
    "jerk_brake_max": 2.93,
    "T": 1.4,
    "T_h": 4.0,
    "s0": 2.5,
    "speed_factor": 1.05,
}


def main() -> int:
    ref = load_reference("avl_n90_bcb")
    assert ref
    t_ref = np.asarray(ref["time"], dtype=float)
    v_ref = np.asarray(ref["velocity"], dtype=float)
    s_ref = np.asarray(ref["position"], dtype=float)
    a_ref = np.asarray(ref["acceleration"], dtype=float)
    alpha_ref = np.asarray(ref["slope"], dtype=float)

    spd_lim: list[float] = []
    alt: list[float] = []
    with (BENCHMARK_DIR / "avl_n90_bcb_1hz.csv").open(
        newline="", encoding="utf-8-sig"
    ) as f:
        for row in csv.DictReader(f):
            spd_lim.append(float(row["spd_lim_kmh"]) / 3.6)
            alt.append(float(row["alt_m"]))
    spd_lim_a = np.asarray(spd_lim)
    alt_a = np.asarray(alt)

    print("=== AVL ===")
    print(
        f"T={t_ref[-1]:.0f}s L={s_ref[-1]/1000:.2f}km "
        f"v̄={v_ref.mean()*3.6:.1f} vmax={v_ref.max()*3.6:.1f}"
    )
    print(
        f"overspeed vs lim={(v_ref > spd_lim_a * 1.02).mean()*100:.1f}% "
        f"bias={(v_ref - spd_lim_a).mean()*3.6:+.2f} km/h"
    )

    c_oracle = synth_corridor_from_reference("avl_n90_bcb", a_y_mps2=3.5)
    S = np.asarray(c_oracle.S)
    alpha_avl_on_S = np.interp(S, s_ref, alpha_ref)
    spd_on_S = np.interp(S, s_ref, spd_lim_a)
    v_avl_on_S = np.interp(S, s_ref, v_ref)
    alt_on_S = np.interp(S, s_ref, alt_a)

    # DEM/trap slope from AVL altitude (CycleGen pipeline)
    z_smooth = smooth_elevation_spatial(
        S.tolist(), alt_on_S.tolist(), window_m=250.0
    )
    alpha_dem, _traps = slope_from_elevation_trapezoids(
        z_smooth,
        S.tolist(),
        trap_length_m=50.0,
        sg_min_span_m=0.0,  # already MA'd
        smooth_window=0,
    )
    alpha_dem_a = np.asarray(alpha_dem)
    alpha_pct_avl = np.tan(alpha_avl_on_S) * 100
    alpha_pct_dem = np.tan(alpha_dem_a) * 100
    rmse_alpha_dem = float(np.sqrt(np.mean((alpha_pct_dem - alpha_pct_avl) ** 2)))
    mae_alpha_dem = float(np.mean(np.abs(alpha_pct_dem - alpha_pct_avl)))
    corr_alpha_dem = float(np.corrcoef(alpha_pct_dem, alpha_pct_avl)[0, 1])

    print("\n=== SLOPE DEM/trap vs AVL α ===")
    print(
        f"RMSE={rmse_alpha_dem:.3f}% MAE={mae_alpha_dem:.3f}% corr={corr_alpha_dem:.3f}"
    )

    R = np.asarray(curvature_radius_m(c_oracle.geometry))
    Vc = np.asarray(curve_speed_limit_mps(R, a_y_mps2=3.5))
    V_legal = np.asarray(c_oracle.V_limite_legal)
    V_env = np.asarray(c_oracle.V_envelope)
    bind = Vc < CURVE_ACTIVE_BELOW_MPS

    print("\n=== SPEED LAYERS ===")
    print(
        f"V_legal RMSE vs AVL lim = "
        f"{np.sqrt(np.mean((V_legal - spd_on_S) ** 2)) * 3.6:.2f} km/h"
    )
    print(
        f"curve bind {bind.mean()*100:.1f}%  "
        f"env<legal {(V_env < V_legal - 0.5).mean()*100:.1f}%"
    )
    print(
        f"mean env={V_env.mean()*3.6:.1f} mean AVL v={v_avl_on_S.mean()*3.6:.1f}"
    )

    c_dem = c_oracle.model_copy(deep=True)
    c_dem.alpha = alpha_dem_a.tolist()

    sf_med = float(np.median(v_ref / np.maximum(spd_lim_a, 1.0)))
    print(f"median v/lim ≈ {sf_med:.3f}")

    def run_variant(
        name: str,
        *,
        grade: bool = True,
        preview: bool = True,
        overrides: dict | None = None,
        corridor=None,
    ):
        c = corridor if corridor is not None else c_oracle
        if not grade:
            c = c.model_copy(deep=True)
            c.alpha = [0.0] * len(c.alpha)
        orig_p = ks._preview_brake_accel
        if not preview:
            ks._preview_brake_accel = lambda *a, **k: float("inf")
        try:
            sol = IDMSolver(
                c,
                DriverProfile.NORMAL,
                seed=42,
                param_overrides=overrides or BCB,
                tls_override="green_wave",
            )
            profile = sol.solve()
        finally:
            ks._preview_brake_accel = orig_p

        pd = profile.model_dump()
        cmp = compute_comparison(pd, ref, align="time")
        k = cmp["kpis"]
        t_common = np.asarray(cmp["times"])
        a_gi = np.interp(
            t_common, np.asarray(pd["time"]), np.asarray(pd["acceleration"])
        )
        a_ri = np.interp(t_common, t_ref, a_ref)
        rmse_a = float(np.sqrt(np.mean((a_gi - a_ri) ** 2)))
        t_g = np.asarray(pd["time"])
        a_g = np.asarray(pd["acceleration"])
        if len(t_g) > 2:
            dt = np.diff(t_g)
            dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
            p95j = float(np.percentile(np.abs(np.diff(a_g) / dt), 95))
        else:
            p95j = 0.0
        row = {
            "name": name,
            "grade": grade,
            "preview": preview,
            "duration_s": float(pd["total_duration_s"]),
            "mean_v_kmh": float(pd["average_speed_kmh"]),
            "max_v_kmh": float(max(pd["velocity"]) * 3.6),
            "rmse_v": float(k["rmse_v"]),
            "rmse_v_kmh": float(k["rmse_v"]) * 3.6,
            "rmse_a": rmse_a,
            "delta_T_pct": float(k["delta_duration_pct"]),
            "delta_T_s": float(k["delta_duration_s"]),
            "bias_v_mps": float(k["bias_v"]),
            "p95_jerk": p95j,
            "score": float(k["rmse_v"])
            + 4 * rmse_a
            + 0.08 * abs(float(k["delta_duration_pct"])),
        }
        print(
            f"{name:32s} RMSEv={row['rmse_v']:5.2f} "
            f"({row['rmse_v_kmh']:5.1f}km/h) "
            f"RMSEa={row['rmse_a']:.3f} ΔT={row['delta_T_pct']:+6.1f}% "
            f"v̄={row['mean_v_kmh']:5.1f} score={row['score']:5.2f}"
        )
        return row, pd, cmp

    print("\n=== ABLATION (BCB, oracle corridor) ===")
    variants = []
    for n, g, p in [
        ("A0_no_grade_no_preview", False, False),
        ("A1_grade_only", True, False),
        ("A2_preview_only", False, True),
        ("A3_full", True, True),
    ]:
        variants.append(run_variant(n, grade=g, preview=p)[0])

    print("\n=== DEM slope ===")
    variants.append(
        run_variant("B_dem_slope_full", grade=True, preview=True, corridor=c_dem)[0]
    )

    print("\n=== Envelope isolations ===")
    c_leg = c_oracle.model_copy(deep=True)
    c_leg.V_envelope = V_legal.tolist()
    c_leg.V_limite = V_legal.tolist()
    variants.append(run_variant("C_env_legal_full", corridor=c_leg)[0])
    variants.append(
        run_variant("C_env_legal_plain", grade=False, preview=False, corridor=c_leg)[0]
    )

    c_v = c_oracle.model_copy(deep=True)
    V_track = np.maximum(v_avl_on_S + 0.5, 3.0)
    c_v.V_envelope = V_track.tolist()
    c_v.V_limite = V_track.tolist()
    variants.append(run_variant("D_env_avl_v_full", corridor=c_v)[0])
    variants.append(
        run_variant("D_env_avl_v_plain", grade=False, preview=False, corridor=c_v)[0]
    )

    variants.append(
        run_variant("E_sf_1.20_full", overrides={**BCB, "speed_factor": 1.20})[0]
    )
    variants.append(
        run_variant("E_sf_median_full", overrides={**BCB, "speed_factor": sf_med})[0]
    )
    variants.append(
        run_variant(
            "F_amax_3.5_full",
            overrides={**BCB, "a_max": 3.5, "b_comf": 2.5, "speed_factor": 1.15},
        )[0]
    )

    ranked = sorted(variants, key=lambda r: r["score"])
    print("\n=== TOP 5 ===")
    for i, r in enumerate(ranked[:5]):
        print(f"  {i+1}. {r['name']} score={r['score']:.2f}")

    _, _, cmp_full = run_variant("series_full", grade=True, preview=True)
    _, _, cmp_plain = run_variant("series_plain", grade=False, preview=False)
    _, _, cmp_track = run_variant(
        "series_track", grade=False, preview=False, corridor=c_v
    )

    def ds(cmp: dict) -> dict:
        t = cmp["times"]
        step = max(1, len(t) // 500)
        return {
            "t_s": t[::step],
            "v_gen_kmh": [x * 3.6 for x in cmp["v_gen"][::step]],
            "v_avl_kmh": [x * 3.6 for x in cmp["v_ref"][::step]],
        }

    step = max(1, len(S) // 400)
    idx = np.arange(0, len(S), step)

    a0 = next(v for v in variants if v["name"] == "A0_no_grade_no_preview")
    a1 = next(v for v in variants if v["name"] == "A1_grade_only")
    a2 = next(v for v in variants if v["name"] == "A2_preview_only")
    a3 = next(v for v in variants if v["name"] == "A3_full")
    d_plain = next(v for v in variants if v["name"] == "D_env_avl_v_plain")

    findings = [
        {
            "layer": "pente_DEM_trap",
            "severity": (
                "OK"
                if rmse_alpha_dem <= 0.5
                else ("WARN" if rmse_alpha_dem <= 1.5 else "BAD")
            ),
            "detail": (
                f"Pente recalculée (MA 250 m + trap 50 m) vs α AVL: "
                f"RMSE={rmse_alpha_dem:.2f}%, corr={corr_alpha_dem:.3f}."
            ),
        },
        {
            "layer": "enveloppe_V",
            "severity": (
                "BAD"
                if a0["rmse_v"] > 5 and d_plain["rmse_v"] < a0["rmse_v"] * 0.55
                else "WARN"
            ),
            "detail": (
                f"Enveloppe CycleGen (lim+curve): RMSE_v={a0['rmse_v']:.2f} m/s, "
                f"ΔT={a0['delta_T_pct']:+.1f}%. "
                f"Enveloppe forcée ≈ v_AVL: RMSE_v={d_plain['rmse_v']:.2f} m/s, "
                f"ΔT={d_plain['delta_T_pct']:+.1f}%."
            ),
        },
        {
            "layer": "couplage_grade_preview",
            "severity": "INFO",
            "detail": (
                f"Baseline {a0['rmse_v']:.2f} → grade {a1['rmse_v']:.2f} → "
                f"preview {a2['rmse_v']:.2f} → full {a3['rmse_v']:.2f}."
            ),
        },
        {
            "layer": "modele_vehicule_IDM",
            "severity": "BAD" if d_plain["rmse_v"] > 2.5 else "WARN",
            "detail": (
                f"Même avec enveloppe = v_AVL, IDM+BCB: RMSE_v={d_plain['rmse_v']:.2f} "
                f"(cible ≤2.5). Plant AVL ≠ IDM cinématique. "
                f"AVL overspeed {(v_ref > spd_lim_a * 1.02).mean()*100:.0f}% du temps, "
                f"vmax={v_ref.max()*3.6:.0f} km/h."
            ),
        },
        {
            "layer": "v_curve",
            "severity": "INFO",
            "detail": (
                f"V_curve bind {bind.mean()*100:.1f}% ; "
                f"env<legal {(V_env < V_legal - 0.5).mean()*100:.1f}%."
            ),
        },
    ]

    report = {
        "reference": {
            "id": "avl_n90_bcb",
            "duration_s": float(t_ref[-1]),
            "distance_km": float(s_ref[-1] / 1000),
            "v_mean_kmh": float(v_ref.mean() * 3.6),
            "v_max_kmh": float(v_ref.max() * 3.6),
            "overspeed_vs_lim_pct": float((v_ref > spd_lim_a * 1.02).mean() * 100),
            "bias_v_vs_lim_kmh": float((v_ref - spd_lim_a).mean() * 3.6),
            "alpha_pct_min": float(math.tan(float(alpha_ref.min())) * 100),
            "alpha_pct_max": float(math.tan(float(alpha_ref.max())) * 100),
        },
        "layers": {
            "slope_dem_vs_avl": {
                "rmse_pct": rmse_alpha_dem,
                "mae_pct": mae_alpha_dem,
                "corr": corr_alpha_dem,
            },
            "curve_bind_pct": float(bind.mean() * 100),
            "env_below_legal_pct": float((V_env < V_legal - 0.5).mean() * 100),
            "mean_env_kmh": float(V_env.mean() * 3.6),
            "mean_avl_v_kmh": float(v_avl_on_S.mean() * 3.6),
        },
        "ablation": variants,
        "best": ranked[0],
        "findings": findings,
        "series_spatial": {
            "s_km": (S[idx] / 1000).tolist(),
            "alpha_avl": alpha_pct_avl[idx].tolist(),
            "alpha_dem": alpha_pct_dem[idx].tolist(),
            "v_avl": (v_avl_on_S[idx] * 3.6).tolist(),
            "spd_lim": (spd_on_S[idx] * 3.6).tolist(),
            "v_env": (V_env[idx] * 3.6).tolist(),
            "v_legal": (V_legal[idx] * 3.6).tolist(),
        },
        "time_full": ds(cmp_full),
        "time_plain": ds(cmp_plain),
        "time_track": ds(cmp_track),
    }
    OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {OUT}")
    for f in findings:
        print(f"[{f['severity']}] {f['layer']}: {f['detail']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
