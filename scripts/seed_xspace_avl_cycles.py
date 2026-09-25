#!/usr/bin/env python3
"""Seed 6 CycleGen cycles from AVL XSPACE GPS: 3 routes × Prudent/Dynamique.

Writes:
  - backend/app/data/benchmark/xspace_avl_*.csv (+ manifest entries)
  - frontend/public/data/xspace_avl_seed_cycles.json (library import)
  - refreshes HTML expert report series if report script present

Usage:
  cd backend && .venv/bin/python ../scripts/seed_xspace_avl_cycles.py
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
_BACKEND = _ROOT / "backend"
_FRONTEND = _ROOT / "frontend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from app.models.schemas import DriverProfile, LatLon  # noqa: E402
from app.services.kinematic_solver import IDMSolver, PROFILE_PARAMS  # noqa: E402
import batch_xspace_avl_compare as batch  # noqa: E402

BENCH = _BACKEND / "app/data/benchmark"
MANIFEST = BENCH / "manifest.json"
PUBLIC_DATA = _FRONTEND / "public" / "data"
CALIB = BENCH / "calibration"

# One geometry source per route (prefer dynamique GPS when both exist).
ROUTE_GEOM: list[tuple[str, Path]] = [
    (
        "iseran",
        Path(
            "/Users/fredericatlan/Downloads/XSPACE_descente_Col_de_L_Iseran_conducteur_dynamique 1.xls"
        ),
    ),
    (
        "veleta",
        Path(
            "/Users/fredericatlan/Downloads/XSPACE_Pico_Veleta_vers_Granada_conducteur_dynamique.xls"
        ),
    ),
    (
        "stelvio",
        Path("/Users/fredericatlan/Downloads/XSPACE_Stelvio_conducteur_dynamique.xls"),
    ),
]

DRIVERS: list[tuple[str, DriverProfile, float]] = [
    ("prudent", DriverProfile.PRUDENT, 3.27),
    ("dynamique", DriverProfile.DYNAMIQUE, 4.9),
]

ROUTE_LABEL = {
    "iseran": "Iseran (descente)",
    "veleta": "Pico Veleta → Granada",
    "stelvio": "Stelvio",
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _thin_idx(n: int, max_n: int) -> list[int]:
    if n <= max_n:
        return list(range(n))
    step = max(1, n // max_n)
    idx = list(range(0, n, step))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return idx


def write_csv(
    path: Path,
    *,
    time_s: list[float],
    velocity: list[float],
    position: list[float],
    acceleration: list[float],
    slope_rad: list[float],
    lat: list[float],
    lon: list[float],
    alt: list[float],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(
            [
                "time_s",
                "velocity_mps",
                "position_m",
                "acceleration_mps2",
                "slope_pct",
                "lat",
                "lon",
                "alt_m",
            ]
        )
        for i in range(len(time_s)):
            slope_pct = (
                math.tan(slope_rad[i]) * 100.0 if i < len(slope_rad) else 0.0
            )
            w.writerow(
                [
                    f"{time_s[i]:.3f}",
                    f"{velocity[i]:.6f}",
                    f"{position[i]:.3f}",
                    f"{acceleration[i]:.6f}",
                    f"{slope_pct:.4f}",
                    f"{lat[i]:.7f}" if i < len(lat) else "",
                    f"{lon[i]:.7f}" if i < len(lon) else "",
                    f"{alt[i]:.2f}" if i < len(alt) else "",
                ]
            )


def pack_saved_cycle(
    *,
    cycle_id: str,
    name: str,
    route_key: str,
    driver: DriverProfile,
    a_y: float,
    prof,
    corridor,
    geom_lat: list[float],
    geom_lon: list[float],
) -> dict:
    t = list(prof.time)
    v = list(prof.velocity)
    a = list(prof.acceleration)
    s = list(prof.position)
    # slope from corridor alpha resampled on profile S
    alpha = batch.resample_on_s(corridor.S, list(corridor.alpha), s)
    n = len(t)
    idx = _thin_idx(n, 2000)
    gidx = _thin_idx(len(geom_lat), 250)
    physics = PROFILE_PARAMS[driver]
    z = list(corridor.elevations_m or [])
    z_on = batch.resample_on_s(corridor.S, z, s) if z else [0.0] * n
    z_min = min((x for x in z_on if math.isfinite(x)), default=None)
    z_max = max((x for x in z_on if math.isfinite(x)), default=None)

    moving = [x for x in v if x > 0.5]
    v_mean = (sum(moving) / len(moving) * 3.6) if moving else 0.0
    duration = float(prof.total_duration_s)
    distance = float(s[-1] - s[0]) if s else 0.0

    a_lat: list[float] = []
    # approximate from V_curve envelope if available
    if corridor.V_curve and len(corridor.V_curve) == len(corridor.S):
        # a_y used in envelope; leave zeros for slim pack
        a_lat = [0.0] * n
    else:
        a_lat = [0.0] * n

    return {
        "id": cycle_id,
        "name": name,
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": f"CycleGen · {driver.value} · AVL XSPACE GPS",
        "sourceUrl": None,
        "origin": "cyclegen",
        "corpusId": cycle_id,
        "stats": {
            "duration_s": round(duration, 1),
            "distance_m": round(distance, 1),
            "v_mean_kmh": round(v_mean, 2),
            "v_max_kmh": round(max(v) * 3.6, 2) if v else 0.0,
            "n_points": len(idx),
        },
        "time": [t[i] for i in idx],
        "velocity": [v[i] for i in idx],
        "acceleration": [a[i] for i in idx],
        "slope": [alpha[i] if i < len(alpha) else 0.0 for i in idx],
        "a_lat": [a_lat[i] if i < len(a_lat) else 0.0 for i in idx],
        "position": [s[i] for i in idx],
        "geometry": [
            {"lat": geom_lat[i], "lon": geom_lon[i]} for i in gidx
        ],
        "resultAvailable": True,
        "z_min_m": z_min,
        "z_max_m": z_max,
        "corridor": None,
        "limits": None,
        "meta": {
            "driverProfile": driver.value,
            "driverId": f"seed-{driver.value.lower()}",
            "driverName": driver.value,
            "routeLabel": ROUTE_LABEL[route_key],
            "saveTitle": name,
            "gpsOrigin": f"{geom_lat[0]:.6f}, {geom_lon[0]:.6f}",
            "origin_lat": geom_lat[0],
            "origin_lon": geom_lon[0],
            "gpsDestination": f"{geom_lat[-1]:.6f}, {geom_lon[-1]:.6f}",
            "destination_lat": geom_lat[-1],
            "destination_lon": geom_lon[-1],
            "notes": (
                "Géométrie GPS AVL Route Studio XSPACE ; "
                f"IDM CycleGen profil {driver.value} "
                f"(a_y={a_y}, sf={physics.speed_factor})."
            ),
            "citation": "AVL Route Studio XSPACE exports · CycleGen IDM replay",
            "license": "Internal calibration — AVL XSPACE traces",
            "routingProfile": "HERE/ADAS",
            "aY": a_y,
            "physics": {
                "a_max": physics.a_max,
                "b_comf": physics.b_comf,
                "speed_factor": physics.speed_factor,
                "T": physics.T,
                "T_h": physics.T_h,
                "s0": physics.s0,
                "jerk_max": physics.jerk_max,
                "jerk_brake_max": physics.jerk_brake_max,
            },
            "maxSpeedKmh": 130,
            "vehicleId": "renault-xspace-apr2bis",
            "preferredEngine": "idm",
            "elevationA_m": z_on[0] if z_on else None,
            "elevationB_m": z_on[-1] if z_on else None,
        },
    }


def main() -> int:
    BENCH.mkdir(parents=True, exist_ok=True)
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    sources = [
        s
        for s in manifest.get("sources", [])
        if not str(s.get("id", "")).startswith("xspace_avl_")
    ]

    library_cycles: list[dict] = []
    created = []

    for route_key, xls in ROUTE_GEOM:
        if not xls.exists():
            print(f"MISSING {xls}", flush=True)
            continue
        print(f"\n=== geometry {route_key} ← {xls.name} ===", flush=True)
        raw = batch.load_xls(xls)
        ds = batch.downsample(raw, max_n=3000)
        geom_lat = list(ds["lat"])
        geom_lon = list(ds["lon"])

        for style, profile, a_y in DRIVERS:
            cid = f"xspace_avl_{route_key}_{style}"
            label = f"XSPACE {ROUTE_LABEL[route_key]} · {profile.value}"
            print(f"  → IDM {profile.value} a_y={a_y}…", flush=True)
            corridor = batch.synth_corridor(ds, a_y=a_y)
            solver = IDMSolver(
                corridor,
                driver_profile=profile,
                seed=1,
                enable_markov=False,
                max_speed_mps=130 / 3.6,
                vehicle=batch.XSPACE_VEHICLE,
            )
            prof = solver.solve()

            # Resample alt/lat/lon on profile S for CSV
            S_p = list(prof.position)
            lat_p = batch.resample_on_s(ds["s"], geom_lat, S_p)
            lon_p = batch.resample_on_s(ds["s"], geom_lon, S_p)
            alt_p = batch.resample_on_s(ds["s"], list(ds["alt"]), S_p)
            slope_p = list(prof.slope) if hasattr(prof, "slope") and prof.slope else batch.resample_on_s(
                corridor.S, list(corridor.alpha), S_p
            )

            csv_name = f"{cid}.csv"
            csv_path = BENCH / csv_name
            write_csv(
                csv_path,
                time_s=list(prof.time),
                velocity=list(prof.velocity),
                position=S_p,
                acceleration=list(prof.acceleration),
                slope_rad=slope_p,
                lat=lat_p,
                lon=lon_p,
                alt=alt_p,
            )
            digest = _sha256(csv_path)
            n = len(prof.time)
            duration = float(prof.total_duration_s)
            distance = float(S_p[-1] - S_p[0]) if S_p else 0.0
            v_mean = (
                sum(x for x in prof.velocity if x > 0.5)
                / max(1, sum(1 for x in prof.velocity if x > 0.5))
            )
            sources.append(
                {
                    "id": cid,
                    "name": label,
                    "license": "Internal — AVL XSPACE GPS + CycleGen IDM",
                    "citation": (
                        "Géométrie GPS AVL Route Studio XSPACE ; "
                        f"rejeu IDM CycleGen profil {profile.value}."
                    ),
                    "has_geo": True,
                    "url": "",
                    "sha256": digest,
                    "filename": csv_name,
                    "velocity_unit": "m/s",
                    "family": "xspace_avl",
                    "source_dataset": "avl-xspace-route-studio",
                    "added_at": time.strftime("%Y-%m-%d", time.gmtime()),
                    "tier": "calibration_replay",
                    "notes": (
                        f"a_y={a_y} · a_max={PROFILE_PARAMS[profile].a_max} · "
                        f"b_comf={PROFILE_PARAMS[profile].b_comf} · "
                        f"sf={PROFILE_PARAMS[profile].speed_factor}"
                    ),
                    "stats": {
                        "n_points": n,
                        "duration_s": round(duration, 1),
                        "distance_m": round(distance, 1),
                        "v_mean_kmh": round(v_mean * 3.6, 2),
                        "v_max_kmh": round(max(prof.velocity) * 3.6, 2),
                        "ele_start_m": round(alt_p[0], 1) if alt_p else None,
                        "ele_end_m": round(alt_p[-1], 1) if alt_p else None,
                    },
                }
            )
            library_cycles.append(
                pack_saved_cycle(
                    cycle_id=cid,
                    name=label,
                    route_key=route_key,
                    driver=profile,
                    a_y=a_y,
                    prof=prof,
                    corridor=corridor,
                    geom_lat=geom_lat,
                    geom_lon=geom_lon,
                )
            )
            created.append(cid)
            print(
                f"     OK {duration/60:.1f} min · {distance/1000:.1f} km · "
                f"v̄={v_mean*3.6:.1f} km/h",
                flush=True,
            )

    manifest["sources"] = sources
    MANIFEST.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    seed_path = PUBLIC_DATA / "xspace_avl_seed_cycles.json"
    seed_path.write_text(
        json.dumps(
            {
                "version": 1,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "cycles": library_cycles,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    # Also keep a copy under calibration for the report / backups.
    CALIB.mkdir(parents=True, exist_ok=True)
    (CALIB / "xspace_avl_seed_cycles.json").write_text(
        seed_path.read_text(encoding="utf-8"), encoding="utf-8"
    )

    print(f"\nManifest updated ({len(created)} sources): {created}", flush=True)
    print(f"Library seed: {seed_path} ({seed_path.stat().st_size/1e6:.2f} MB)", flush=True)
    return 0 if len(created) == 6 else 1


if __name__ == "__main__":
    raise SystemExit(main())
