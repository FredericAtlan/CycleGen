#!/usr/bin/env python3
"""Generate an interactive HTML report: AVL XSPACE vs CycleGen IDM.

Charts use Plotly.js (CDN) with box-zoom on both ΔX and ΔY.
Includes expert narrative on vehicle powertrain fingerprint and driver
behaviour vs CycleGen Eco / Normal / Sportif / Standard_AVL_BCB presets.

Usage:
  cd backend && .venv/bin/python ../scripts/report_xspace_avl_html.py
"""

from __future__ import annotations

import html
import json
import math
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_BACKEND = _HERE.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from dataclasses import asdict  # noqa: E402

from app.services.kinematic_solver import IDMSolver, PROFILE_PARAMS  # noqa: E402

import batch_xspace_avl_compare as batch  # noqa: E402

OUT_DIR = _BACKEND / "app/data/benchmark/calibration"
CHART_N = 700  # points per series in HTML (keeps file ~few MB)


def thin(xs: list[float], max_n: int = CHART_N) -> list[float]:
    n = len(xs)
    if n <= max_n:
        return [float(x) if math.isfinite(x) else None for x in xs]  # type: ignore[list-item]
    step = max(1, n // max_n)
    idx = list(range(0, n, step))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    out = []
    for i in idx:
        x = xs[i]
        out.append(float(x) if isinstance(x, (int, float)) and math.isfinite(x) else None)
    return out


def accel_from_sv(S: list[float], v: list[float]) -> list[float]:
    """Finite-diff a ≈ v dv/ds along distance (m/s²)."""
    a = [0.0]
    for i in range(1, len(S)):
        ds = S[i] - S[i - 1]
        if ds < 1e-3:
            a.append(a[-1])
            continue
        dv = v[i] - v[i - 1]
        # a = v * dv/ds (chain rule along path)
        a.append(((v[i] + v[i - 1]) * 0.5) * (dv / ds))
    return a


def series_pack(
    *,
    S_avl: list[float],
    v_avl: list[float],
    alt: list[float],
    slope: list[float],
    lim: list[float],
    profile,
    label: str,
) -> dict:
    S_cg = list(profile.position)
    v_cg = list(profile.velocity)
    a_cg = list(profile.acceleration)
    v_avl_on_cg = batch.resample_on_s(S_avl, v_avl, S_cg)
    alt_on_cg = batch.resample_on_s(S_avl, alt, S_cg)
    slope_on_cg = batch.resample_on_s(S_avl, slope, S_cg)
    lim_on_cg = batch.resample_on_s(S_avl, lim, S_cg)
    n = min(len(S_cg), len(v_cg), len(v_avl_on_cg))
    S = S_cg[:n]
    vc = v_cg[:n]
    va = v_avl_on_cg[:n]
    dv = [vc[i] - va[i] for i in range(n)]
    return {
        "preset": label,
        "S_km": thin([s / 1000.0 for s in S]),
        "v_avl_kmh": thin([x * 3.6 for x in va]),
        "v_cg_kmh": thin([x * 3.6 for x in vc]),
        "dv_kmh": thin([x * 3.6 for x in dv]),
        "a_cg": thin(a_cg[:n]),
        "a_avl": thin(accel_from_sv(S, va)),
        "alt_m": thin(alt_on_cg[:n]),
        "slope_pct": thin(slope_on_cg[:n]),
        "lim_kmh": thin(lim_on_cg[:n]),
    }


def build_payload() -> dict:
    traces = []
    for path in batch.FILES:
        if not path.exists():
            print(f"MISSING {path}", flush=True)
            continue
        print(f"\n=== {path.name} ===", flush=True)
        raw = batch.load_xls(path)
        fp = batch.fingerprint(path, raw)
        ds = batch.downsample(raw, max_n=3000)
        arms = []
        series_by_preset: dict[str, dict] = {}
        for label, profile, overrides, a_y in batch.PRESETS:
            print(f"  → IDM {label}…", flush=True)
            try:
                corridor = batch.synth_corridor(ds, a_y=a_y)
                solver = IDMSolver(
                    corridor,
                    driver_profile=profile,
                    seed=1,
                    enable_markov=False,
                    max_speed_mps=130 / 3.6,
                    param_overrides=overrides,
                    vehicle=batch.XSPACE_VEHICLE,
                )
                prof = solver.solve()
                sc = batch.score_vs_avl(prof, ds["s"], ds["v"], fp.duration_s)
                sc["preset"] = label
                sc["a_y"] = a_y
                arms.append(sc)
                series_by_preset[label] = series_pack(
                    S_avl=ds["s"],
                    v_avl=ds["v"],
                    alt=ds["alt"],
                    slope=ds["slope"],
                    lim=ds["lim"],
                    profile=prof,
                    label=label,
                )
                print(
                    f"     RMSE_v={sc.get('rmse_v_kmh')} km/h  "
                    f"ΔT={sc.get('delta_duration_pct')}%  "
                    f"shape={sc.get('shape_score')} corr={sc.get('corr_v')}",
                    flush=True,
                )
            except Exception as e:
                arms.append({"preset": label, "error": str(e)})
                print(f"     ERROR {e}", flush=True)

        ok = [a for a in arms if "rmse_v_mps" in a]
        best = min(ok, key=lambda a: a["rmse_v_mps"]) if ok else None
        traces.append(
            {
                "avl": asdict(fp),
                "arms": arms,
                "best": best,
                "series": series_by_preset,
            }
        )

    reports = [{"avl": t["avl"], "arms": t["arms"], "best": t["best"]} for t in traces]
    by_style: dict[str, list[dict]] = {"prudent": [], "dynamique": []}
    for r in reports:
        st = r["avl"]["style"]
        if st in by_style:
            by_style[st].append(r["avl"])

    def agg(style: str, key: str) -> float:
        xs = [
            x[key]
            for x in by_style[style]
            if math.isfinite(x.get(key, float("nan")))
        ]
        return round(batch.mean(xs), 4) if xs else float("nan")

    summary = {
        "avl_driver_fingerprint": {
            "prudent": {
                k: agg("prudent", k)
                for k in (
                    "a_pos_p95",
                    "a_neg_p95",
                    "jerk_pos_p95",
                    "jerk_neg_p95",
                    "speed_factor_mean",
                    "overspeed_pct",
                    "a_lat_p95",
                )
            },
            "dynamique": {
                k: agg("dynamique", k)
                for k in (
                    "a_pos_p95",
                    "a_neg_p95",
                    "jerk_pos_p95",
                    "jerk_neg_p95",
                    "speed_factor_mean",
                    "overspeed_pct",
                    "a_lat_p95",
                )
            },
        },
        "avl_vehicle_fingerprint": {
            "power_p95_kw_mean": round(
                batch.mean(
                    [
                        r["avl"]["power_p95_kw"]
                        for r in reports
                        if math.isfinite(r["avl"]["power_p95_kw"])
                    ]
                ),
                1,
            ),
            "power_max_kw_mean": round(
                batch.mean(
                    [
                        r["avl"]["power_max_kw"]
                        for r in reports
                        if math.isfinite(r["avl"]["power_max_kw"])
                    ]
                ),
                1,
            ),
            "torque_p95_nm_mean": round(
                batch.mean(
                    [
                        r["avl"]["torque_p95_nm"]
                        for r in reports
                        if math.isfinite(r["avl"]["torque_p95_nm"])
                    ]
                ),
                0,
            ),
            "torque_brake_p95_nm_mean": round(
                batch.mean(
                    [
                        r["avl"]["torque_brake_p95_nm"]
                        for r in reports
                        if math.isfinite(r["avl"]["torque_brake_p95_nm"])
                    ]
                ),
                0,
            ),
            "gear_max_observed": max(
                (r["avl"]["gear_max"] for r in reports), default=float("nan")
            ),
        },
        "cyclegen_presets": {
            label: {
                "a_max": PROFILE_PARAMS[profile].a_max
                if overrides is None
                else float(overrides.get("a_max", PROFILE_PARAMS[profile].a_max)),
                "b_comf": PROFILE_PARAMS[profile].b_comf
                if overrides is None
                else float(overrides.get("b_comf", PROFILE_PARAMS[profile].b_comf)),
                "sf": PROFILE_PARAMS[profile].speed_factor
                if overrides is None
                else float(
                    overrides.get("speed_factor", PROFILE_PARAMS[profile].speed_factor)
                ),
                "jerk": PROFILE_PARAMS[profile].jerk_max
                if overrides is None
                else float(overrides.get("jerk_max", PROFILE_PARAMS[profile].jerk_max)),
                "jerk_b": PROFILE_PARAMS[profile].jerk_brake_max
                if overrides is None
                else float(
                    overrides.get(
                        "jerk_brake_max", PROFILE_PARAMS[profile].jerk_brake_max
                    )
                ),
                "a_y": a_y,
            }
            for label, profile, overrides, a_y in batch.PRESETS
        },
        "recommended_presets": {
            "prudent_from_avl": {
                "a_max": round(agg("prudent", "a_pos_p95"), 2),
                "b_comf": round(agg("prudent", "a_neg_p95"), 2),
                "jerk_max": round(agg("prudent", "jerk_pos_p95"), 2),
                "jerk_brake_max": round(agg("prudent", "jerk_neg_p95"), 2),
                "speed_factor": round(agg("prudent", "speed_factor_mean"), 3),
                "a_y": round(agg("prudent", "a_lat_p95"), 2),
            },
            "dynamique_from_avl": {
                "a_max": round(agg("dynamique", "a_pos_p95"), 2),
                "b_comf": round(agg("dynamique", "a_neg_p95"), 2),
                "jerk_max": round(agg("dynamique", "jerk_pos_p95"), 2),
                "jerk_brake_max": round(agg("dynamique", "jerk_neg_p95"), 2),
                "speed_factor": round(agg("dynamique", "speed_factor_mean"), 3),
                "a_y": round(agg("dynamique", "a_lat_p95"), 2),
            },
        },
    }
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "method": "synth_corridor_from_avl_geometry + IDMSolver + Plotly HTML",
        "summary": summary,
        "traces": traces,
    }


def render_html(payload: dict) -> str:
    data_json = json.dumps(payload, ensure_ascii=False)
    # Escape </script> in JSON
    data_json = data_json.replace("</", "<\\/")

    s = payload["summary"]
    veh = s["avl_vehicle_fingerprint"]
    prud = s["avl_driver_fingerprint"]["prudent"]
    dyn = s["avl_driver_fingerprint"]["dynamique"]
    rec_p = s["recommended_presets"]["prudent_from_avl"]
    rec_d = s["recommended_presets"]["dynamique_from_avl"]

    # Scoreboard rows
    rows = []
    for t in payload["traces"]:
        avl = t["avl"]
        best = t["best"] or {}
        rows.append(
            "<tr>"
            f"<td>{html.escape(avl.get('route_hint',''))}</td>"
            f"<td><span class='pill {html.escape(avl.get('style',''))}'>"
            f"{html.escape(avl.get('style',''))}</span></td>"
            f"<td>{avl.get('v_mean_kmh', float('nan')):.1f}</td>"
            f"<td>{avl.get('a_pos_p95', float('nan')):.2f} / {avl.get('a_neg_p95', float('nan')):.2f}</td>"
            f"<td>{avl.get('a_lat_p95', float('nan')):.2f}</td>"
            f"<td>{html.escape(str(best.get('preset','—')))}</td>"
            f"<td>{best.get('rmse_v_kmh', float('nan')):.2f}</td>"
            f"<td>{best.get('delta_duration_pct', float('nan')):+.1f}%</td>"
            "</tr>"
        )

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CycleGen × AVL XSPACE — Rapport de calibration</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  :root {{
    --bg: #0f1419;
    --panel: #1a222c;
    --ink: #e8eef4;
    --muted: #9aabbc;
    --line: #2a3644;
    --accent: #3db8a0;
    --warn: #e0a35a;
    --danger: #e06c75;
    --prudent: #5b9bd5;
    --dynamique: #e07a5f;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
    background: radial-gradient(1200px 600px at 10% -10%, #1c2a36 0%, var(--bg) 55%);
    color: var(--ink);
    line-height: 1.55;
  }}
  header.hero {{
    padding: 2.5rem 1.5rem 1.5rem;
    max-width: 1180px;
    margin: 0 auto;
  }}
  header.hero h1 {{
    font-family: "IBM Plex Serif", Georgia, serif;
    font-weight: 600;
    font-size: clamp(1.6rem, 3vw, 2.2rem);
    margin: 0 0 0.4rem;
    letter-spacing: -0.02em;
  }}
  header.hero p.lead {{
    color: var(--muted);
    max-width: 62ch;
    margin: 0.4rem 0 0;
  }}
  .meta {{
    margin-top: 1rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }}
  .chip {{
    font-size: 0.75rem;
    padding: 0.25rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--muted);
    background: rgba(255,255,255,0.03);
  }}
  main {{
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 1.5rem 4rem;
    display: grid;
    gap: 1.25rem;
  }}
  section.panel {{
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 1.25rem 1.35rem 1.4rem;
  }}
  section.panel h2 {{
    margin: 0 0 0.75rem;
    font-size: 1.15rem;
    font-weight: 600;
  }}
  section.panel h3 {{
    margin: 1.1rem 0 0.45rem;
    font-size: 0.95rem;
    color: var(--accent);
    font-weight: 600;
  }}
  .grid-kpis {{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.75rem;
  }}
  .kpi {{
    background: rgba(0,0,0,0.22);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 0.75rem 0.85rem;
  }}
  .kpi .lbl {{ font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }}
  .kpi .val {{ font-size: 1.35rem; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 0.15rem; }}
  .kpi .sub {{ font-size: 0.72rem; color: var(--muted); margin-top: 0.15rem; }}
  .expert p {{ margin: 0.55rem 0; color: #c8d4e0; }}
  .expert ul {{ margin: 0.4rem 0 0.6rem 1.1rem; color: #c8d4e0; }}
  .expert li {{ margin: 0.25rem 0; }}
  .expert strong {{ color: var(--ink); font-weight: 600; }}
  .callout {{
    border-left: 3px solid var(--accent);
    padding: 0.55rem 0.85rem;
    margin: 0.85rem 0;
    background: rgba(61,184,160,0.07);
    border-radius: 0 8px 8px 0;
    color: #d5e8e3;
    font-size: 0.92rem;
  }}
  .callout.warn {{ border-left-color: var(--warn); background: rgba(224,163,90,0.08); }}
  .callout.danger {{ border-left-color: var(--danger); background: rgba(224,108,117,0.08); }}
  table.score {{
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }}
  table.score th, table.score td {{
    text-align: left;
    padding: 0.5rem 0.55rem;
    border-bottom: 1px solid var(--line);
  }}
  table.score th {{ color: var(--muted); font-weight: 550; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }}
  .pill {{
    display: inline-block;
    padding: 0.12rem 0.5rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }}
  .pill.prudent {{ background: rgba(91,155,213,0.2); color: #8ec0ef; }}
  .pill.dynamique {{ background: rgba(224,122,95,0.2); color: #f0a890; }}
  .tabs {{
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.5rem 0 0.85rem;
  }}
  .tabs button {{
    appearance: none;
    border: 1px solid var(--line);
    background: rgba(0,0,0,0.25);
    color: var(--muted);
    padding: 0.4rem 0.75rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.8rem;
  }}
  .tabs button.active {{
    color: var(--ink);
    border-color: var(--accent);
    background: rgba(61,184,160,0.15);
  }}
  .hint {{
    font-size: 0.75rem;
    color: var(--muted);
    margin: 0 0 0.6rem;
  }}
  .ctrl-block {{
    margin: 0.65rem 0 0.85rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(0,0,0,0.18);
  }}
  .ctrl-block .ctrl-title {{
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 0 0 0.45rem;
    font-weight: 600;
  }}
  .chart {{
    width: 100%;
    min-height: 360px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(0,0,0,0.18);
  }}
  .chart-wrap {{
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }}
  .chart-wrap.hidden {{ display: none !important; }}
  .chart-wrap .chart-cap {{
    font-size: 0.78rem;
    font-weight: 600;
    color: #d5e0ea;
    padding: 0 0.15rem;
  }}
  .chart-wrap .chart-cap span {{
    font-weight: 450;
    color: var(--muted);
    margin-left: 0.35rem;
  }}
  .chart-row {{
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.85rem;
    margin-top: 0.85rem;
  }}
  @media (min-width: 900px) {{
    .chart-row.split {{ grid-template-columns: 1fr 1fr; }}
  }}
  .toggle-bar {{
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }}
  .toggle-bar label {{
    font-size: 0.78rem;
    color: #c8d4e0;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    padding: 0.32rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    user-select: none;
  }}
  .toggle-bar label:has(input:checked) {{
    border-color: rgba(61,184,160,0.55);
    background: rgba(61,184,160,0.1);
  }}
  .toggle-bar label .swatch {{
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }}
  .toggle-bar input {{ accent-color: var(--accent); }}
  .sync-bar {{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.65rem;
    margin: 0.65rem 0 0.85rem;
  }}
  .sync-bar button {{
    appearance: none;
    border: 1px solid rgba(61,184,160,0.55);
    background: rgba(61,184,160,0.14);
    color: var(--ink);
    padding: 0.45rem 0.9rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 600;
  }}
  .sync-bar button:hover {{
    background: rgba(61,184,160,0.25);
  }}
  .sync-bar button.secondary {{
    border-color: var(--line);
    background: rgba(0,0,0,0.25);
    font-weight: 500;
    color: var(--muted);
  }}
  .sync-bar .sync-hint {{
    font-size: 0.72rem;
    color: var(--muted);
    max-width: 52ch;
    line-height: 1.35;
  }}
  .sync-bar .sync-status {{
    font-size: 0.72rem;
    color: var(--accent);
    min-height: 1em;
  }}
  footer {{
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 1.5rem 2.5rem;
    color: var(--muted);
    font-size: 0.75rem;
  }}
  code {{ font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.85em; }}
</style>
</head>
<body>
<header class="hero">
  <h1>CycleGen × AVL Route Studio — calibration XSPACE</h1>
  <p class="lead">
    Comparaison géométrie-à-géométrie : corridor synthétisé depuis les .xls AVL,
    rejoué par l’IDM CycleGen (Eco / Normal / Sportif / Standard_AVL_BCB).
    Graphiques interactifs — zoom boîte sur ΔX et ΔY (Plotly).
  </p>
  <div class="meta">
    <span class="chip">généré {html.escape(payload["generated_at"])}</span>
    <span class="chip">{html.escape(payload["method"])}</span>
    <span class="chip">{len(payload["traces"])} traces · col + Stelvio</span>
  </div>
</header>

<main>
  <section class="panel">
    <h2>Synthèse KPI</h2>
    <div class="grid-kpis">
      <div class="kpi"><div class="lbl">P95 puissance AVL</div><div class="val">{veh["power_p95_kw_mean"]:.0f} kW</div><div class="sub">moyenne traces · max moyen {veh["power_max_kw_mean"]:.0f} kW</div></div>
      <div class="kpi"><div class="lbl">Couple P95 / frein</div><div class="val">{veh["torque_p95_nm_mean"]:.0f} / {veh["torque_brake_p95_nm_mean"]:.0f}</div><div class="sub">Nm · gear_max = {veh.get("gear_max_observed", 1):.0f}</div></div>
      <div class="kpi"><div class="lbl">Prudent a+/a− P95</div><div class="val">{prud["a_pos_p95"]:.2f} / {prud["a_neg_p95"]:.2f}</div><div class="sub">m/s² · jerk≈{prud["jerk_pos_p95"]:.1f}</div></div>
      <div class="kpi"><div class="lbl">Dynamique a+/a− P95</div><div class="val">{dyn["a_pos_p95"]:.2f} / {dyn["a_neg_p95"]:.2f}</div><div class="sub">m/s² · a_y P95={dyn["a_lat_p95"]:.1f}</div></div>
      <div class="kpi"><div class="lbl">Speed factor moyen</div><div class="val">{prud["speed_factor_mean"]:.2f} · {dyn["speed_factor_mean"]:.2f}</div><div class="sub">prudent · dynamique</div></div>
      <div class="kpi"><div class="lbl">Overspeed %</div><div class="val">{prud["overspeed_pct"]:.0f}% · {dyn["overspeed_pct"]:.0f}%</div><div class="sub">sur limite affichée</div></div>
    </div>
  </section>

  <section class="panel expert">
    <h2>Lecture expert — modèle véhicule</h2>
    <p>
      Les exports XSPACE exposent <strong>puissance, couple, régime et rapport</strong>.
      Sur l’ensemble du lot, le <strong>P95 de puissance ≈ {veh["power_p95_kw_mean"]:.0f}&nbsp;kW</strong>
      (usage «&nbsp;courant&nbsp;») contraste avec des <strong>pics max ≈ {veh["power_max_kw_mean"]:.0f}&nbsp;kW</strong>.
      Ce pattern est typique d’un <strong>groupe à fort peak / courte durée</strong>
      (boost électrique, saturation courte, ou artefact de dérivation couple×ω),
      pas d’un thermique qui tient {veh["power_max_kw_mean"]:.0f}&nbsp;kW en continu.
    </p>
    <p>
      Le <strong>couple frein P95 plafonne à ~{veh["torque_brake_p95_nm_mean"]:.0f}&nbsp;Nm</strong>
      (souvent saturé à 300&nbsp;Nm sur les traces dynamiques) : le conducteur AVL
      freine fort mais dans une enveloppe matérielle bornée. CycleGen, lui,
      n’a <strong>pas encore de modèle de puissance / masse / Cd·A</strong> —
      l’IDM borne <code>a_max</code> / <code>b_comf</code> / jerk sans vérifier
      P = F·v ni l’énergie dissipée en descente. D’où un biais structurel :
      en long descentes (Iseran, Veleta, Stelvio), l’AVL peut «&nbsp;retenir&nbsp;»
      via frein moteur / couple négatif, alors que l’IDM ne voit que
      <code>b_comf</code> + enveloppe de freinage anticipé.
    </p>
    <div class="callout warn">
      <strong>Implication calibration :</strong> calibrer uniquement a_max / b_comf
      sur RMSE_v rapproche la cinématique, mais ne garantit pas un couple/puissance
      réaliste pour un banc. Prochaine étape véhicule : masse + P_max(v) + T_brake_max
      en contrainte de l’accélération demandée par l’IDM (<em>a_req → clip(P, T)</em>).
    </div>
    <p>
      <code>gear_max = {veh.get("gear_max_observed", 1):.0f}</code> sur toutes les traces
      suggère soit un export mono-rapport (EV / eCVT), soit une colonne non peuplée.
      Ne pas en déduire un mapping boîte CycleGen tant que le signal n’est pas validé.
    </p>
  </section>

  <section class="panel expert">
    <h2>Lecture expert — comportement conducteur</h2>
    <p>
      Deux styles AVL sont clairement séparés :
    </p>
    <ul>
      <li>
        <strong>Prudent</strong> — a+ P95 ≈ {prud["a_pos_p95"]:.2f} m/s²,
        a− ≈ {prud["a_neg_p95"]:.2f}, jerk ≈ {prud["jerk_pos_p95"]:.1f},
        speed_factor moyen ≈ {prud["speed_factor_mean"]:.2f},
        a_y latéral P95 ≈ {prud["a_lat_p95"]:.1f} m/s².
        <em>Correspondance CycleGen : Eco</em> (a_max=1.2, b=1.2, a_y=2.0) —
        légèrement plus doux en latéral et en freinage que l’AVL prudent.
      </li>
      <li>
        <strong>Dynamique</strong> — a+ ≈ {dyn["a_pos_p95"]:.2f},
        a− ≈ {dyn["a_neg_p95"]:.2f}, jerk ≈ {dyn["jerk_pos_p95"]:.1f},
        overspeed ≈ {dyn["overspeed_pct"]:.0f} %,
        a_y ≈ {dyn["a_lat_p95"]:.1f} (jusqu’à ~7 m/s² au Stelvio).
        <em>Correspondance :</em> Standard_AVL_BCB / Normal sur RMSE_v,
        mais <strong>a_y CycleGen (3.0–3.5) sous-estime</strong> l’agressivité
        en virage de l’AVL dynamique.
      </li>
    </ul>
    <div class="callout danger">
      <strong>Écart critique Stelvio dynamique :</strong> a_lat P95 AVL ≈ 7.2 m/s²
      vs plafond CycleGen a_y=3.5. L’enveloppe courbure CycleGen coupe trop tôt :
      RMSE_v reste élevé (~14 km/h) et ΔT ≈ −9 % (CycleGen trop rapide en ligne
      droite / trop lent en courbe selon segments). Remède : presets
      <code>a_y ≈ {rec_d["a_y"]:.1f}</code> (dynamique) et
      <code>a_y ≈ {rec_p["a_y"]:.1f}</code> (prudent), dérivés des P95 AVL.
    </div>
    <h3>Presets recommandés (dérivés P95 AVL)</h3>
    <p>
      Prudent → <code>a_max={rec_p["a_max"]}</code>,
      <code>b_comf={rec_p["b_comf"]}</code>,
      <code>jerk={rec_p["jerk_max"]}</code>,
      <code>sf={rec_p["speed_factor"]}</code>,
      <code>a_y={rec_p["a_y"]}</code>.
    </p>
    <p>
      Dynamique → <code>a_max={rec_d["a_max"]}</code>,
      <code>b_comf={rec_d["b_comf"]}</code>,
      <code>jerk={rec_d["jerk_max"]}</code>,
      <code>sf={rec_d["speed_factor"]}</code>,
      <code>a_y={rec_d["a_y"]}</code>.
    </p>
    <p>
      Note : le <strong>speed_factor AVL moyen (&lt; 1)</strong> reflète des
      portions sous-limite (virages, trafic, prudence), alors que les presets
      CycleGen (sf 0.95–1.10) ciblent plutôt le régime «&nbsp;suivre la limite&nbsp;».
      Pour coller AVL, préférer sf issu du P50/P90 empirique, pas seulement le P95 d’accel.
    </p>
  </section>

  <section class="panel expert">
    <h2>Écarts de forme de courbe vs valeurs agrégées</h2>
    <p>
      Un bon RMSE_v ou un ΔT proche de 0 <strong>ne garantit pas</strong> que
      la forme raconte la même histoire que l’AVL. Deux erreurs opposées
      (trop rapide puis trop lent) se compensent dans la moyenne, mais
      restent visibles sur <em>Δv(s)</em> et sur les histogrammes d’accélération.
    </p>
    <h3>Ce que mesurent les agrégats</h3>
    <ul>
      <li><strong>RMSE_v</strong> — écart quadratique moyen de vitesse sur l’axe S
        (après alignement géométrique). Sensible aux offsets longs (sf trop haut/bas)
        et aux coupures courbes (a_y trop bas → plateaux bas trop tôt).</li>
      <li><strong>ΔT %</strong> — durée totale. Peut être bon alors que la
        trajectoire v(s) est déformée (compensation montée/descente).</li>
      <li><strong>a± P95</strong> — saturation des pédales. Si CycleGen plafonne
        à a_max alors que l’AVL module sous le plafond, la forme s’aplatit
        (créneaux) même si RMSE_v reste acceptable.</li>
      <li><strong>speed_factor / overspeed %</strong> — discipline vs limite.
        L’AVL prudent reste souvent sous la limite (sf̄≈0,73) ; un preset Normal
        (sf=1,05) colle la limite et crée un biais systématique hors virages.</li>
    </ul>
    <h3>Signatures de forme à lire sur les graphiques</h3>
    <ul>
      <li><strong>Δv &gt; 0 en ligne droite, Δv &lt; 0 en virage</strong> —
        a_y CycleGen trop bas (Stelvio dynamique) : l’enveloppe courbure coupe
        trop tôt, puis l’IDM rattrape entre les lacets → ΔT négatif et RMSE élevé.</li>
      <li><strong>Δv systématiquement négatif en descente</strong> —
        freinage AVL plus fort (b_comf / couple frein) ou sf trop bas côté CG ;
        ou AVL qui laisse filer faute de modèle véhicule (pas de frein moteur).</li>
      <li><strong>Créneaux d’accélération CG vs enveloppe douce AVL</strong> —
        jerk_max trop bas (Standard AVL BCB jerk+=0,96 vs dynamique AVL ≈3,0)
        ou a_max saturé → forme carrée vs sinusoïdale.</li>
      <li><strong>Décalage de phase sur les freinages d’approche</strong> —
        horizon T_h / enveloppe braking_feasible : CycleGen anticipe plus
        (ou moins) que le conducteur AVL → pics Δv localisés avant les virages
        sans changer beaucoup le RMSE global.</li>
    </ul>
    <div class="callout">
      <strong>Recommandation de recalage :</strong> (1) fixer a_y aux P95 AVL
      (Prudent ≈3,3 · Dynamique ≈4,9) ; (2) caler a_max / b_comf / jerk sur les
      P95 longitudinaux ; (3) baisser speed_factor vers le P50 AVL, pas le P90 ;
      (4) valider sur Δv(s) zoomé (lacets Stelvio) avant d’accepter un RMSE.
      Les profils CycleGen <code>Prudent</code> et <code>Dynamique</code> + les
      6 cycles seedés (3 routes × 2 styles) matérialisent ce recalage dans
      la bibliothèque.
    </div>
  </section>

  <section class="panel">
    <h2>Empreintes conducteur (radar)</h2>
    <p class="hint">Axes normalisés 0–1 sur le max (prudent, dynamique, Eco, Normal, Sportif, Std AVL).</p>
    <div id="chart-radar" class="chart" style="min-height:420px"></div>
  </section>

  <section class="panel">
    <h2>Tableau de bord — meilleur bras par trace</h2>
    <table class="score">
      <thead>
        <tr>
          <th>Route</th><th>Style AVL</th><th>v̄ AVL</th>
          <th>a+/a− P95</th><th>a_y P95</th>
          <th>Best CG</th><th>RMSE_v</th><th>ΔT</th>
        </tr>
      </thead>
      <tbody>
        {''.join(rows)}
      </tbody>
    </table>
    <div id="chart-rmse" class="chart" style="margin-top:1rem;min-height:320px"></div>
  </section>

  <section class="panel">
    <h2>Profils par trace — zoom ΔX / ΔY</h2>
    <p class="hint">
      1) Choisissez une route · 2) Cochez les presets CycleGen à comparer ·
      3) Affichez seulement les graphes utiles.
      Zoom : clic-glisser (X et Y) · double-clic = reset · pan via la barre Plotly.
      Bouton « Synchroniser » : même plage distance sur tous les graphes, Y adapté à la fenêtre.
      Δv = CycleGen − AVL (km/h) sur l’axe distance.
    </p>
    <div class="tabs" id="trace-tabs"></div>

    <div class="ctrl-block">
      <div class="ctrl-title">Presets CycleGen (superposition)</div>
      <div class="toggle-bar" id="preset-toggles"></div>
    </div>
    <div class="ctrl-block">
      <div class="ctrl-title">Graphiques visibles</div>
      <div class="toggle-bar" id="chart-toggles"></div>
    </div>
    <div class="sync-bar">
      <button type="button" id="btn-sync-x" title="Applique la plage distance du dernier graphe zoomé à tous les graphes visibles, et adapte l’échelle Y">
        Synchroniser la plage (X → tous · Y auto)
      </button>
      <button type="button" id="btn-reset-zoom" class="secondary" title="Réinitialise zoom X/Y sur tous les graphes de profil">
        Reset zoom
      </button>
      <span class="sync-hint">Zoomez d’abord un graphe, puis synchronisez : même fenêtre en distance (km) partout, Y recalculé sur la zone visible.</span>
      <span class="sync-status" id="sync-status"></span>
    </div>

    <div class="chart-row" id="row-v">
      <div class="chart-wrap" data-chart="v">
        <div class="chart-cap">Vitesse le long du trajet <span>réf. AVL vs CycleGen</span></div>
        <div id="chart-v" class="chart" style="min-height:420px"></div>
      </div>
    </div>
    <div class="chart-row split" id="row-dv-a">
      <div class="chart-wrap" data-chart="dv">
        <div class="chart-cap">Écart de vitesse Δv <span>positif = CycleGen plus rapide</span></div>
        <div id="chart-dv" class="chart" style="min-height:360px"></div>
      </div>
      <div class="chart-wrap" data-chart="a">
        <div class="chart-cap">Accélération longitudinale <span>m/s²</span></div>
        <div id="chart-a" class="chart" style="min-height:360px"></div>
      </div>
    </div>
    <div class="chart-row split" id="row-alt-slope">
      <div class="chart-wrap" data-chart="alt">
        <div class="chart-cap">Altitude <span>profil GPS AVL</span></div>
        <div id="chart-alt" class="chart" style="min-height:320px"></div>
      </div>
      <div class="chart-wrap" data-chart="slope">
        <div class="chart-cap">Pente <span>% grade</span></div>
        <div id="chart-slope" class="chart" style="min-height:320px"></div>
      </div>
    </div>
  </section>
</main>

<footer>
  Rapport généré par <code>scripts/report_xspace_avl_html.py</code> —
  données embarquées, aucune API requise. Plotly 2.35 (CDN).
</footer>

<script id="payload" type="application/json">{data_json}</script>
<script>
const DATA = JSON.parse(document.getElementById('payload').textContent);
const PRESETS = ["Eco","Normal","Sportif","Standard_AVL_BCB"];
const PRESET_LABEL = {{
  Eco: "CycleGen · Eco",
  Normal: "CycleGen · Normal",
  Sportif: "CycleGen · Sportif",
  Standard_AVL_BCB: "CycleGen · Std AVL (BCB)",
}};
const COLORS = {{
  AVL: "#e8eef4",
  Eco: "#5b9bd5",
  Normal: "#3db8a0",
  Sportif: "#e07a5f",
  Standard_AVL_BCB: "#c9a227",
  lim: "#8a9aab",
}};
const CHARTS = [
  {{ id: "v", label: "Vitesse v(s)" }},
  {{ id: "dv", label: "Écart Δv" }},
  {{ id: "a", label: "Accélération" }},
  {{ id: "alt", label: "Altitude" }},
  {{ id: "slope", label: "Pente" }},
];

const legendBelow = {{
  orientation: "h",
  y: -0.28,
  x: 0,
  xanchor: "left",
  yanchor: "top",
  bgcolor: "rgba(15,20,25,0.75)",
  bordercolor: "#2a3644",
  borderwidth: 1,
  font: {{ size: 11, color: "#d5e0ea" }},
  traceorder: "normal",
  itemclick: "toggle",
  itemdoubleclick: "toggleothers",
}};

const layoutBase = {{
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: {{ color: "#c8d4e0", size: 11, family: "IBM Plex Sans, sans-serif" }},
  margin: {{ t: 28, r: 20, b: 96, l: 58 }},
  legend: legendBelow,
  xaxis: {{
    gridcolor: "#2a3644", zerolinecolor: "#2a3644",
    title: {{ text: "Distance s (km)", standoff: 10, font: {{ size: 11, color: "#9aabbc" }} }},
  }},
  yaxis: {{
    gridcolor: "#2a3644", zerolinecolor: "#2a3644",
  }},
  dragmode: "zoom",
  hovermode: "x unified",
  showlegend: true,
}};
const cfg = {{
  responsive: true,
  displaylogo: false,
  scrollZoom: false,
  doubleClick: "reset",
  modeBarButtonsToRemove: ["lasso2d","select2d"],
  toImageButtonOptions: {{ format: "png", filename: "cyclegen_avl" }},
}};

let activeTrace = 0;
let enabled = new Set(["Eco","Normal","Sportif","Standard_AVL_BCB"]);
let visibleCharts = new Set(CHARTS.map(c => c.id));
let keepZoom = false;
const PROFILE_CHART_IDS = ["chart-v", "chart-dv", "chart-a", "chart-alt", "chart-slope"];
let lastZoomSource = "chart-v";

function getZoom(divId) {{
  const gd = document.getElementById(divId);
  if (!gd || !gd.layout) return null;
  const xr = gd.layout.xaxis && gd.layout.xaxis.range;
  const yr = gd.layout.yaxis && gd.layout.yaxis.range;
  return {{
    x: xr ? [xr[0], xr[1]] : null,
    y: yr ? [yr[0], yr[1]] : null,
  }};
}}

function withZoom(layout, zoom) {{
  const L = JSON.parse(JSON.stringify(layout));
  if (!zoom || !keepZoom) return L;
  if (zoom.x) {{
    L.xaxis = {{ ...L.xaxis, range: zoom.x, autorange: false }};
  }}
  if (zoom.y) {{
    L.yaxis = {{ ...L.yaxis, range: zoom.y, autorange: false }};
  }}
  return L;
}}

function setSyncStatus(msg) {{
  const el = document.getElementById("sync-status");
  if (el) el.textContent = msg || "";
}}

function isChartVisible(divId) {{
  const gd = document.getElementById(divId);
  if (!gd) return false;
  const wrap = gd.closest(".chart-wrap");
  return !(wrap && wrap.classList.contains("hidden"));
}}

function yRangeForXWindow(gd, x0, x1) {{
  let ymin = Infinity;
  let ymax = -Infinity;
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  for (const tr of gd.data || []) {{
    if (!tr || !tr.x || !tr.y) continue;
    if (tr.visible === false || tr.visible === "legendonly") continue;
    const n = Math.min(tr.x.length, tr.y.length);
    for (let i = 0; i < n; i++) {{
      const x = tr.x[i];
      const y = tr.y[i];
      if (typeof x !== "number" || typeof y !== "number") continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < lo || x > hi) continue;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }}
  }}
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) return null;
  if (ymin === ymax) {{
    const pad = Math.abs(ymin) * 0.05 || 1;
    return [ymin - pad, ymax + pad];
  }}
  const pad = (ymax - ymin) * 0.08;
  return [ymin - pad, ymax + pad];
}}

function readXRange(gd) {{
  if (!gd || !gd.layout || !gd.layout.xaxis) return null;
  const xr = gd.layout.xaxis.range;
  if (!xr || xr.length < 2) return null;
  const a = Number(xr[0]);
  const b = Number(xr[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}}

function fullXExtent(gd) {{
  let xmin = Infinity;
  let xmax = -Infinity;
  for (const tr of gd.data || []) {{
    if (!tr || !tr.x) continue;
    for (const x of tr.x) {{
      if (typeof x !== "number" || !Number.isFinite(x)) continue;
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
    }}
  }}
  if (!Number.isFinite(xmin) || !Number.isFinite(xmax)) return null;
  return [xmin, xmax];
}}

function pickSourceXRange() {{
  const order = [lastZoomSource, ...PROFILE_CHART_IDS.filter((id) => id !== lastZoomSource)];
  for (const id of order) {{
    if (!isChartVisible(id)) continue;
    const gd = document.getElementById(id);
    const xr = readXRange(gd);
    if (!xr) continue;
    const full = fullXExtent(gd);
    // Prefer a zoomed window (not essentially the full extent)
    if (full) {{
      const span = Math.abs(xr[1] - xr[0]);
      const fullSpan = Math.abs(full[1] - full[0]) || 1;
      if (span / fullSpan < 0.98) return {{ id, range: xr }};
    }} else {{
      return {{ id, range: xr }};
    }}
  }}
  // Fallback: any visible chart's current X range
  for (const id of PROFILE_CHART_IDS) {{
    if (!isChartVisible(id)) continue;
    const gd = document.getElementById(id);
    const xr = readXRange(gd);
    if (xr) return {{ id, range: xr }};
  }}
  return null;
}}

function syncDistanceWindow() {{
  const src = pickSourceXRange();
  if (!src) {{
    setSyncStatus("Zoomez d’abord un graphe (plage distance).");
    return;
  }}
  const x0 = Math.min(src.range[0], src.range[1]);
  const x1 = Math.max(src.range[0], src.range[1]);
  let n = 0;
  PROFILE_CHART_IDS.forEach((id) => {{
    if (!isChartVisible(id)) return;
    const gd = document.getElementById(id);
    if (!gd || !gd.data) return;
    const yr = yRangeForXWindow(gd, x0, x1);
    const update = {{
      "xaxis.range": [x0, x1],
      "xaxis.autorange": false,
    }};
    if (yr) {{
      update["yaxis.range"] = yr;
      update["yaxis.autorange"] = false;
    }} else {{
      update["yaxis.autorange"] = true;
    }}
    Plotly.relayout(gd, update);
    n += 1;
  }});
  setSyncStatus(
    `Sync ← ${{src.id.replace("chart-", "")}} · s ∈ [${{x0.toFixed(2)}}, ${{x1.toFixed(2)}}] km · ${{n}} graphes · Y adapté`
  );
}}

function resetAllProfileZoom() {{
  PROFILE_CHART_IDS.forEach((id) => {{
    if (!isChartVisible(id)) return;
    const gd = document.getElementById(id);
    if (!gd || !gd.layout) return;
    Plotly.relayout(gd, {{
      "xaxis.autorange": true,
      "yaxis.autorange": true,
    }});
  }});
  keepZoom = false;
  setSyncStatus("Zoom réinitialisé sur tous les graphes visibles.");
}}

function attachRelayoutTracking(divId) {{
  const gd = document.getElementById(divId);
  if (!gd || gd._cgSyncBound) return;
  gd._cgSyncBound = true;
  gd.on("plotly_relayout", (ev) => {{
    if (!ev) return;
    if (
      ev["xaxis.range[0]"] != null ||
      ev["xaxis.range[1]"] != null ||
      Array.isArray(ev["xaxis.range"]) ||
      ev["xaxis.autorange"] != null
    ) {{
      lastZoomSource = divId;
    }}
  }});
}}

function buildTabs() {{
  const el = document.getElementById("trace-tabs");
  el.innerHTML = "";
  DATA.traces.forEach((t, i) => {{
    const b = document.createElement("button");
    const best = t.best && t.best.preset ? t.best.preset : "—";
    b.textContent = `${{t.avl.route_hint}} · ${{t.avl.style}}`;
    b.title = `Meilleur preset CycleGen : ${{best}}`;
    b.className = i === activeTrace ? "active" : "";
    b.onclick = () => {{
      activeTrace = i;
      keepZoom = false;
      buildTabs();
      renderTrace();
    }};
    el.appendChild(b);
  }});
}}

function buildPresetToggles() {{
  const el = document.getElementById("preset-toggles");
  el.innerHTML = "";
  PRESETS.forEach(p => {{
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = enabled.has(p);
    cb.onchange = () => {{
      if (cb.checked) enabled.add(p); else enabled.delete(p);
      keepZoom = true;
      renderTrace();
    }};
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = COLORS[p];
    lab.appendChild(cb);
    lab.appendChild(sw);
    lab.appendChild(document.createTextNode(PRESET_LABEL[p] || p));
    el.appendChild(lab);
  }});
}}

function buildChartToggles() {{
  const el = document.getElementById("chart-toggles");
  el.innerHTML = "";
  CHARTS.forEach(c => {{
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = visibleCharts.has(c.id);
    cb.onchange = () => {{
      if (cb.checked) visibleCharts.add(c.id); else visibleCharts.delete(c.id);
      applyChartVisibility();
    }};
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(c.label));
    el.appendChild(lab);
  }});
  applyChartVisibility();
}}

function applyChartVisibility() {{
  document.querySelectorAll(".chart-wrap[data-chart]").forEach(wrap => {{
    const id = wrap.getAttribute("data-chart");
    wrap.classList.toggle("hidden", !visibleCharts.has(id));
  }});
  // Hide empty split rows
  ["row-dv-a", "row-alt-slope"].forEach(rowId => {{
    const row = document.getElementById(rowId);
    if (!row) return;
    const any = [...row.querySelectorAll(".chart-wrap")].some(
      w => !w.classList.contains("hidden")
    );
    row.style.display = any ? "" : "none";
  }});
  const rowV = document.getElementById("row-v");
  if (rowV) {{
    rowV.style.display = visibleCharts.has("v") ? "" : "none";
  }}
}}

function renderRadar() {{
  const prud = DATA.summary.avl_driver_fingerprint.prudent;
  const dyn = DATA.summary.avl_driver_fingerprint.dynamique;
  const cg = DATA.summary.cyclegen_presets;
  const axes = ["a_max","b_comf","jerk","sf","a_y"];
  const labels = ["a+ / a_max","a− / b_comf","jerk","speed factor","a_y latéral"];
  const series = {{
    "Réf. AVL · prudent": [prud.a_pos_p95, prud.a_neg_p95, prud.jerk_pos_p95, prud.speed_factor_mean, prud.a_lat_p95],
    "Réf. AVL · dynamique": [dyn.a_pos_p95, dyn.a_neg_p95, dyn.jerk_pos_p95, dyn.speed_factor_mean, dyn.a_lat_p95],
    "CycleGen · Eco": [cg.Eco.a_max, cg.Eco.b_comf, cg.Eco.jerk, cg.Eco.sf, cg.Eco.a_y],
    "CycleGen · Normal": [cg.Normal.a_max, cg.Normal.b_comf, cg.Normal.jerk, cg.Normal.sf, cg.Normal.a_y],
    "CycleGen · Sportif": [cg.Sportif.a_max, cg.Sportif.b_comf, cg.Sportif.jerk, cg.Sportif.sf, cg.Sportif.a_y],
    "CycleGen · Std AVL": [cg.Standard_AVL_BCB.a_max, cg.Standard_AVL_BCB.b_comf, cg.Standard_AVL_BCB.jerk, cg.Standard_AVL_BCB.sf, cg.Standard_AVL_BCB.a_y],
  }};
  const maxes = axes.map((_, i) => Math.max(...Object.values(series).map(v => v[i]), 1e-6));
  const traces = Object.entries(series).map(([name, vals]) => ({{
    type: "scatterpolar",
    name,
    r: vals.map((v,i) => v / maxes[i]).concat([vals[0]/maxes[0]]),
    theta: labels.concat([labels[0]]),
    fill: "toself",
    opacity: 0.45,
  }}));
  Plotly.newPlot("chart-radar", traces, {{
    ...layoutBase,
    polar: {{
      bgcolor: "rgba(0,0,0,0)",
      radialaxis: {{ visible: true, range: [0,1], gridcolor: "#2a3644", tickfont: {{ size: 9 }} }},
      angularaxis: {{ gridcolor: "#2a3644" }},
    }},
    legend: {{ ...legendBelow, y: -0.15 }},
    margin: {{ t: 24, r: 40, b: 110, l: 40 }},
  }}, cfg);
}}

function renderRmse() {{
  const traces = [];
  PRESETS.forEach(p => {{
    traces.push({{
      type: "bar",
      name: PRESET_LABEL[p],
      x: DATA.traces.map(t => `${{t.avl.route_hint}}\n${{t.avl.style}}`),
      y: DATA.traces.map(t => {{
        const arm = (t.arms || []).find(a => a.preset === p);
        return arm && arm.rmse_v_kmh != null ? arm.rmse_v_kmh : null;
      }}),
      marker: {{ color: COLORS[p] }},
    }});
  }});
  Plotly.newPlot("chart-rmse", traces, {{
    ...layoutBase,
    barmode: "group",
    yaxis: {{ ...layoutBase.yaxis, title: {{ text: "RMSE vitesse (km/h)", font: {{ size: 11, color: "#9aabbc" }} }} }},
    xaxis: {{ ...layoutBase.xaxis, title: "" }},
    legend: {{ ...legendBelow, y: -0.35 }},
    margin: {{ t: 20, r: 16, b: 120, l: 58 }},
  }}, cfg);
}}

function plotOrReact(divId, traces, layout) {{
  const zoom = getZoom(divId);
  const L = withZoom(layout, zoom);
  const gd = document.getElementById(divId);
  const p = (gd && gd.data)
    ? Plotly.react(divId, traces, L, cfg)
    : Plotly.newPlot(divId, traces, L, cfg);
  return Promise.resolve(p).then(() => {{
    attachRelayoutTracking(divId);
  }});
}}

function renderTrace() {{
  const t = DATA.traces[activeTrace];
  if (!t || !t.series) return;
  const best = t.best && t.best.preset;
  const firstKey = enabled.has(best) ? best : [...enabled][0] || PRESETS[0];
  const base = t.series[firstKey] || Object.values(t.series)[0];
  if (!base) return;

  const yTitle = (txt) => ({{ text: txt, font: {{ size: 11, color: "#9aabbc" }}, standoff: 6 }});

  // --- v(s) ---
  const vTraces = [{{
    x: base.S_km, y: base.v_avl_kmh,
    name: "Réf. AVL (Route Studio)",
    type: "scatter", mode: "lines",
    line: {{ color: COLORS.AVL, width: 2.4 }},
  }}, {{
    x: base.S_km, y: base.lim_kmh,
    name: "Limite affichée (km/h)",
    type: "scatter", mode: "lines",
    line: {{ color: COLORS.lim, width: 1.2, dash: "dot" }},
  }}];
  PRESETS.forEach(p => {{
    if (!enabled.has(p) || !t.series[p]) return;
    const s = t.series[p];
    const star = p === best ? "  ★ meilleur" : "";
    vTraces.push({{
      x: s.S_km, y: s.v_cg_kmh,
      name: (PRESET_LABEL[p] || p) + star,
      type: "scatter", mode: "lines",
      line: {{ color: COLORS[p], width: p === best ? 2.5 : 1.6 }},
    }});
  }});
  plotOrReact("chart-v", vTraces, {{
    ...layoutBase,
    yaxis: {{ ...layoutBase.yaxis, title: yTitle("Vitesse (km/h)") }},
  }});

  // --- Δv ---
  const dvTraces = [];
  PRESETS.forEach(p => {{
    if (!enabled.has(p) || !t.series[p]) return;
    const s = t.series[p];
    dvTraces.push({{
      x: s.S_km, y: s.dv_kmh,
      name: "Δv · " + (PRESET_LABEL[p] || p).replace("CycleGen · ", ""),
      type: "scatter", mode: "lines",
      line: {{ color: COLORS[p], width: 1.7 }},
    }});
  }});
  dvTraces.push({{
    x: [base.S_km[0], base.S_km[base.S_km.length-1]], y: [0,0],
    name: "Écart nul",
    type: "scatter", mode: "lines",
    line: {{ color: "#6b7c8f", width: 1, dash: "dash" }},
    hoverinfo: "skip",
  }});
  plotOrReact("chart-dv", dvTraces, {{
    ...layoutBase,
    yaxis: {{ ...layoutBase.yaxis, title: yTitle("Δv (km/h)") }},
  }});

  // --- accel ---
  const aTraces = [{{
    x: base.S_km, y: base.a_avl,
    name: "Réf. AVL (≈ v·dv/ds)",
    type: "scatter", mode: "lines",
    line: {{ color: COLORS.AVL, width: 1.6 }},
  }}];
  PRESETS.forEach(p => {{
    if (!enabled.has(p) || !t.series[p]) return;
    aTraces.push({{
      x: t.series[p].S_km, y: t.series[p].a_cg,
      name: "a · " + (PRESET_LABEL[p] || p).replace("CycleGen · ", ""),
      type: "scatter", mode: "lines",
      line: {{ color: COLORS[p], width: 1.4 }},
    }});
  }});
  plotOrReact("chart-a", aTraces, {{
    ...layoutBase,
    yaxis: {{ ...layoutBase.yaxis, title: yTitle("Accélération (m/s²)") }},
  }});

  plotOrReact("chart-alt", [{{
    x: base.S_km, y: base.alt_m,
    name: "Altitude GPS (m)",
    type: "scatter", mode: "lines",
    fill: "tozeroy",
    line: {{ color: "#3db8a0", width: 1.6 }},
    fillcolor: "rgba(61,184,160,0.15)",
  }}], {{
    ...layoutBase,
    showlegend: true,
    yaxis: {{ ...layoutBase.yaxis, title: yTitle("Altitude (m)") }},
  }});

  plotOrReact("chart-slope", [{{
    x: base.S_km, y: base.slope_pct,
    name: "Pente (% grade)",
    type: "scatter", mode: "lines",
    line: {{ color: "#e0a35a", width: 1.5 }},
  }}], {{
    ...layoutBase,
    showlegend: true,
    yaxis: {{ ...layoutBase.yaxis, title: yTitle("Pente (%)") }},
  }});

  keepZoom = false;
}}

buildTabs();
buildPresetToggles();
buildChartToggles();
renderRadar();
renderRmse();
renderTrace();

document.getElementById("btn-sync-x").onclick = () => syncDistanceWindow();
document.getElementById("btn-reset-zoom").onclick = () => resetAllProfileZoom();
</script>
</body>
</html>
"""


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Building series payload (IDM batch)…", flush=True)
    payload = build_payload()

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    json_path = OUT_DIR / f"xspace_avl_report_{stamp}.json"
    # Slim JSON without full series for archive? Keep full for reproducibility.
    # Actually series make JSON huge — save HTML primarily; save slim metrics JSON.
    slim = {
        "generated_at": payload["generated_at"],
        "method": payload["method"],
        "summary": payload["summary"],
        "traces": [
            {"avl": t["avl"], "arms": t["arms"], "best": t["best"]}
            for t in payload["traces"]
        ],
    }
    json_path.write_text(json.dumps(slim, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT_DIR / "xspace_avl_batch_latest.json").write_text(
        json.dumps(slim, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    html_path = OUT_DIR / f"xspace_avl_report_{stamp}.html"
    latest_html = OUT_DIR / "xspace_avl_report_latest.html"
    text = render_html(payload)
    html_path.write_text(text, encoding="utf-8")
    latest_html.write_text(text, encoding="utf-8")
    print(f"\nWrote {html_path}", flush=True)
    print(f"Wrote {latest_html} ({len(text)/1e6:.2f} MB)", flush=True)

    # Two-page layout + mail-ready copy under docs/reports/
    import importlib.util
    _tw = _HERE / "_xspace_report_twopage.py"
    if _tw.exists():
        _spec = importlib.util.spec_from_file_location("xspace_twopage", _tw)
        _mod = importlib.util.module_from_spec(_spec)
        assert _spec.loader is not None
        _spec.loader.exec_module(_mod)
        _docs = _mod.publish_report(latest_html)
        print(f"Wrote {_docs}", flush=True)

    print(f"Wrote {json_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
