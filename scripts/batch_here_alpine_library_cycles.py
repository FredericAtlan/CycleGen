#!/usr/bin/env python3
"""Generate 4 alpine HERE (OSRM fallback) library cycles for CycleGen Pages demo.

Routes: Grossglockner · Pico Veleta · Col de l'Iseran · Stelvio
Each SavedCycle packs: geometry + slim corridor + IDM profile + driver meta
so Studio wizard steps 1–4 restore fully (trajet / contraintes / conducteur / cycle).

Usage (repo root):
  backend/.venv/bin/python scripts/batch_here_alpine_library_cycles.py
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import xlrd

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_BACKEND = _REPO / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_env = _REPO / ".env"
if _env.is_file():
    try:
        from dotenv import load_dotenv

        load_dotenv(_env)
    except ImportError:
        pass

from app.models.schemas import DriverProfile, LatLon  # noqa: E402
from app.services.data_fetcher import SpatialDataAcquisition  # noqa: E402
from app.services.kinematic_solver import IDMSolver  # noqa: E402
from app.services.spatial_processor import build_spatial_corridor  # noqa: E402

CALIB = _BACKEND / "app/data/benchmark/calibration/route_studio_here"
PUBLIC_PACK = _REPO / "frontend/public/data/route_studio_fit_pack.json"
BACKEND_PACK = (
    _BACKEND
    / "app/data/benchmark/calibration/route_studio_here/route_studio_fit_pack.json"
)
DRIVERS_JSON = CALIB / "route_studio_drivers_latest.json"

# One cycle per alpine pass (prudent IDM) — ids used by StudioHome alpine demo.
ROUTES: list[dict[str, Any]] = [
    {
        "key": "grossglockner",
        "id": "rs_here_grossglockner_prudent",
        "label": "Großglockner",
        "route_label": "Großglockner Hochalpenstraße",
        "xls": CALIB / "RS_Grossglockner_conducteur_prudent.xls",
        "fallback_xls": CALIB / "XSPACE_Grossglockner_conducteur_prudent.xls",
    },
    {
        "key": "veleta",
        "id": "rs_here_veleta_prudent",
        "label": "Pico Veleta",
        "route_label": "Pico Veleta → Granada",
        "xls": CALIB / "RS_Pico_Veleta_vers_Granada_conducteur_prudent (1).xls",
        "fallback_xls": CALIB
        / "XSPACE_Pico_Veleta_vers_Granada_conducteur_prudent (1).xls",
    },
    {
        "key": "iseran",
        "id": "rs_here_iseran_prudent",
        "label": "Col de l’Iseran",
        "route_label": "Col de l’Iseran (descente)",
        "xls": CALIB / "RS_descente_Col_de_L_Iseran_conducteur_prudent 1 (1).xls",
        "fallback_xls": CALIB
        / "XSPACE_descente_Col_de_L_Iseran_conducteur_prudent 1 (1).xls",
    },
    {
        "key": "stelvio",
        "id": "rs_here_stelvio_prudent",
        "label": "Stelvio",
        "route_label": "Passo dello Stelvio",
        "xls": CALIB / "RS_Stelvio_conducteur_prudent (1).xls",
        "fallback_xls": CALIB / "XSPACE_Stelvio_conducteur_prudent (1).xls",
    },
]

XSPACE_VEHICLE = {
    "mass_kg": 2500.0,
    "f0_n": 160.0,
    "f1_n_per_kph": 0.0,
    "f2_n_per_kph2": 0.04,
    "r_dyn_m": 0.35,
}


def _xls_gps(path: Path) -> list[tuple[float, float, float | None]]:
    """Return [(lat, lon, elev|None), ...] from Route Studio / XSPACE .xls."""
    book = xlrd.open_workbook(str(path))
    sheet = book.sheet_by_index(0)
    headers = [str(sheet.cell_value(0, c)).strip().lower() for c in range(sheet.ncols)]

    def col(*names: str) -> int | None:
        for n in names:
            if n in headers:
                return headers.index(n)
        return None

    i_lat = col("lat", "latitude")
    i_lon = col("lon", "longitude", "lng")
    if i_lat is None or i_lon is None:
        raise KeyError(f"missing lat/lon in {path.name}")
    i_alt = col("alt [m]", "alt", "ele", "elevation", "z")
    pts: list[tuple[float, float, float | None]] = []
    for r in range(1, sheet.nrows):
        try:
            la = float(sheet.cell_value(r, i_lat))
            lo = float(sheet.cell_value(r, i_lon))
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(la) and math.isfinite(lo)):
            continue
        alt: float | None = None
        if i_alt is not None:
            try:
                a = float(sheet.cell_value(r, i_alt))
                if math.isfinite(a):
                    alt = a
            except (TypeError, ValueError):
                pass
        pts.append((la, lo, alt))
    if len(pts) < 2:
        raise RuntimeError(f"no GPS in {path}")
    return pts


def _endpoints(path: Path) -> tuple[tuple[float, float], tuple[float, float]]:
    pts = _xls_gps(path)
    return (pts[0][0], pts[0][1]), (pts[-1][0], pts[-1][1])


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def route_from_xls_trace(
    path: Path, *, max_pts: int = 900, label: str = ""
) -> Any:
    """Build RouteAnalyzeResponse from recorded GPS when HERE A→B is too long."""
    from app.models.schemas import RouteAnalyzeResponse

    raw = _xls_gps(path)
    # Keep roughly evenly spaced samples along the recorded path.
    idx = _downsample_idx(len(raw), max_pts)
    pts = [raw[i] for i in idx]
    geometry = [LatLon(lat=p[0], lon=p[1]) for p in pts]
    seg_d: list[float] = []
    elev: list[float] = []
    for i, p in enumerate(pts):
        elev.append(float(p[2]) if p[2] is not None else 0.0)
        if i == 0:
            continue
        seg_d.append(
            _haversine_m(pts[i - 1][0], pts[i - 1][1], p[0], p[1])
        )
    # Nominal free-flow ~55 km/h for segment speeds (m/s).
    v_nom = 55.0 / 3.6
    seg_v = [v_nom] * len(seg_d)
    dist = sum(seg_d)
    dur = dist / max(v_nom, 0.1)
    lats = [p.lat for p in geometry]
    lons = [p.lon for p in geometry]
    return RouteAnalyzeResponse(
        geometry=geometry,
        distance_m=dist,
        duration_s=dur,
        segment_speeds_mps=seg_v,
        segment_distances_m=seg_d,
        elevations_m=elev,
        traffic_signals=[],
        bbox=[min(lons), min(lats), max(lons), max(lats)],
        origin=geometry[0],
        destination=geometry[-1],
        origin_label=label or path.stem,
        destination_label="Arrivée",
        traffic_source="xls_gps_trace",
        elevation_source="xls",
        warnings=[],
    )


def _pick_xls(spec: dict[str, Any]) -> Path:
    for key in ("xls", "fallback_xls"):
        p = spec[key]
        if isinstance(p, Path) and p.is_file():
            return p
    raise FileNotFoundError(spec["id"])


def _downsample_idx(n: int, max_pts: int) -> list[int]:
    if n <= max_pts:
        return list(range(n))
    if max_pts < 2:
        return [0]
    out = [0]
    for i in range(1, max_pts - 1):
        out.append(round(i * (n - 1) / (max_pts - 1)))
    out.append(n - 1)
    # unique preserve order
    seen: set[int] = set()
    uniq: list[int] = []
    for i in out:
        if i not in seen:
            seen.add(i)
            uniq.append(i)
    return uniq


def _take(arr: list[Any] | None, idx: list[int]) -> list[Any] | None:
    if arr is None:
        return None
    if len(arr) == 0:
        return []
    return [arr[i] if i < len(arr) else arr[-1] for i in idx]


def slim_corridor(corr: Any, max_pts: int = 700) -> dict[str, Any]:
    S = list(corr.S)
    idx = _downsample_idx(len(S), max_pts)
    geom = [
        {"lat": p.lat, "lon": p.lon}
        for p in (corr.geometry or [])
    ]
    g_idx = _downsample_idx(len(geom), min(250, max_pts)) if geom else []

    def series(name: str) -> list[float] | None:
        vals = getattr(corr, name, None)
        if vals is None:
            return None
        return [float(x) for x in _take(list(vals), idx) or []]

    out: dict[str, Any] = {
        "S": [float(x) for x in _take(S, idx) or []],
        "V_limite": series("V_limite") or [0.0] * len(idx),
        "alpha": series("alpha") or [0.0] * len(idx),
        "S_feux": [float(x) for x in (corr.S_feux or [])],
        "events": [e.model_dump() if hasattr(e, "model_dump") else e for e in (corr.events or [])],
        "geometry": [geom[i] for i in g_idx] if geom else [],
    }
    for opt in (
        "V_limite_legal",
        "V_traffic",
        "V_curve",
        "V_envelope",
        "elevations_m",
    ):
        s = series(opt)
        if s is not None and any(math.isfinite(v) for v in s):
            out[opt] = s
    if getattr(corr, "traffic_source", None):
        out["traffic_source"] = corr.traffic_source
    if getattr(corr, "warnings", None):
        out["warnings"] = [
            w.model_dump() if hasattr(w, "model_dump") else w for w in corr.warnings
        ]
    if getattr(corr, "a_y_mps2", None) is not None:
        out["a_y_mps2"] = float(corr.a_y_mps2)
    if getattr(corr, "slope_profile", None) is not None:
        sp = corr.slope_profile
        out["slope_profile"] = sp.model_dump() if hasattr(sp, "model_dump") else sp
    return out


def slim_profile(profile: Any, max_pts: int = 1200) -> dict[str, list[float]]:
    t = list(profile.time)
    idx = _downsample_idx(len(t), max_pts)

    def ser(name: str, fill: float = 0.0) -> list[float]:
        vals = list(getattr(profile, name, []) or [])
        if not vals:
            return [fill] * len(idx)
        return [float(vals[i] if i < len(vals) else vals[-1]) for i in idx]

    return {
        "time": ser("time"),
        "velocity": ser("velocity"),
        "acceleration": ser("acceleration"),
        "slope": ser("slope"),
        "position": ser("position"),
    }


def load_prudent_params() -> tuple[dict[str, float], float]:
    defaults = {
        "a_max": 1.29,
        "b_comf": 1.71,
        "jerk_max": 1.5,
        "jerk_brake_max": 1.5,
        "T": 1.8,
        "T_h": 4.5,
        "s0": 2.8,
        "speed_factor": 1.02,
    }
    a_y = 3.27
    if DRIVERS_JSON.is_file():
        meta = json.loads(DRIVERS_JSON.read_text(encoding="utf-8"))
        d = (meta.get("drivers") or {}).get("Route_Studio_Prudent") or {}
        for k in defaults:
            if k in d and math.isfinite(float(d[k])):
                defaults[k] = float(d[k])
        if "a_y" in d and math.isfinite(float(d["a_y"])):
            a_y = float(d["a_y"])
    return defaults, a_y


async def fetch_route(
    origin: tuple[float, float],
    dest: tuple[float, float],
    a_y: float,
) -> Any:
    """Prefer HERE/ADAS; SpatialDataAcquisition falls back Mapbox → OSRM."""
    profile = "HERE/ADAS" if os.getenv("HERE_API_KEY", "").strip() else "Car/OSRM"
    async with SpatialDataAcquisition() as acq:
        return await acq.get_route_data(
            origin[0],
            origin[1],
            dest[0],
            dest[1],
            depart_at=datetime.now(timezone.utc),
            a_y_mps2=a_y,
            routing_profile=profile,
        )


def bbox_of(geom: list[dict[str, float]]) -> list[float]:
    lats = [p["lat"] for p in geom]
    lons = [p["lon"] for p in geom]
    return [min(lons), min(lats), max(lons), max(lats)]


def build_saved_cycle(
    *,
    spec: dict[str, Any],
    route: Any,
    corridor: Any,
    profile: Any,
    physics: dict[str, float],
    a_y: float,
) -> dict[str, Any]:
    geom = [{"lat": p.lat, "lon": p.lon} for p in (route.geometry or [])]
    g_idx = _downsample_idx(len(geom), 280) if geom else []
    geometry = [geom[i] for i in g_idx]
    series = slim_profile(profile)
    corr = slim_corridor(corridor)
    elev = list(getattr(corridor, "elevations_m", None) or [])
    z_min = min((z for z in elev if z is not None and math.isfinite(z)), default=None)
    z_max = max((z for z in elev if z is not None and math.isfinite(z)), default=None)
    dist = float(profile.position[-1]) if profile.position else float(route.distance_m)
    dur = float(profile.total_duration_s)
    v = series["velocity"]
    a = series["acceleration"]
    traffic = getattr(route, "traffic_source", None) or "osrm"
    return {
        "id": spec["id"],
        "name": f"HERE · {spec['label']} · Route_Studio_Prudent",
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "origin": "cyclegen",
        "source": "batch_here_alpine_library_cycles",
        "resultAvailable": True,
        "geometry": geometry,
        "corridor": corr,
        "limits": None,
        "time": series["time"],
        "velocity": series["velocity"],
        "acceleration": series["acceleration"],
        "slope": series["slope"],
        "position": series["position"],
        "a_lat": None,
        "z_min_m": z_min,
        "z_max_m": z_max,
        "stats": {
            "duration_s": dur,
            "distance_m": dist,
            "v_mean_kmh": float(profile.average_speed_kmh),
            "v_max_kmh": max(v) * 3.6 if v else 0.0,
            "v_min_kmh": min(v) * 3.6 if v else 0.0,
            "a_lon_max_mps2": max(a) if a else None,
            "a_lon_min_mps2": min(a) if a else None,
            "a_lon_mean_accel_mps2": None,
            "a_lon_mean_decel_mps2": None,
            "a_lat_max_mps2": None,
            "slope_mean_pct": None,
            "slope_max_pct": None,
            "slope_min_pct": None,
        },
        "meta": {
            "routeLabel": f"{spec['route_label']}",
            "routingProfile": "HERE/ADAS" if "here" in str(traffic).lower() else "Car/OSRM",
            "trafficSource": traffic,
            "driverProfile": "Prudent",
            "driverName": "Route_Studio_Prudent",
            "driverId": "seed-prudent",
            "physics": physics,
            "aY": a_y,
            "maxSpeedKmh": 130,
            "preferredEngine": "idm",
            "vehicleId": "renault-xspace-apr2bis",
            "saveTitle": spec["label"],
            "gpsOrigin": geometry[0] if geometry else None,
            "gpsDestination": geometry[-1] if geometry else None,
            "origin_lat": geometry[0]["lat"] if geometry else None,
            "origin_lon": geometry[0]["lon"] if geometry else None,
            "destination_lat": geometry[-1]["lat"] if geometry else None,
            "destination_lon": geometry[-1]["lon"] if geometry else None,
            "notes": "Pré-enregistré démo Pages — trajet/contraintes/conducteur/cycle complets.",
            "envelopeMask": {"legal": True, "traffic": False, "curve": True},
            "librarySigle": True,
            "studioComplete": True,
        },
    }


async def generate_one(
    spec: dict[str, Any], physics: dict[str, float], a_y: float
) -> dict[str, Any]:
    xls = _pick_xls(spec)
    origin, dest = _endpoints(xls)
    print(
        f"\n[{spec['key']}] A=({origin[0]:.5f},{origin[1]:.5f}) "
        f"B=({dest[0]:.5f},{dest[1]:.5f}) ← {xls.name}",
        flush=True,
    )
    t0 = time.time()
    route = None
    try:
        route = await fetch_route(origin, dest, a_y)
        if float(route.distance_m) > 100_000:
            print(
                f"  HERE detour {route.distance_m/1000:.1f} km — fallback XLS GPS",
                flush=True,
            )
            route = None
    except Exception as exc:  # noqa: BLE001
        print(f"  HERE/OSRM failed ({exc}) — fallback XLS GPS", flush=True)
        route = None
    if route is None:
        route = route_from_xls_trace(xls, label=spec["label"])
    print(
        f"  route {time.time()-t0:.1f}s · src={route.traffic_source} "
        f"L={route.distance_m/1000:.2f} km pts={len(route.geometry)}",
        flush=True,
    )
    corridor = build_spatial_corridor(
        route,
        a_y_mps2=a_y,
        enable_speed_limits=True,
        global_max_speed_kmh=130.0,
        include_traffic_in_envelope=False,
    )
    t1 = time.time()
    profile = IDMSolver(
        corridor,
        DriverProfile.PRUDENT,
        seed=42,
        max_speed_mps=130.0 / 3.6,
        enable_markov=False,
        param_overrides=physics,
        vehicle=XSPACE_VEHICLE,
    ).solve()
    print(
        f"  IDM {time.time()-t1:.1f}s · T={profile.total_duration_s:.0f}s "
        f"v̄={profile.average_speed_kmh:.1f} km/h",
        flush=True,
    )
    return build_saved_cycle(
        spec=spec,
        route=route,
        corridor=corridor,
        profile=profile,
        physics=physics,
        a_y=a_y,
    )


def upsert_pack(cycles: list[dict[str, Any]]) -> None:
    by_id = {c["id"]: c for c in cycles}
    for path in (PUBLIC_PACK, BACKEND_PACK):
        if path.is_file():
            pack = json.loads(path.read_text(encoding="utf-8"))
        else:
            pack = {"cycles": [], "drivers": []}
        existing = pack.get("cycles") or []
        out: list[Any] = []
        seen: set[str] = set()
        for c in existing:
            cid = str(c.get("id") or "")
            if cid in by_id:
                out.append(by_id[cid])
                seen.add(cid)
            else:
                out.append(c)
        for cid, c in by_id.items():
            if cid not in seen:
                out.append(c)
        pack["cycles"] = out
        pack["updated_at"] = datetime.now(timezone.utc).isoformat()
        pack["here_alpine_batch"] = {
            "ids": list(by_id.keys()),
            "script": "batch_here_alpine_library_cycles.py",
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
        print(f"  wrote {path} ({path.stat().st_size/1e6:.2f} Mo)", flush=True)


async def main() -> int:
    physics, a_y = load_prudent_params()
    print("=== Alpine HERE/OSRM library cycles (×4) ===", flush=True)
    print(f"  physics={physics} a_y={a_y}", flush=True)
    cycles: list[dict[str, Any]] = []
    errors: list[str] = []
    for spec in ROUTES:
        try:
            cycles.append(await generate_one(spec, physics, a_y))
        except Exception as exc:  # noqa: BLE001
            msg = f"{spec['id']}: {exc}"
            print(f"  FAILED {msg}", flush=True)
            errors.append(msg)
    if not cycles:
        print("ERROR: no cycles generated", flush=True)
        return 1
    upsert_pack(cycles)
    summary = {
        "created": [
            {
                "id": c["id"],
                "name": c["name"],
                "distance_m": c["stats"]["distance_m"],
                "duration_s": c["stats"]["duration_s"],
                "geo": len(c.get("geometry") or []),
                "corridor_S": len((c.get("corridor") or {}).get("S") or []),
                "profile_n": len(c.get("time") or []),
                "traffic": (c.get("meta") or {}).get("trafficSource"),
            }
            for c in cycles
        ],
        "errors": errors,
        "pack": str(PUBLIC_PACK),
    }
    (CALIB / "here_alpine_library_batch_latest.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2), flush=True)
    return 0 if len(cycles) == 4 else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
