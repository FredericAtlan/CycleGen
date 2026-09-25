#!/usr/bin/env python3
"""Batch replay: AVL Route Studio XSPACE .xls → CycleGen IDM on same geometry.

For each export:
  1. Parse legacy .xls (temps, GPS, v, slope, spd_lim, power, torque…)
  2. Fingerprint AVL driver / vehicle behaviour
  3. Synth SpatialCorridor from the AVL geometry (no live routing)
  4. Run IDM with Eco / Normal / Sportif / Standard-AVL physics
  5. Score RMSE_v, Δduration, accel stats vs AVL reference

Usage:
  cd backend && .venv/bin/python ../scripts/batch_xspace_avl_compare.py
  cd backend && .venv/bin/python ../scripts/batch_xspace_avl_compare.py path/to/*.xls
  XSPACE_AVL_DIR=~/Downloads python ../scripts/batch_xspace_avl_compare.py
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import xlrd

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_BACKEND = _REPO / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.models.schemas import DriverProfile, LatLon, SpatialCorridor  # noqa: E402
from app.services.kinematic_solver import IDMSolver  # noqa: E402
from app.services.curvature import (  # noqa: E402
    alpine_ay_profile,
    braking_feasible_speed,
    curvature_radius_m,
    curve_speed_limit_mps,
    smooth_envelope_bilateral,
    smooth_envelope_spatial,
)

OUT_DIR = _BACKEND / "app/data/benchmark/calibration"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Default filenames (looked up under --dir / XSPACE_AVL_DIR / repo benchmark).
DEFAULT_XLS_NAMES = [
    "XSPACE_descente_Col_de_L_Iseran_conducteur_dynamique 1.xls",
    "XSPACE_Pico_Veleta_vers_Granada_conducteur_dynamique.xls",
    "XSPACE_Pico_Veleta_vers_Granada_conducteur_prudent.xls",
    "XSPACE_Stelvio_conducteur_dynamique.xls",
    "XSPACE_Stelvio_conducteur_prudent.xls",
]


def resolve_default_xls_dir() -> Path:
    env = os.environ.get("XSPACE_AVL_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    candidates = [
        _REPO / "backend/app/data/benchmark/xspace_avl_xls",
        _REPO / "data/xspace_avl",
        Path.home() / "Downloads",
    ]
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[0]


def resolve_input_files(explicit: list[Path] | None, xls_dir: Path) -> list[Path]:
    if explicit:
        return [p.expanduser().resolve() for p in explicit]
    return [(xls_dir / name).resolve() for name in DEFAULT_XLS_NAMES]


# Renault XSPACE APR2 bis plant (frontend vehicleLibrary) + continuous P for
# traction clip. power_kw card is null; use ~1.5× AVL P95 usage (~53 kW) → 80 kW
# continuous so Dynamique climbs still hold without unbound free-fall accel.
XSPACE_VEHICLE: dict = {
    "mass_kg": 2556.0,
    "f0_n": 163.2,
    "f1_n_per_kph": -0.0145,
    "f2_n_per_kph2": 0.0422,
    "r_dyn_m": 0.356,
    "tau_brake_max_nm": 10000.0,
    "power_kw": 80.0,
    "regen_frac": 0.40,
    "engine_brake_frac": 0.45,
}

PRESETS: list[tuple[str, DriverProfile, dict[str, float] | None, float]] = [
    ("Eco", DriverProfile.ECO, None, 2.0),
    ("Normal", DriverProfile.NORMAL, None, 3.0),
    ("Sportif", DriverProfile.SPORTIF, None, 5.0),
    (
        "Standard_AVL_BCB",
        DriverProfile.NORMAL,
        {
            "a_max": 2.58,
            "b_comf": 1.71,
            "jerk_max": 0.96,
            "jerk_brake_max": 2.93,
            "T": 1.4,
            "T_h": 4.0,
            "s0": 2.5,
            "speed_factor": 1.05,
        },
        3.5,
    ),
    # AVL Route Studio XSPACE fingerprints (batch Sep 2026).
    ("Prudent", DriverProfile.PRUDENT, None, 3.27),
    ("Dynamique", DriverProfile.DYNAMIQUE, None, 4.9),
]


def pctile(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    ys = sorted(xs)
    k = (len(ys) - 1) * p / 100.0
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return ys[int(k)]
    return ys[f] * (c - k) + ys[c] * (k - f)


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else float("nan")


def finite(xs: list[float]) -> list[float]:
    return [x for x in xs if isinstance(x, (int, float)) and math.isfinite(x)]


@dataclass
class AvlFP:
    name: str
    style: str
    route_hint: str
    n: int
    dt_median: float
    duration_s: float
    distance_m: float
    v_mean_kmh: float
    v_max_kmh: float
    a_pos_p95: float
    a_pos_p99: float
    a_neg_p95: float
    a_neg_p99: float
    jerk_pos_p95: float
    jerk_neg_p95: float
    speed_factor_mean: float
    speed_factor_p90: float
    overspeed_pct: float
    a_lat_p95: float
    slope_mean: float
    slope_p05: float
    slope_p95: float
    power_max_kw: float
    power_p95_kw: float
    torque_p95_nm: float
    torque_brake_p95_nm: float
    gear_max: float
    elev_gain_m: float
    elev_loss_m: float
    alt0: float
    alt1: float


def style_from_name(name: str) -> str:
    n = name.lower()
    if "prudent" in n:
        return "prudent"
    if "dynamique" in n:
        return "dynamique"
    return "unknown"


def route_hint(name: str) -> str:
    n = name.lower()
    if "iseran" in n:
        return "Iseran (descente)"
    if "veleta" in n or "granada" in n:
        return "Pico Veleta → Granada"
    if "stelvio" in n:
        return "Stelvio"
    return name


def load_xls(path: Path) -> dict[str, list[float]]:
    wb = xlrd.open_workbook(str(path))
    sh = wb.sheet_by_index(0)
    headers = [str(sh.cell_value(0, c)).strip() for c in range(sh.ncols)]
    col = {h: i for i, h in enumerate(headers)}

    def gi(*names: str) -> int:
        for n in names:
            if n in col:
                return col[n]
        raise KeyError(f"missing {names} in {headers}")

    keys = {
        "t": gi("temps [s]"),
        "s": gi("distance [m]"),
        "v": gi("velocity [m/s]"),
        "vkmh": gi("velocity [km/h]"),
        "rpm": gi("speed [rpm]"),
        "tq": gi("torque [Nm]"),
        "pwr": gi("power"),
        "gear": gi("gear"),
        "lat": gi("lat"),
        "lon": gi("lon"),
        "alt": gi("alt [m]"),
        "slope": gi("slope [%]"),
        "curv": gi("curv [1/m]"),
        "lim": gi("spd_lim [km/h]"),
    }
    out: dict[str, list[float]] = {k: [] for k in keys}
    for r in range(1, sh.nrows):
        for k, ci in keys.items():
            val = sh.cell_value(r, ci)
            try:
                out[k].append(float(val) if val != "" else float("nan"))
            except (TypeError, ValueError):
                out[k].append(float("nan"))
    return out


def downsample(series: dict[str, list[float]], max_n: int = 2500) -> dict[str, list[float]]:
    n = len(series["t"])
    if n <= max_n:
        return series
    step = max(1, n // max_n)
    idx = list(range(0, n, step))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return {k: [v[i] for i in idx] for k, v in series.items()}


def fingerprint(path: Path, s: dict[str, list[float]]) -> AvlFP:
    n = len(s["t"])
    t, v = s["t"], s["v"]
    a: list[float] = [0.0]
    jerk: list[float] = [0.0]
    for i in range(1, n):
        dt = t[i] - t[i - 1]
        a.append((v[i] - v[i - 1]) / dt if dt > 1e-6 else 0.0)
    for i in range(1, n):
        dt = t[i] - t[i - 1]
        jerk.append((a[i] - a[i - 1]) / dt if dt > 1e-6 else 0.0)

    ratios, over, moving = [], 0, 0
    for i in range(n):
        lim = s["lim"][i]
        if not math.isfinite(lim) or lim <= 0 or v[i] < 1.5:
            continue
        moving += 1
        r = (v[i] * 3.6) / lim
        ratios.append(r)
        if r > 1.02:
            over += 1

    a_lat = [
        abs(v[i] * v[i] * s["curv"][i])
        for i in range(n)
        if math.isfinite(s["curv"][i]) and math.isfinite(v[i])
    ]
    a_pos = [x for x in a if x > 0.05]
    a_neg = [-x for x in a if x < -0.05]
    j_pos = [x for x in jerk if x > 0.05]
    j_neg = [-x for x in jerk if x < -0.05]
    dts = [t[i] - t[i - 1] for i in range(1, n) if t[i] > t[i - 1]]

    p_kw = []
    for p in s["pwr"]:
        if math.isfinite(p):
            p_kw.append(p / 1000.0 if abs(p) > 500 else p)
    tq_pos = [x for x in s["tq"] if math.isfinite(x) and x > 10]
    tq_neg = [-x for x in s["tq"] if math.isfinite(x) and x < -10]

    gain = loss = 0.0
    for i in range(1, n):
        d = s["alt"][i] - s["alt"][i - 1]
        if not math.isfinite(d):
            continue
        if d > 0:
            gain += d
        else:
            loss += -d

    slope = finite(s["slope"])
    return AvlFP(
        name=path.stem,
        style=style_from_name(path.name),
        route_hint=route_hint(path.name),
        n=n,
        dt_median=pctile(dts, 50),
        duration_s=t[-1] - t[0],
        distance_m=s["s"][-1],
        v_mean_kmh=mean([x * 3.6 for x in v if x > 0.5]),
        v_max_kmh=max(x * 3.6 for x in v),
        a_pos_p95=pctile(a_pos, 95),
        a_pos_p99=pctile(a_pos, 99),
        a_neg_p95=pctile(a_neg, 95),
        a_neg_p99=pctile(a_neg, 99),
        jerk_pos_p95=pctile(j_pos, 95),
        jerk_neg_p95=pctile(j_neg, 95),
        speed_factor_mean=mean(ratios),
        speed_factor_p90=pctile(ratios, 90),
        overspeed_pct=100.0 * over / moving if moving else float("nan"),
        a_lat_p95=pctile(a_lat, 95),
        slope_mean=mean(slope),
        slope_p05=pctile(slope, 5),
        slope_p95=pctile(slope, 95),
        power_max_kw=max(p_kw) if p_kw else float("nan"),
        power_p95_kw=pctile(p_kw, 95),
        torque_p95_nm=pctile(tq_pos, 95),
        torque_brake_p95_nm=pctile(tq_neg, 95),
        gear_max=max(finite(s["gear"])),
        elev_gain_m=gain,
        elev_loss_m=loss,
        alt0=s["alt"][0],
        alt1=s["alt"][-1],
    )


def synth_corridor(
    s: dict[str, list[float]],
    a_y: float,
    *,
    zone_ay: bool = True,
    a_y_hairpin: float | None = None,
) -> SpatialCorridor:
    """Mirror AVL geometry / posted limits / slope into a SpatialCorridor.

    When ``zone_ay`` is True (default), lateral comfort rises toward
    ``a_y_hairpin`` (default 1.25× base) on tight alpine radii so hairpins
    track AVL curve calls without inflating the whole-route a_y.
    """
    S = list(s["s"])
    geometry = [LatLon(lat=s["lat"][i], lon=s["lon"][i]) for i in range(len(S))]
    # AVL slope is % grade → α rad
    alpha = [math.atan(x / 100.0) if math.isfinite(x) else 0.0 for x in s["slope"]]
    V_legal = [
        max(3.0, (s["lim"][i] / 3.6) if math.isfinite(s["lim"][i]) and s["lim"][i] > 0 else s["v"][i] * 1.1)
        for i in range(len(S))
    ]
    R = curvature_radius_m(geometry)
    if zone_ay:
        hair = a_y_hairpin if a_y_hairpin is not None else a_y * 1.25
        ay_seq = alpine_ay_profile(R, a_y, a_y_hairpin=hair)
        V_curve = curve_speed_limit_mps(R, a_y_mps2=ay_seq)
    else:
        V_curve = curve_speed_limit_mps(R, a_y_mps2=a_y)
    V_cible = [min(V_legal[i], V_curve[i], 130 / 3.6) for i in range(len(S))]
    V_envelope = braking_feasible_speed(S, V_cible, b_plan_mps2=1.71)
    V_envelope = smooth_envelope_bilateral(S, V_envelope, tau_spatial_m=40.0, tau_range_mps=2.0)
    V_envelope = smooth_envelope_spatial(S, V_envelope, window_m=25.0)
    return SpatialCorridor(
        S=S,
        V_limite=V_envelope,
        V_limite_legal=V_legal,
        V_traffic=[],
        V_curve=V_curve,
        V_envelope=V_envelope,
        alpha=alpha,
        S_feux=[],
        feux_meta=[],
        events=[],
        geometry=geometry,
        a_y_mps2=a_y,
        elevations_m=list(s["alt"]),
    )


def resample_on_s(
    S_src: list[float], y_src: list[float], S_dst: list[float]
) -> list[float]:
    out: list[float] = []
    j = 0
    n = len(S_src)
    for s in S_dst:
        while j + 1 < n and S_src[j + 1] < s:
            j += 1
        if j + 1 >= n:
            out.append(y_src[-1])
            continue
        s0, s1 = S_src[j], S_src[j + 1]
        if s1 <= s0:
            out.append(y_src[j])
        else:
            u = (s - s0) / (s1 - s0)
            out.append(y_src[j] + u * (y_src[j + 1] - y_src[j]))
    return out


def _pearson(xs: list[float], ys: list[float]) -> float:
    n = min(len(xs), len(ys))
    if n < 3:
        return float("nan")
    mx = sum(xs[:n]) / n
    my = sum(ys[:n]) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    dx = math.sqrt(sum((xs[i] - mx) ** 2 for i in range(n)))
    dy = math.sqrt(sum((ys[i] - my) ** 2 for i in range(n)))
    if dx < 1e-12 or dy < 1e-12:
        return float("nan")
    return num / (dx * dy)


def score_vs_avl(
    profile, S_avl: list[float], v_avl: list[float], dur_avl: float
) -> dict:
    S_cg = list(profile.position)
    v_cg = list(profile.velocity)
    # map AVL v onto CycleGen S samples
    v_avl_on_cg = resample_on_s(S_avl, v_avl, S_cg)
    n = min(len(v_cg), len(v_avl_on_cg))
    if n < 10:
        return {"error": "too few samples"}
    err = [(v_cg[i] - v_avl_on_cg[i]) ** 2 for i in range(n)]
    rmse_v = math.sqrt(sum(err) / n)
    abs_err = [abs(v_cg[i] - v_avl_on_cg[i]) for i in range(n)]
    bias = sum(v_cg[i] - v_avl_on_cg[i] for i in range(n)) / n
    corr = _pearson(v_cg[:n], v_avl_on_cg[:n])
    # Shape: RMSE of Δv along S (same as rmse) + gradient agreement
    # (sign of local speed change matches AVL).
    shape_agree = 0
    shape_n = 0
    step = max(1, n // 200)
    for i in range(step, n, step):
        dv_cg = v_cg[i] - v_cg[i - step]
        dv_avl = v_avl_on_cg[i] - v_avl_on_cg[i - step]
        if abs(dv_avl) < 0.05 and abs(dv_cg) < 0.05:
            continue
        shape_n += 1
        if dv_cg * dv_avl > 0 or (abs(dv_cg) < 0.05 and abs(dv_avl) < 0.15):
            shape_agree += 1
    shape_score = (shape_agree / shape_n) if shape_n else float("nan")
    a = list(profile.acceleration)
    a_pos = [x for x in a if x > 0.05]
    a_neg = [-x for x in a if x < -0.05]
    dur = profile.total_duration_s
    return {
        "rmse_v_mps": round(rmse_v, 3),
        "rmse_v_kmh": round(rmse_v * 3.6, 2),
        "mae_v_kmh": round(mean(abs_err) * 3.6, 2),
        "bias_v_kmh": round(bias * 3.6, 2),
        "corr_v": round(corr, 4) if math.isfinite(corr) else None,
        "shape_score": round(shape_score, 3) if math.isfinite(shape_score) else None,
        "duration_s": round(dur, 1),
        "delta_duration_pct": round(100.0 * (dur - dur_avl) / dur_avl, 2),
        "v_mean_kmh": round(mean([x * 3.6 for x in v_cg if x > 0.5]), 2),
        "v_max_kmh": round(max(x * 3.6 for x in v_cg), 2),
        "a_pos_p95": round(pctile(a_pos, 95), 3),
        "a_neg_p95": round(pctile(a_neg, 95), 3),
        "n": n,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Batch AVL XSPACE .xls → CycleGen IDM compare"
    )
    parser.add_argument(
        "files",
        nargs="*",
        type=Path,
        help="Explicit .xls paths (default: look up DEFAULT_XLS_NAMES under --dir)",
    )
    parser.add_argument(
        "--dir",
        type=Path,
        default=None,
        help="Directory for default filenames (env XSPACE_AVL_DIR, else "
        "backend/.../xspace_avl_xls, data/xspace_avl, or ~/Downloads)",
    )
    args = parser.parse_args(argv)
    xls_dir = (args.dir or resolve_default_xls_dir()).expanduser()
    files = resolve_input_files(list(args.files) if args.files else None, xls_dir)

    reports = []
    for path in files:
        if not path.exists():
            print(f"MISSING {path}", flush=True)
            continue
        print(f"\n=== {path.name} ===", flush=True)
        raw = load_xls(path)
        fp = fingerprint(path, raw)
        print(
            f"  AVL {fp.route_hint} · {fp.style} · {fp.distance_m/1000:.1f} km · "
            f"{fp.duration_s/60:.1f} min · v̄={fp.v_mean_kmh:.1f} · "
            f"a+p95={fp.a_pos_p95:.2f} a-p95={fp.a_neg_p95:.2f} · "
            f"sf̄={fp.speed_factor_mean:.3f} over={fp.overspeed_pct:.1f}% · "
            f"P95={fp.power_p95_kw:.0f} kW τ+={fp.torque_p95_nm:.0f} Nm",
            flush=True,
        )

        # Downsample for IDM speed (Stelvio ~3k pts @0.5s is fine; keep ≤3k)
        ds = downsample(raw, max_n=3000)
        arms = []
        for label, profile, overrides, a_y in PRESETS:
            print(f"  → IDM {label}…", flush=True)
            try:
                corridor = synth_corridor(ds, a_y=a_y)
                solver = IDMSolver(
                    corridor,
                    driver_profile=profile,
                    seed=1,
                    enable_markov=False,
                    max_speed_mps=130 / 3.6,
                    param_overrides=overrides,
                    vehicle=XSPACE_VEHICLE,
                )
                prof = solver.solve()
                sc = score_vs_avl(prof, ds["s"], ds["v"], fp.duration_s)
                sc["preset"] = label
                sc["a_y"] = a_y
                arms.append(sc)
                print(
                    f"     RMSE_v={sc.get('rmse_v_kmh')} km/h  "
                    f"ΔT={sc.get('delta_duration_pct')}%  "
                    f"shape={sc.get('shape_score')} corr={sc.get('corr_v')}  "
                    f"a+={sc.get('a_pos_p95')} a-={sc.get('a_neg_p95')}",
                    flush=True,
                )
            except Exception as e:
                arms.append({"preset": label, "error": str(e)})
                print(f"     ERROR {e}", flush=True)

        # best arm by RMSE_v
        ok = [a for a in arms if "rmse_v_mps" in a]
        best = min(ok, key=lambda a: a["rmse_v_mps"]) if ok else None
        reports.append({"avl": asdict(fp), "arms": arms, "best": best})

    # Style aggregates
    by_style: dict[str, list[dict]] = {"prudent": [], "dynamique": []}
    for r in reports:
        st = r["avl"]["style"]
        if st in by_style:
            by_style[st].append(r["avl"])

    def agg(style: str, key: str) -> float:
        xs = [x[key] for x in by_style[style] if math.isfinite(x.get(key, float("nan")))]
        return round(mean(xs), 4) if xs else float("nan")

    summary = {
        "avl_driver_fingerprint": {
            "prudent": {k: agg("prudent", k) for k in (
                "a_pos_p95", "a_pos_p99", "a_neg_p95", "a_neg_p99",
                "jerk_pos_p95", "jerk_neg_p95", "speed_factor_mean",
                "speed_factor_p90", "overspeed_pct", "a_lat_p95",
            )},
            "dynamique": {k: agg("dynamique", k) for k in (
                "a_pos_p95", "a_pos_p99", "a_neg_p95", "a_neg_p99",
                "jerk_pos_p95", "jerk_neg_p95", "speed_factor_mean",
                "speed_factor_p90", "overspeed_pct", "a_lat_p95",
            )},
        },
        "avl_vehicle_fingerprint": {
            "power_p95_kw_mean": round(mean([
                r["avl"]["power_p95_kw"] for r in reports
                if math.isfinite(r["avl"]["power_p95_kw"])
            ]), 1),
            "power_max_kw_mean": round(mean([
                r["avl"]["power_max_kw"] for r in reports
                if math.isfinite(r["avl"]["power_max_kw"])
            ]), 1),
            "torque_p95_nm_mean": round(mean([
                r["avl"]["torque_p95_nm"] for r in reports
                if math.isfinite(r["avl"]["torque_p95_nm"])
            ]), 0),
            "torque_brake_p95_nm_mean": round(mean([
                r["avl"]["torque_brake_p95_nm"] for r in reports
                if math.isfinite(r["avl"]["torque_brake_p95_nm"])
            ]), 0),
        },
        "cyclegen_presets": {
            "Eco": {"a_max": 1.2, "b_comf": 1.2, "sf": 0.95, "jerk": 0.5, "jerk_b": 1.5, "a_y": 2.0},
            "Normal": {"a_max": 2.0, "b_comf": 2.0, "sf": 1.05, "jerk": 1.5, "jerk_b": 3.0, "a_y": 3.0},
            "Sportif": {"a_max": 3.5, "b_comf": 3.5, "sf": 1.10, "jerk": 3.0, "jerk_b": 5.0, "a_y": 3.5},
            "Standard_AVL_BCB": {"a_max": 2.58, "b_comf": 1.71, "sf": 1.05, "jerk": 0.96, "jerk_b": 2.93, "a_y": 3.5},
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

    out = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "method": "synth_corridor_from_avl_geometry + IDMSolver batch",
        "summary": summary,
        "traces": reports,
    }
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_path = OUT_DIR / f"xspace_avl_batch_{stamp}.json"
    latest = OUT_DIR / "xspace_avl_batch_latest.json"
    text = json.dumps(out, indent=2, ensure_ascii=False)
    out_path.write_text(text)
    latest.write_text(text)
    print(f"\nWrote {out_path}", flush=True)
    print("\n=== RECOMMENDED PRESETS (from AVL p95 fingerprints) ===", flush=True)
    print(json.dumps(summary["recommended_presets"], indent=2), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
