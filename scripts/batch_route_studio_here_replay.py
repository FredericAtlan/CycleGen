#!/usr/bin/env python3
"""Batch: identify Route Studio drivers from 6 XLS → HERE corridor → IDM → full .xls.

1. Fingerprint prudent / dynamique across the 6 AVL Route Studio exports
2. Save drivers as Route_Studio_Prudent / Route_Studio_Dynamique
3. For each of 3 routes: HERE/ADAS A→B from RS GPS endpoints
4. Replay IDM (Markov OFF) with both identified drivers + XSPACE plant
5. Export CycleGen cycles as full-channel .xls (+ .xlsx twin)

Usage:
  cd backend && .venv/bin/python ../scripts/batch_route_studio_here_replay.py \\
      "/Volumes/Maximus/AVL Route Studio/"*.xls
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import xlrd
import xlwt

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_BACKEND = _REPO / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

_env = _REPO / ".env"
if _env.is_file():
    try:
        from dotenv import load_dotenv

        load_dotenv(_env)
    except ImportError:
        pass

from app.models.schemas import DriverProfile, LatLon  # noqa: E402
from app.services.curvature import curvature_radius_m  # noqa: E402
from app.services.data_fetcher import SpatialDataAcquisition  # noqa: E402
from app.services.kinematic_solver import IDMSolver  # noqa: E402
from app.services.spatial_processor import build_spatial_corridor  # noqa: E402

import batch_xspace_avl_compare as batch  # noqa: E402

OUT_DIR = _BACKEND / "app" / "data" / "benchmark" / "calibration" / "route_studio_here"
PUBLIC_DRIVERS = _REPO / "frontend" / "public" / "data" / "route_studio_drivers.json"

# Same plant as XSPACE batch (APR2-bis class).
XSPACE_VEHICLE = dict(batch.XSPACE_VEHICLE)

HEADERS = [
    "temps [s]",
    "distance [m]",
    "velocity [m/s]",
    "velocity [km/h]",
    "speed [rpm]",
    "torque [Nm]",
    "power",
    "gear",
    "lat",
    "lon",
    "alt [m]",
    "slope [%]",
    "curv [1/m]",
    "spd_lim [km/h]",
    "energy [joule]",
    "acc [m/s2]",
    "acc_lat [m/s2]",
    "btr_soc",
    "btr_v",
]


def _style(name: str) -> str:
    return batch.style_from_name(name)


def _route_key(name: str) -> str:
    hint = batch.route_hint(name).lower()
    if "iseran" in hint or "iseran" in name.lower():
        return "iseran"
    if "veleta" in hint or "veleta" in name.lower():
        return "veleta"
    if "stelvio" in hint or "stelvio" in name.lower():
        return "stelvio"
    return hint or "route"


def _pctile(xs: list[float], p: float) -> float:
    return batch.pctile(xs, p)


def _mean(xs: list[float]) -> float:
    return batch.mean(xs)


def identify_drivers(
    files: list[Path],
) -> tuple[dict[str, dict[str, float]], dict[str, Any]]:
    """Aggregate fingerprints → IDM overrides for Route_Studio_Prudent/Dynamique."""
    by_style: dict[str, list[Any]] = {"prudent": [], "dynamique": []}
    raw_fps: list[dict[str, Any]] = []
    for path in files:
        series = batch.load_xls(path)
        fp = batch.fingerprint(path, series)
        style = fp.style if fp.style in by_style else _style(path.name)
        by_style.setdefault(style, []).append(fp)
        raw_fps.append(asdict(fp))
        print(
            f"  FP {path.name}: style={style} a+p95={fp.a_pos_p95:.2f} "
            f"a-p95={fp.a_neg_p95:.2f} sf90={fp.speed_factor_p90:.3f} "
            f"a_y={fp.a_lat_p95:.2f}",
            flush=True,
        )

    def agg(style: str, attr: str) -> float:
        vals = [
            float(getattr(fp, attr))
            for fp in by_style.get(style, [])
            if math.isfinite(float(getattr(fp, attr)))
        ]
        return _mean(vals) if vals else float("nan")

    drivers: dict[str, dict[str, float]] = {}
    # Map fingerprint → IDM (same heuristic as batch recommended presets).
    for style, name in (
        ("prudent", "Route_Studio_Prudent"),
        ("dynamique", "Route_Studio_Dynamique"),
    ):
        a_pos = agg(style, "a_pos_p95")
        a_neg = agg(style, "a_neg_p95")
        j_pos = agg(style, "jerk_pos_p95")
        j_neg = agg(style, "jerk_neg_p95")
        sf = agg(style, "speed_factor_p90")
        a_y = agg(style, "a_lat_p95")
        if not math.isfinite(a_pos):
            raise RuntimeError(f"no fingerprints for style={style}")
        # Soft clamp so IDM stays stable
        drivers[name] = {
            "a_max": round(max(0.8, min(4.0, a_pos)), 3),
            "b_comf": round(max(0.8, min(5.0, a_neg)), 3),
            "jerk_max": round(max(0.4, min(5.0, j_pos if math.isfinite(j_pos) else 1.5)), 3),
            "jerk_brake_max": round(
                max(0.8, min(6.0, j_neg if math.isfinite(j_neg) else 2.5)), 3
            ),
            "speed_factor": round(
                max(0.9, min(1.2, sf if math.isfinite(sf) else 1.0)), 3
            ),
            "T": 1.8 if style == "prudent" else 1.2,
            "T_h": 4.5 if style == "prudent" else 3.0,
            "s0": 2.8 if style == "prudent" else 1.8,
            "a_y": round(max(2.0, min(6.0, a_y if math.isfinite(a_y) else 3.5)), 3),
            "base_profile": "Prudent" if style == "prudent" else "Dynamique",
        }
        print(f"  → {name}: {drivers[name]}", flush=True)

    meta = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_files": [p.name for p in files],
        "fingerprints": raw_fps,
        "drivers": drivers,
    }
    return drivers, meta


def endpoints_from_xls(path: Path) -> tuple[tuple[float, float], tuple[float, float]]:
    s = batch.load_xls(path)
    lat, lon = s["lat"], s["lon"]
    # Prefer first/last finite GPS with movement
    i0 = next(i for i in range(len(lat)) if math.isfinite(lat[i]) and math.isfinite(lon[i]))
    i1 = next(
        i
        for i in range(len(lat) - 1, -1, -1)
        if math.isfinite(lat[i]) and math.isfinite(lon[i])
    )
    return (lat[i0], lon[i0]), (lat[i1], lon[i1])


def _interp_on_s(
    S: list[float], y: list[float], s_m: float
) -> float:
    if not S:
        return 0.0
    if s_m <= S[0]:
        return y[0]
    if s_m >= S[-1]:
        return y[-1]
    lo, hi = 0, len(S) - 1
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if S[mid] <= s_m:
            lo = mid
        else:
            hi = mid
    s0, s1 = S[lo], S[hi]
    if s1 <= s0:
        return y[lo]
    u = (s_m - s0) / (s1 - s0)
    return y[lo] + u * (y[hi] - y[lo])


def _latlon_at(geometry: list[LatLon], S: list[float], s_m: float) -> tuple[float, float]:
    if not geometry:
        return 0.0, 0.0
    if s_m <= S[0]:
        return geometry[0].lat, geometry[0].lon
    if s_m >= S[-1]:
        return geometry[-1].lat, geometry[-1].lon
    lo, hi = 0, len(S) - 1
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if S[mid] <= s_m:
            lo = mid
        else:
            hi = mid
    s0, s1 = S[lo], S[hi]
    u = 0.0 if s1 <= s0 else (s_m - s0) / (s1 - s0)
    a, b = geometry[lo], geometry[hi]
    return a.lat + u * (b.lat - a.lat), a.lon + u * (b.lon - a.lon)


def build_rows(profile, corridor, vehicle: dict[str, float]) -> list[list[float]]:
    """Full AVL-like channel rows from CycleGen profile + HERE corridor."""
    t = list(profile.time)
    v = list(profile.velocity)
    a = list(profile.acceleration)
    s = list(profile.position)
    n = min(len(t), len(v), len(a), len(s))
    S = list(corridor.S)
    alpha = list(corridor.alpha)
    elev = list(corridor.elevations_m or [])
    V_legal = list(corridor.V_limite_legal or corridor.V_envelope)
    geom = list(corridor.geometry)
    R = curvature_radius_m(geom) if geom else [1e9] * len(S)
    kappa = [0.0 if (not math.isfinite(r) or r > 1e6) else 1.0 / max(r, 1e-3) for r in R]

    mass = float(vehicle.get("mass_kg", 2500))
    f0 = float(vehicle.get("f0_n", 160))
    f1 = float(vehicle.get("f1_n_per_kph", 0))
    f2 = float(vehicle.get("f2_n_per_kph2", 0.04))
    r_dyn = float(vehicle.get("r_dyn_m", 0.35))
    g = 9.81

    rows: list[list[float]] = []
    energy = 0.0
    soc = 0.9
    btr_v = 320.0
    for i in range(n):
        dt = (t[i] - t[i - 1]) if i > 0 else 0.0
        sm = s[i]
        vi = v[i]
        ai = a[i]
        alpha_i = _interp_on_s(S, alpha, sm) if S else 0.0
        slope_pct = math.tan(alpha_i) * 100.0
        if elev and len(elev) == len(S):
            alt = _interp_on_s(S, elev, sm)
        else:
            alt = 0.0
        v_lim = _interp_on_s(S, V_legal, sm) if S and V_legal else 0.0
        curv = _interp_on_s(S, kappa, sm) if S else 0.0
        lat, lon = _latlon_at(geom, S, sm) if geom and S else (0.0, 0.0)
        vk = vi * 3.6
        f_road = f0 + f1 * vk + f2 * vk * vk
        f_grade = mass * g * math.sin(alpha_i)
        f_inert = mass * ai
        f_trac = f_inert + f_road + f_grade
        power_w = f_trac * max(vi, 0.1)
        torque = f_trac * r_dyn
        # crude gear / rpm from speed (6-speed heuristic)
        if vk < 15:
            gear = 1
        elif vk < 30:
            gear = 2
        elif vk < 50:
            gear = 3
        elif vk < 70:
            gear = 4
        elif vk < 100:
            gear = 5
        else:
            gear = 6
        rpm = max(0.0, (vi / max(r_dyn, 0.05)) * 60.0 / (2 * math.pi) * (0.35 + 0.12 * gear))
        acc_lat = vi * vi * curv
        if i > 0 and dt > 0:
            energy += max(0.0, power_w) * dt
            # simple SOC drain when traction
            if power_w > 0:
                soc = max(0.05, soc - (power_w * dt) / (80e3 * 3600) * 0.15)
            btr_v = 300.0 + 40.0 * soc
        rows.append(
            [
                t[i],
                sm,
                vi,
                vk,
                rpm,
                torque,
                power_w,
                float(gear),
                lat,
                lon,
                alt,
                slope_pct,
                curv,
                v_lim * 3.6,
                energy,
                ai,
                acc_lat,
                soc,
                btr_v,
            ]
        )
    return rows


def write_xls(path: Path, rows: list[list[float]], sheet_name: str) -> None:
    wb = xlwt.Workbook(encoding="utf-8")
    ws = wb.add_sheet(sheet_name[:31])
    for c, h in enumerate(HEADERS):
        ws.write(0, c, h)
    for r, row in enumerate(rows, start=1):
        for c, val in enumerate(row):
            if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
                ws.write(r, c, "")
            else:
                ws.write(r, c, float(val))
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(path))


def write_xlsx(path: Path, rows: list[list[float]], sheet_name: str) -> None:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name[:31]
    ws.append(HEADERS)
    for row in rows:
        ws.append([None if (isinstance(v, float) and (math.isnan(v) or math.isinf(v))) else v for v in row])
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(path))


async def here_corridor(
    origin: tuple[float, float],
    dest: tuple[float, float],
    a_y: float,
) -> Any:
    async with SpatialDataAcquisition() as acq:
        route = await acq.get_route_data(
            origin[0],
            origin[1],
            dest[0],
            dest[1],
            depart_at=datetime.now(timezone.utc),
            a_y_mps2=a_y,
            routing_profile="HERE/ADAS",
        )
    corridor = build_spatial_corridor(
        route,
        a_y_mps2=a_y,
        enable_speed_limits=True,
        global_max_speed_kmh=130.0,
        include_traffic_in_envelope=False,
    )
    return route, corridor


async def run(files: list[Path]) -> int:
    key = os.getenv("HERE_API_KEY", "").strip()
    if not key:
        print("ERROR: HERE_API_KEY missing in environment / .env", flush=True)
        return 2

    files = [p.expanduser().resolve() for p in files]
    missing = [p for p in files if not p.is_file()]
    if missing:
        print("ERROR missing files:", *[str(p) for p in missing], sep="\n  ", flush=True)
        return 2
    if len(files) < 2:
        print("ERROR: need the 6 Route Studio .xls files", flush=True)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print(f"=== Identify drivers from {len(files)} RS cycles ===", flush=True)
    drivers, meta = identify_drivers(files)

    drivers_path = OUT_DIR / f"route_studio_drivers_{stamp}.json"
    drivers_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    latest_drivers = OUT_DIR / "route_studio_drivers_latest.json"
    latest_drivers.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    PUBLIC_DRIVERS.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_DRIVERS.write_text(
        json.dumps(
            {
                "updated_at": meta["created_at"],
                "drivers": [
                    {
                        "id": f"route-studio-{k.split('_')[-1].lower()}",
                        "name": k,
                        "baseProfile": v["base_profile"],
                        "physics": {
                            kk: v[kk]
                            for kk in (
                                "a_max",
                                "b_comf",
                                "speed_factor",
                                "T",
                                "T_h",
                                "s0",
                                "jerk_max",
                                "jerk_brake_max",
                            )
                        },
                        "a_y": v["a_y"],
                        "notes": "Identified from AVL Route Studio XSPACE batch (HERE replay).",
                        "seed": True,
                    }
                    for k, v in drivers.items()
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"  saved {drivers_path}", flush=True)
    print(f"  saved {PUBLIC_DRIVERS}", flush=True)

    # Pick one dynamique file per route for HERE A/B (geometry endpoints).
    by_route: dict[str, dict[str, Path]] = {}
    for p in files:
        rk = _route_key(p.name)
        st = _style(p.name)
        by_route.setdefault(rk, {})[st] = p

    results: list[dict[str, Any]] = []
    print("\n=== HERE corridors + IDM replay ===", flush=True)
    for route_key, styles in sorted(by_route.items()):
        geom_src = styles.get("dynamique") or styles.get("prudent")
        if geom_src is None:
            print(f"  skip {route_key}: no file", flush=True)
            continue
        origin, dest = endpoints_from_xls(geom_src)
        # Use mean a_y of dynamique for curve envelope on corridor build
        a_y_corr = drivers["Route_Studio_Dynamique"]["a_y"]
        print(
            f"\n[{route_key}] HERE A=({origin[0]:.5f},{origin[1]:.5f}) "
            f"B=({dest[0]:.5f},{dest[1]:.5f}) a_y={a_y_corr}",
            flush=True,
        )
        t0 = time.time()
        try:
            route, corridor = await here_corridor(origin, dest, a_y_corr)
        except Exception as exc:  # noqa: BLE001
            print(f"  HERE FAILED: {exc}", flush=True)
            results.append({"route": route_key, "error": str(exc)})
            continue
        print(
            f"  HERE ok in {time.time()-t0:.1f}s · "
            f"src={route.traffic_source} L={route.distance_m/1000:.2f} km "
            f"pts={len(route.geometry)} elev={route.elevation_source}",
            flush=True,
        )

        for driver_name, params in drivers.items():
            style = "prudent" if "Prudent" in driver_name else "dynamique"
            base = DriverProfile.PRUDENT if style == "prudent" else DriverProfile.DYNAMIQUE
            overrides = {
                k: float(params[k])
                for k in (
                    "a_max",
                    "b_comf",
                    "speed_factor",
                    "T",
                    "T_h",
                    "s0",
                    "jerk_max",
                    "jerk_brake_max",
                )
            }
            # Rebuild curve envelope with this driver's a_y
            corridor_d, _ = None, None
            try:
                # Re-apply a_y for this driver on same route geometry via corridor rebuild
                route_ay = route.model_copy(deep=True) if hasattr(route, "model_copy") else route
                corridor_d = build_spatial_corridor(
                    route_ay,
                    a_y_mps2=float(params["a_y"]),
                    enable_speed_limits=True,
                    global_max_speed_kmh=130.0,
                    include_traffic_in_envelope=False,
                )
            except Exception:
                corridor_d = corridor

            t1 = time.time()
            profile = IDMSolver(
                corridor_d,
                base,
                seed=42,
                max_speed_mps=130.0 / 3.6,
                enable_markov=False,
                param_overrides=overrides,
                vehicle=XSPACE_VEHICLE,
            ).solve()
            print(
                f"  {driver_name}: T={profile.total_duration_s:.0f}s "
                f"L={profile.position[-1]/1000:.2f}km "
                f"v̄={profile.average_speed_kmh:.1f} "
                f"({time.time()-t1:.1f}s)",
                flush=True,
            )
            rows = build_rows(profile, corridor_d, XSPACE_VEHICLE)
            stem = f"CycleGen_HERE_{route_key}_{driver_name}_{stamp}"
            xls_path = OUT_DIR / f"{stem}.xls"
            xlsx_path = OUT_DIR / f"{stem}.xlsx"
            sheet = f"CG_{route_key}_{style}"[:31]
            write_xls(xls_path, rows, sheet)
            write_xlsx(xlsx_path, rows, sheet)
            # also copy "latest" short name
            latest_xls = OUT_DIR / f"CycleGen_HERE_{route_key}_{driver_name}_latest.xls"
            write_xls(latest_xls, rows, sheet)
            print(f"    → {xls_path.name} ({len(rows)} rows)", flush=True)
            results.append(
                {
                    "route": route_key,
                    "driver": driver_name,
                    "duration_s": profile.total_duration_s,
                    "distance_m": profile.position[-1] if profile.position else None,
                    "avg_speed_kmh": profile.average_speed_kmh,
                    "xls": str(xls_path),
                    "xlsx": str(xlsx_path),
                    "here_distance_m": route.distance_m,
                    "traffic_source": route.traffic_source,
                }
            )

    summary = {
        "stamp": stamp,
        "drivers": drivers,
        "results": results,
        "out_dir": str(OUT_DIR),
    }
    (OUT_DIR / f"batch_summary_{stamp}.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    (OUT_DIR / "batch_summary_latest.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    ok = sum(1 for r in results if "xls" in r)
    print(f"\n=== DONE: {ok} cycles exported → {OUT_DIR} ===", flush=True)
    return 0 if ok >= 1 else 1


def main() -> int:
    args = [Path(a) for a in sys.argv[1:] if not a.startswith("-")]
    if not args:
        default_dir = Path("/Volumes/Maximus/AVL Route Studio")
        args = sorted(default_dir.glob("XSPACE_*.xls"))
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
