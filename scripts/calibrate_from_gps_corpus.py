#!/usr/bin/env python3
"""Batch calibrate CycleGen IDM/TLS params against all GPS corpus trips.

Pipeline per source (has_geo):
  1. Load GPS series (lat/lon/v/t)
  2. POST /api/route/analyze  (A→vias→B from GPS)
  3. POST /api/corridor/build
  4. Mutate TLS density variants (feux keep-frac)
  5. POST /api/scenario/run    (grid of arms ≤8 per call)
  6. POST /api/benchmark/run   (align=time vs corpus id)

Aggregates a score-weighted mean of the best arms across trips and writes
JSON + markdown under backend/app/data/benchmark/calibration/.

Usage:
  cd backend && ../.venv/bin/python ../scripts/calibrate_from_gps_corpus.py
  # or:
  CYCLEGEN_API=http://127.0.0.1:8001 python scripts/calibrate_from_gps_corpus.py
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_API = os.getenv("CYCLEGEN_API", "http://127.0.0.1:8001")
OUT_DIR = ROOT / "backend" / "app" / "data" / "benchmark" / "calibration"


@dataclass(frozen=True)
class ArmSpec:
    id: str
    driver_profile: str
    tls_override: str
    speed_factor: float | None
    a_max: float | None
    b_comf: float | None
    feux_keep: float  # 1.0 = OSM as-is; <1 thin; >1 densify
    seed: int = 42

    def to_api(self) -> dict[str, Any]:
        params: dict[str, float] = {}
        if self.speed_factor is not None:
            params["speed_factor"] = self.speed_factor
        if self.a_max is not None:
            params["a_max"] = self.a_max
        if self.b_comf is not None:
            params["b_comf"] = self.b_comf
        body: dict[str, Any] = {
            "id": self.id,
            "label": self.id,
            "driver_profile": self.driver_profile,
            "seed": self.seed,
            "tls_override": self.tls_override,
        }
        if params:
            body["driver_params"] = params
        return body


def build_search_grid() -> list[ArmSpec]:
    """Compact grid: aggressiveness × speed × TLS mode × feux density."""
    arms: list[ArmSpec] = []
    configs = [
        # (profile, sf, a_max, b_comf)
        ("Eco", 0.90, 1.5, 3.0),
        ("Normal", 1.00, 2.6, 4.5),
        ("Agressif", 1.15, 3.8, 6.5),
        ("Normal", 0.90, 2.2, 4.0),
        ("Normal", 1.10, 3.0, 5.0),
        ("Eco", 0.85, 1.3, 2.8),
        ("Agressif", 1.05, 3.2, 5.5),
        ("Normal", 1.00, 2.6, 4.5),  # baseline reused with TLS/feux variants
    ]
    tls_modes = ["auto", "green_wave", "stochastic"]
    feux_keeps = [0.5, 1.0, 1.5]
    # Keep total manageable: profile×tls + feux on Normal/auto only
    for profile, sf, a_max, b_comf in configs[:7]:
        for tls in tls_modes:
            arms.append(
                ArmSpec(
                    id=f"{profile[:3]}_sf{sf:.2f}_{tls[:4]}",
                    driver_profile=profile,
                    tls_override=tls,
                    speed_factor=sf,
                    a_max=a_max,
                    b_comf=b_comf,
                    feux_keep=1.0,
                )
            )
    for fk in feux_keeps:
        if abs(fk - 1.0) < 1e-9:
            continue
        arms.append(
            ArmSpec(
                id=f"Nor_sf1.00_auto_fx{fk:.1f}",
                driver_profile="Normal",
                tls_override="auto",
                speed_factor=1.0,
                a_max=2.6,
                b_comf=4.5,
                feux_keep=fk,
            )
        )
    # Deduplicate by id
    seen: set[str] = set()
    uniq: list[ArmSpec] = []
    for a in arms:
        if a.id in seen:
            continue
        seen.add(a.id)
        uniq.append(a)
    return uniq


def score_kpis(k: dict[str, Any]) -> float:
    """Lower is better — multi-objective scalar for ranking."""
    rmse = float(k.get("rmse_v") or 0.0)
    mae = float(k.get("mae_v") or 0.0)
    bias = abs(float(k.get("bias_v") or 0.0))
    d_dur = abs(float(k.get("delta_duration_pct") or 0.0)) / 100.0
    stops_g = float(k.get("stops_gen") or 0.0)
    stops_r = float(k.get("stops_ref") or 0.0)
    stop_pen = abs(stops_g - stops_r) / max(stops_r, 1.0)
    p95_g = float(k.get("p95_abs_accel_gen") or 0.0)
    p95_r = float(k.get("p95_abs_accel_ref") or 0.0)
    accel_pen = abs(p95_g - p95_r) / max(p95_r, 0.5)
    return (
        1.0 * rmse
        + 0.5 * mae
        + 0.4 * bias
        + 0.8 * d_dur
        + 0.6 * stop_pen
        + 0.35 * accel_pen
    )


def subsample_vias(
    lat: list[float], lon: list[float], *, max_vias: int = 12, min_spacing_m: float = 600.0
) -> list[dict[str, Any]]:
    """Pick intermediate GPS points as routing vias (exclude ends)."""
    n = min(len(lat), len(lon))
    if n < 4:
        return []
    vias: list[dict[str, Any]] = []
    last_lat, last_lon = lat[0], lon[0]
    for i in range(1, n - 1):
        d = haversine_m(last_lat, last_lon, lat[i], lon[i])
        if d < min_spacing_m:
            continue
        vias.append({"lat": lat[i], "lon": lon[i], "label": f"via{len(vias)+1}", "stop_duration_s": 0})
        last_lat, last_lon = lat[i], lon[i]
        if len(vias) >= max_vias:
            break
    return vias


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def mutate_feux(corridor: dict[str, Any], keep: float) -> dict[str, Any]:
    """Thin (keep<1) or densify (keep>1) traffic lights along the corridor."""
    c = copy.deepcopy(corridor)
    s_feux = list(c.get("S_feux") or [])
    meta = list(c.get("feux_meta") or [])
    if not s_feux and keep <= 1.0:
        return c
    if keep < 1.0 - 1e-9:
        # Keep every Nth by index, preserve order
        n = max(1, int(round(len(s_feux) * keep)))
        if n >= len(s_feux):
            return c
        idxs = [
            round(i * (len(s_feux) - 1) / max(n - 1, 1)) for i in range(n)
        ]
        idxs = sorted(set(idxs))
        c["S_feux"] = [s_feux[i] for i in idxs]
        if meta and len(meta) == len(s_feux):
            c["feux_meta"] = [meta[i] for i in idxs]
        else:
            c["feux_meta"] = [{"s_m": s, "tls_mode": "stochastic"} for s in c["S_feux"]]
        return c
    if keep > 1.0 + 1e-9:
        # Insert midpoints between consecutive lights (and/or synth if empty)
        s_end = float((c.get("S") or [0])[-1] or 0)
        if not s_feux and s_end > 200:
            # Synthetic lights densified from a 400 m baseline
            step = 400.0 / keep
            synth = [i * step for i in range(1, int(s_end / step))]
            c["S_feux"] = synth
            c["feux_meta"] = [{"s_m": s, "tls_mode": "stochastic"} for s in synth]
            return c
        new_s = list(s_feux)
        extras: list[float] = []
        for a, b in zip(s_feux, s_feux[1:]):
            extras.append(0.5 * (a + b))
        if s_feux and s_feux[0] > 80:
            extras.append(0.5 * s_feux[0])
        if s_feux and s_end - s_feux[-1] > 80:
            extras.append(0.5 * (s_feux[-1] + s_end))
        n_extra = max(0, int(round(len(s_feux) * (keep - 1.0))))
        extras = extras[:n_extra] if n_extra else extras[: max(len(s_feux), 1)]
        merged = sorted(set(new_s + extras))
        c["S_feux"] = merged
        c["feux_meta"] = [{"s_m": s, "tls_mode": "stochastic"} for s in merged]
        return c
    return c


def chunked(seq: list[ArmSpec], n: int) -> list[list[ArmSpec]]:
    return [seq[i : i + n] for i in range(0, len(seq), n)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--max-sources", type=int, default=0, help="0 = all geo")
    parser.add_argument("--skip-demo", action="store_true", help="Skip synthetic demo GPS")
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    args = parser.parse_args()

    client = httpx.Client(base_url=args.api.rstrip("/"), timeout=httpx.Timeout(args.timeout, connect=30.0))
    try:
        h = client.get("/health")
        h.raise_for_status()
    except Exception as exc:
        print(f"API unavailable at {args.api}: {exc}", file=sys.stderr)
        return 1

    sources = client.get("/api/benchmark/sources").json()
    geo = [s for s in sources if s.get("has_geo")]
    if args.skip_demo:
        geo = [s for s in geo if not str(s.get("id", "")).startswith("demo_")]
    if args.max_sources > 0:
        geo = geo[: args.max_sources]

    grid = build_search_grid()
    print(f"GPS sources: {len(geo)} | arm grid: {len(grid)}", flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    per_source: list[dict[str, Any]] = []
    best_arms: list[dict[str, Any]] = []

    depart_at = datetime.now(timezone.utc).isoformat()

    for si, src in enumerate(geo):
        sid = src["id"]
        print(f"\n===== [{si+1}/{len(geo)}] {sid} =====", flush=True)
        t0 = time.time()
        series = client.get(f"/api/benchmark/sources/{sid}").json()
        lat = series.get("lat") or []
        lon = series.get("lon") or []
        if len(lat) < 2 or len(lon) < 2:
            print("  skip: no lat/lon", flush=True)
            continue

        vias = subsample_vias(lat, lon)
        payload = {
            "lat_a": lat[0],
            "lon_a": lon[0],
            "lat_b": lat[-1],
            "lon_b": lon[-1],
            "waypoints": vias,
            "routing_profile": "Mapbox/Traffic",
            "depart_at": depart_at,
            "a_y_mps2": 2.5,
        }
        r = client.post("/api/route/analyze", json=payload)
        if r.status_code != 200:
            print(f"  analyze FAIL {r.status_code}: {r.text[:300]}", flush=True)
            continue
        route = r.json()
        print(
            f"  analyze ok geom={len(route.get('geometry') or [])} "
            f"dist_km={(route.get('distance_m') or 0)/1000:.1f} vias={len(vias)}",
            flush=True,
        )

        r2 = client.post("/api/corridor/build", json={"route": route, "a_y_mps2": 2.5})
        if r2.status_code != 200:
            print(f"  corridor FAIL {r2.status_code}: {r2.text[:300]}", flush=True)
            continue
        corridor0 = r2.json()["corridor"]
        n_feux = len(corridor0.get("S_feux") or [])
        print(f"  corridor ok S={len(corridor0.get('S') or [])} feux={n_feux}", flush=True)

        # Group arms by feux_keep so we mutate corridor once per density
        by_feux: dict[float, list[ArmSpec]] = {}
        for arm in grid:
            by_feux.setdefault(arm.feux_keep, []).append(arm)

        source_rows: list[dict[str, Any]] = []
        for fk, arms in by_feux.items():
            corridor = mutate_feux(corridor0, fk)
            for batch in chunked(arms, 8):
                body = {
                    "corridor": corridor,
                    "arms": [a.to_api() for a in batch],
                    "reference_arm_id": batch[0].id,
                }
                r3 = client.post("/api/scenario/run", json=body)
                if r3.status_code != 200:
                    print(f"  scenario FAIL {r3.status_code}: {r3.text[:400]}", flush=True)
                    continue
                for arm_res, spec in zip(r3.json()["arms"], batch):
                    profile = arm_res["profile"]
                    rb = client.post(
                        "/api/benchmark/run",
                        json={
                            "profile": profile,
                            "reference_id": sid,
                            "align": "time",
                        },
                    )
                    if rb.status_code != 200:
                        print(
                            f"  bench FAIL {spec.id} {rb.status_code}: {rb.text[:200]}",
                            flush=True,
                        )
                        continue
                    bench = rb.json()
                    kpis = bench.get("kpis") or {}
                    sc = score_kpis(kpis)
                    row = {
                        "source_id": sid,
                        "arm_id": spec.id,
                        "driver_profile": spec.driver_profile,
                        "tls_override": spec.tls_override,
                        "speed_factor": spec.speed_factor,
                        "a_max": spec.a_max,
                        "b_comf": spec.b_comf,
                        "feux_keep": spec.feux_keep,
                        "n_feux_corridor": len(corridor.get("S_feux") or []),
                        "score": sc,
                        "kpis": kpis,
                        "hints": bench.get("recalibration_hints") or [],
                    }
                    source_rows.append(row)
                    print(
                        f"  {spec.id:28s} score={sc:.3f} rmse={kpis.get('rmse_v'):.2f} "
                        f"bias={kpis.get('bias_v'):+.2f} dT%={kpis.get('delta_duration_pct'):+.1f} "
                        f"stops={kpis.get('stops_gen')}/{kpis.get('stops_ref')}",
                        flush=True,
                    )

        if not source_rows:
            print("  no scored arms", flush=True)
            continue
        source_rows.sort(key=lambda r: r["score"])
        best = source_rows[0]
        best_arms.append(best)
        per_source.append(
            {
                "source_id": sid,
                "family": src.get("family"),
                "n_feux_osm": n_feux,
                "best": best,
                "top5": source_rows[:5],
                "elapsed_s": time.time() - t0,
            }
        )
        print(
            f"  BEST {best['arm_id']} score={best['score']:.3f} "
            f"({time.time()-t0:.0f}s)",
            flush=True,
        )

    # Aggregate recommended mean params (score-weighted among bests)
    summary = aggregate(best_arms, per_source)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_json = args.out / f"calibration_{stamp}.json"
    out_md = args.out / f"calibration_{stamp}.md"
    latest_json = args.out / "latest.json"
    latest_md = args.out / "latest.md"

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "api": args.api,
        "n_sources": len(per_source),
        "grid_size": len(grid),
        "recommended": summary,
        "per_source": per_source,
    }
    out_json.write_text(json.dumps(report, indent=2) + "\n")
    latest_json.write_text(json.dumps(report, indent=2) + "\n")
    md = render_markdown(report)
    out_md.write_text(md)
    latest_md.write_text(md)
    print(f"\nWrote {out_json}\nWrote {out_md}", flush=True)
    print("\n=== RECOMMENDED ===", flush=True)
    print(json.dumps(summary, indent=2), flush=True)
    client.close()
    return 0 if per_source else 2


def aggregate(bests: list[dict[str, Any]], per_source: list[dict[str, Any]]) -> dict[str, Any]:
    if not bests:
        return {}
    # Softmax-ish weights from scores (lower better)
    scores = [max(1e-6, float(b["score"])) for b in bests]
    inv = [1.0 / s for s in scores]
    wsum = sum(inv) or 1.0
    weights = [w / wsum for w in inv]

    def wavg(key: str) -> float | None:
        vals = [(b.get(key), w) for b, w in zip(bests, weights) if b.get(key) is not None]
        if not vals:
            return None
        return sum(v * w for v, w in vals) / sum(w for _, w in vals)

    # Majority vote for categorical
    def majority(key: str) -> str | None:
        votes: dict[str, float] = {}
        for b, w in zip(bests, weights):
            k = b.get(key)
            if k is None:
                continue
            votes[str(k)] = votes.get(str(k), 0.0) + w
        if not votes:
            return None
        return max(votes.items(), key=lambda kv: kv[1])[0]

    return {
        "driver_profile": majority("driver_profile"),
        "tls_override": majority("tls_override"),
        "speed_factor": round(wavg("speed_factor") or 1.0, 3),
        "a_max": round(wavg("a_max") or 2.6, 3),
        "b_comf": round(wavg("b_comf") or 4.5, 3),
        "feux_keep": round(wavg("feux_keep") or 1.0, 3),
        "mean_best_score": round(sum(scores) / len(scores), 4),
        "mean_best_rmse_v": round(
            sum(float((b.get("kpis") or {}).get("rmse_v") or 0) for b in bests) / len(bests),
            4,
        ),
        "n_trips": len(bests),
        "families": sorted({p.get("family") for p in per_source if p.get("family")}),
        "note": (
            "Score-weighted mean of per-trip best arms. "
            "Apply as default Normal physics / TLS preset; re-check on Grossglockner / urban separately."
        ),
    }


def render_markdown(report: dict[str, Any]) -> str:
    rec = report.get("recommended") or {}
    lines = [
        "# CycleGen GPS corpus calibration",
        "",
        f"Generated: `{report.get('generated_at')}`",
        f"Sources: **{report.get('n_sources')}** · Grid arms: **{report.get('grid_size')}**",
        "",
        "## Recommended average parameters",
        "",
        f"- **driver_profile**: `{rec.get('driver_profile')}`",
        f"- **tls_override**: `{rec.get('tls_override')}`",
        f"- **speed_factor**: `{rec.get('speed_factor')}`",
        f"- **a_max**: `{rec.get('a_max')}` m/s²",
        f"- **b_comf**: `{rec.get('b_comf')}` m/s²",
        f"- **feux_keep** (TLS density vs OSM): `{rec.get('feux_keep')}`",
        f"- Mean best RMSE_v: `{rec.get('mean_best_rmse_v')}` m/s",
        f"- Mean best score: `{rec.get('mean_best_score')}`",
        "",
        "## Per-source best arms",
        "",
        "| Source | Profile | TLS | sf | a_max | feux | score | RMSE | ΔT% |",
        "|--------|---------|-----|----|-------|------|-------|------|-----|",
    ]
    for p in report.get("per_source") or []:
        b = p.get("best") or {}
        k = b.get("kpis") or {}
        lines.append(
            f"| `{p.get('source_id')}` | {b.get('driver_profile')} | {b.get('tls_override')} | "
            f"{b.get('speed_factor')} | {b.get('a_max')} | {b.get('feux_keep')} | "
            f"{b.get('score'):.3f} | {k.get('rmse_v'):.2f} | {k.get('delta_duration_pct'):+.1f} |"
        )
    lines.extend(
        [
            "",
            "## How to apply in UI",
            "",
            "1. Driver preset closest to recommended `driver_profile`.",
            "2. Override physics: `a_max`, `b_comf`, `speed_factor`.",
            "3. TLS mode: recommended `tls_override` (Scénarios D / editor).",
            "4. If `feux_keep` ≠ 1, thin/densify lights in the TLS editor before Simulate.",
            "",
        ]
    )
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
