#!/usr/bin/env python3
"""Recette N90 via HERE Routing v8 + homologation flags → CSV 1 Hz.

Requires HERE_API_KEY in the environment (or repo-root /.env).

Usage:
    cd backend && ../.venv/bin/python ../scripts/recette_here_n90.py
"""

from __future__ import annotations

import asyncio
import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
_BACKEND = _ROOT / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# Load .env from repo root if present
_env = _ROOT / ".env"
if _env.is_file():
    try:
        from dotenv import load_dotenv

        load_dotenv(_env)
    except ImportError:
        pass

from app.models.schemas import DriverProfile  # noqa: E402
from app.services.data_fetcher import SpatialDataAcquisition  # noqa: E402
from app.services.kinematic_solver import IDMSolver  # noqa: E402
from app.services.spatial_processor import build_spatial_corridor  # noqa: E402

# Bourg-Saint-Maurice → Albertville (N90), approx Gemini / AVL endpoints
ORIGIN = (45.6193, 6.7706)
DEST = (45.6755, 6.3927)

OUT_DIR = _BACKEND / "app" / "data" / "benchmark" / "calibration"


async def _run() -> int:
    key = os.getenv("HERE_API_KEY", "").strip()
    if not key:
        print("HERE_API_KEY missing — skip live HERE recette (set in .env).")
        return 2

    print("HERE N90 — analyze route…", flush=True)
    async with SpatialDataAcquisition() as acq:
        route = await acq.get_route_data(
            ORIGIN[0],
            ORIGIN[1],
            DEST[0],
            DEST[1],
            depart_at=datetime.now(timezone.utc),
            a_y_mps2=3.5,
            routing_profile="HERE/ADAS",
        )

    print(
        f"  traffic_source={route.traffic_source} elev={route.elevation_source} "
        f"L={route.distance_m/1000:.2f} km pts={len(route.geometry)}",
        flush=True,
    )

    corridor = build_spatial_corridor(
        route,
        a_y_mps2=3.5,
        enable_speed_limits=True,
        global_max_speed_kmh=130.0,
        include_traffic_in_envelope=False,
    )
    print(
        f"  corridor S={len(corridor.S)} V_env max="
        f"{max(corridor.V_envelope)*3.6:.1f} km/h",
        flush=True,
    )

    profile = IDMSolver(
        corridor,
        DriverProfile.NORMAL,
        seed=42,
        max_speed_mps=130.0 / 3.6,
        enable_markov=False,
        param_overrides={
            "a_max": 2.0,
            "b_comf": 1.2,
            "speed_factor": 1.0,
            "T": 1.5,
            "T_h": 4.0,
            "s0": 2.0,
            "jerk_max": 1.5,
            "jerk_brake_max": 3.0,
        },
    ).solve()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    csv_path = OUT_DIR / f"here_n90_{stamp}.csv"
    json_path = OUT_DIR / f"here_n90_{stamp}.json"
    latest_csv = OUT_DIR / "here_n90_latest.csv"
    latest_json = OUT_DIR / "here_n90_latest.json"

    # Resample / write 1 Hz rows from profile
    rows = []
    t = list(profile.time)
    v = list(profile.velocity)
    a = list(profile.acceleration)
    s = list(profile.position)
    # alpha may be on corridor only — interpolate via distance
    alpha = list(corridor.alpha)
    S_corr = list(corridor.S)

    def _alpha_at(s_m: float) -> float:
        if not S_corr or not alpha:
            return 0.0
        if s_m <= S_corr[0]:
            return float(alpha[0])
        if s_m >= S_corr[-1]:
            return float(alpha[-1])
        for i in range(len(S_corr) - 1):
            if S_corr[i] <= s_m <= S_corr[i + 1]:
                w = (s_m - S_corr[i]) / max(S_corr[i + 1] - S_corr[i], 1e-9)
                return float(alpha[i] * (1 - w) + alpha[i + 1] * w)
        return float(alpha[-1])

    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        wtr = csv.writer(fh)
        wtr.writerow(["t_s", "v_mps", "a_mps2", "s_m", "slope_rad", "slope_pct"])
        for i in range(len(t)):
            al = _alpha_at(float(s[i]))
            row = [
                round(float(t[i]), 3),
                round(float(v[i]), 6),
                round(float(a[i]), 6),
                round(float(s[i]), 3),
                round(al, 6),
                round(100.0 * al, 4),
            ]
            wtr.writerow(row)
            rows.append(row)

    summary = {
        "stamp": stamp,
        "origin": ORIGIN,
        "destination": DEST,
        "traffic_source": route.traffic_source,
        "elevation_source": route.elevation_source,
        "distance_m": route.distance_m,
        "duration_sim_s": float(t[-1]) if t else 0.0,
        "n_rows": len(rows),
        "enable_speed_limits": True,
        "global_max_speed_kmh": 130.0,
        "include_traffic_in_envelope": False,
        "enable_markov": False,
        "csv": str(csv_path.name),
    }
    json_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    latest_csv.write_text(csv_path.read_text(encoding="utf-8"), encoding="utf-8")
    latest_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"  wrote {csv_path} ({len(rows)} rows)", flush=True)
    print(f"  summary {json_path}", flush=True)
    return 0


def main() -> int:
    return asyncio.run(_run())


if __name__ == "__main__":
    raise SystemExit(main())
