"""N90 calibration grid — pick DriverPhysics that minimises RMSE vs AVL CRUISE.

The endpoint (``POST /calibrate/n90``) exposes this. See
``backend/app/data/benchmark/avl_n90_bcb_1hz.csv`` for the reference series.

Objective (minimise) ::

    score = RMSE_v + lambda_a · RMSE_a + mu_dt · |ΔT_total_pct|

Grid keys (parametric bounds around the BCB baseline):

    a_max, b_comf, T, T_h, s0, jerk_max, jerk_brake_max, speed_factor

Writes ``backend/app/data/benchmark/calibration/latest_n90.{json,md}``.
"""

from __future__ import annotations

import itertools
import json
import logging
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from app.models.schemas import (
    CalibrationArm,
    CalibrationRecommendation,
    DriverProfile,
    LatLon,
    SpatialCorridor,
)
from app.services.benchmark_loader import load_reference
from app.services.benchmark_metrics import compute_comparison
from app.services.curvature import (
    braking_feasible_speed,
    curve_speed_limit_mps,
    curvature_radius_m,
    smooth_envelope_bilateral,
    smooth_envelope_spatial,
)
from app.services.kinematic_solver import IDMSolver, PROFILE_PARAMS

logger = logging.getLogger(__name__)

CALIBRATION_DIR = (
    Path(__file__).resolve().parent.parent
    / "data"
    / "benchmark"
    / "calibration"
)


# Default compact grid around BCB baseline (~2^3 combos per axis at most).
# Total < max_arms after Cartesian product cap.
DEFAULT_GRIDS: dict[str, list[float]] = {
    "a_max": [1.6, 2.0, 2.4],
    "b_comf": [1.6, 2.0, 2.6],
    "T": [1.2, 1.5, 1.8],
    "T_h": [3.5, 4.5],
    "s0": [2.0],
    "jerk_max": [1.5],
    "jerk_brake_max": [3.0],
    "speed_factor": [0.95, 1.05, 1.10],
}


@dataclass
class _ArmSpec:
    a_max: float
    b_comf: float
    T: float
    T_h: float
    s0: float
    jerk_max: float
    jerk_brake_max: float
    speed_factor: float

    @property
    def id(self) -> str:
        return (
            f"a{self.a_max:.2f}_b{self.b_comf:.2f}_T{self.T:.2f}"
            f"_Th{self.T_h:.1f}_s0{self.s0:.1f}"
            f"_jm{self.jerk_max:.1f}_jb{self.jerk_brake_max:.1f}"
            f"_sf{self.speed_factor:.2f}"
        )

    def overrides(self) -> dict[str, float]:
        return {
            "a_max": float(self.a_max),
            "b_comf": float(self.b_comf),
            "T": float(self.T),
            "T_h": float(self.T_h),
            "s0": float(self.s0),
            "jerk_max": float(self.jerk_max),
            "jerk_brake_max": float(self.jerk_brake_max),
            "speed_factor": float(self.speed_factor),
        }


def _resolve_grid(
    key: str, override: list[float] | None
) -> list[float]:
    if override:
        return [float(x) for x in override]
    return list(DEFAULT_GRIDS[key])


def build_grid(
    *,
    a_max_grid: list[float] | None,
    b_comf_grid: list[float] | None,
    T_grid: list[float] | None,
    T_h_grid: list[float] | None,
    s0_grid: list[float] | None,
    jerk_max_grid: list[float] | None,
    jerk_brake_max_grid: list[float] | None,
    speed_factor_grid: list[float] | None,
    max_arms: int,
) -> list[_ArmSpec]:
    combos = itertools.product(
        _resolve_grid("a_max", a_max_grid),
        _resolve_grid("b_comf", b_comf_grid),
        _resolve_grid("T", T_grid),
        _resolve_grid("T_h", T_h_grid),
        _resolve_grid("s0", s0_grid),
        _resolve_grid("jerk_max", jerk_max_grid),
        _resolve_grid("jerk_brake_max", jerk_brake_max_grid),
        _resolve_grid("speed_factor", speed_factor_grid),
    )
    arms: list[_ArmSpec] = [
        _ArmSpec(
            a_max=a,
            b_comf=b,
            T=T,
            T_h=Th,
            s0=s0,
            jerk_max=jm,
            jerk_brake_max=jb,
            speed_factor=sf,
        )
        for (a, b, T, Th, s0, jm, jb, sf) in combos
    ]
    if len(arms) > max_arms:
        # Uniform stride so we still cover the whole space.
        stride = max(1, len(arms) // max_arms)
        arms = arms[::stride][:max_arms]
    return arms


def _rmse_accel(
    profile: dict[str, Any],
    reference: dict[str, Any],
    align_result: dict[str, Any],
) -> float:
    """RMSE on 1 Hz–aligned longitudinal accel."""
    times = align_result.get("times") or []
    if len(times) < 2:
        return 0.0
    t_common = np.asarray(times, dtype=float)
    # Reference series (may be raw 10 Hz → use its own time base).
    t_ref = np.asarray(reference.get("time") or [], dtype=float)
    a_ref_raw = reference.get("acceleration")
    if a_ref_raw is not None and len(a_ref_raw) == len(t_ref):
        a_ref = np.asarray(a_ref_raw, dtype=float)
    else:
        v_ref = np.asarray(reference.get("velocity") or [], dtype=float)
        if len(v_ref) < 2:
            return 0.0
        dt = np.diff(t_ref)
        dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
        a_ref = np.concatenate([[0.0], np.diff(v_ref) / dt])
    a_ref_i = np.interp(t_common, t_ref, a_ref)

    t_gen = np.asarray(profile.get("time") or [], dtype=float)
    a_gen_raw = profile.get("acceleration")
    if a_gen_raw is not None and len(a_gen_raw) == len(t_gen):
        a_gen = np.asarray(a_gen_raw, dtype=float)
    else:
        v_gen = np.asarray(profile.get("velocity") or [], dtype=float)
        if len(v_gen) < 2:
            return 0.0
        dt = np.diff(t_gen)
        dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
        a_gen = np.concatenate([[0.0], np.diff(v_gen) / dt])
    a_gen_i = np.interp(t_common, t_gen, a_gen)

    diff = a_gen_i - a_ref_i
    return float(np.sqrt(np.mean(diff * diff)))


def _p95_abs_jerk(profile: dict[str, Any]) -> float:
    t = np.asarray(profile.get("time") or [], dtype=float)
    a = np.asarray(profile.get("acceleration") or [], dtype=float)
    if len(t) < 3 or len(a) != len(t):
        return 0.0
    dt = np.diff(t)
    dt = np.where(np.abs(dt) < 1e-9, 1e-9, dt)
    jerk = np.diff(a) / dt
    return float(np.percentile(np.abs(jerk), 95))


def _score(arm_kpis: dict[str, Any], rmse_a: float, *, lam: float, mu: float) -> float:
    rmse_v = float(arm_kpis.get("rmse_v") or 0.0)
    d_dur = abs(float(arm_kpis.get("delta_duration_pct") or 0.0))
    return rmse_v + lam * rmse_a + mu * d_dur


def _write_report(
    *,
    out_dir: Path,
    reference_id: str,
    corridor_id: str,
    arms: list[CalibrationArm],
    best: CalibrationArm,
    recommended: CalibrationRecommendation,
) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")

    payload: dict[str, Any] = {
        "generated_at": now.isoformat(),
        "reference_id": reference_id,
        "corridor_id": corridor_id,
        "n_arms": len(arms),
        "best_arm_id": best.id,
        "recommended": recommended.model_dump(),
        "arms": [a.model_dump() for a in arms],
    }
    latest_json = out_dir / "latest_n90.json"
    stamped_json = out_dir / f"n90_{stamp}.json"
    latest_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    stamped_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    md_lines = [
        "# CycleGen calibration — AVL N90 (BSM→Albertville)",
        "",
        f"Generated: `{now.isoformat()}`",
        f"Reference: `{reference_id}` · Corridor: `{corridor_id}` · Grid arms: **{len(arms)}**",
        "",
        "## Recommended DriverPhysics",
        "",
        f"- driver_profile: `{recommended.driver_profile.value}`",
        f"- speed_factor : `{recommended.speed_factor:.3f}`",
        f"- a_max        : `{recommended.a_max:.3f}` m/s²",
        f"- b_comf       : `{recommended.b_comf:.3f}` m/s²",
        f"- T (headway)  : `{recommended.T:.3f}` s",
        f"- T_h (scan)   : `{recommended.T_h:.3f}` s",
        f"- s0           : `{recommended.s0:.3f}` m",
        f"- jerk_max     : `{recommended.jerk_max:.3f}` m/s³",
        f"- jerk_brake_max : `{recommended.jerk_brake_max:.3f}` m/s³",
        "",
        "## Top 5 arms",
        "",
        "| Rank | Arm | RMSE_v | RMSE_a | ΔT% | Score |",
        "|------|-----|--------|--------|-----|-------|",
    ]
    for i, arm in enumerate(arms[:5]):
        md_lines.append(
            f"| {i + 1} | `{arm.id}` | {arm.rmse_v:.3f} | {arm.rmse_a:.3f} | "
            f"{arm.delta_duration_pct:+.2f} | {arm.score:.3f} |"
        )
    md_lines.extend(
        [
            "",
            "## Recette N90 (targets)",
            "",
            "- RMSE_v ≤ 2.5 m/s",
            "- RMSE_a ≤ 0.25 m/s²",
            "- |ΔT_total| ≤ 3 %",
            "",
        ]
    )
    latest_md = out_dir / "latest_n90.md"
    stamped_md = out_dir / f"n90_{stamp}.md"
    md_text = "\n".join(md_lines) + "\n"
    latest_md.write_text(md_text, encoding="utf-8")
    stamped_md.write_text(md_text, encoding="utf-8")

    return latest_json, latest_md


def synth_corridor_from_reference(
    reference_id: str = "avl_n90_bcb",
    *,
    a_y_mps2: float = 2.5,
) -> SpatialCorridor:
    """Build a ``SpatialCorridor`` directly from a benchmark reference series.

    Uses reference lat/lon, position, slope and optional posted speed limit to
    build a corridor that mirrors the AVL trajectory. This lets the calibrator
    (and recette test) run end-to-end without a live Mapbox/OSM fetch.
    """
    ref = load_reference(reference_id)
    if not ref:
        raise ValueError(f"Reference '{reference_id}' not found")
    lat = ref.get("lat") or []
    lon = ref.get("lon") or []
    pos = ref.get("position") or []
    slope = ref.get("slope") or []
    velocity = ref.get("velocity") or []
    if len(lat) < 2 or len(pos) < 2:
        raise ValueError(f"Reference '{reference_id}' lacks lat/lon or position")

    S = [float(p) for p in pos]
    geometry = [LatLon(lat=float(lat[i]), lon=float(lon[i])) for i in range(len(lat))]
    alpha = [float(a) for a in slope] if slope and len(slope) == len(S) else [0.0] * len(S)

    # Recover posted speed limit if the CSV shipped a spd_lim column.
    # Fall back to observed velocity + 20 % (rough legal envelope).
    spd_lim_source: list[float]
    # Re-read raw file to grab spd_lim_kmh (not in ``load_reference`` schema).
    from pathlib import Path
    from app.services.benchmark_loader import BENCHMARK_DIR, _load_manifest

    manifest = _load_manifest()
    src = next(
        (s for s in manifest.get("sources", []) if s.get("id") == reference_id),
        None,
    )
    if src is not None and (BENCHMARK_DIR / src["filename"]).is_file():
        import csv

        path = BENCHMARK_DIR / src["filename"]
        spd_lim_source = []
        with path.open(newline="", encoding="utf-8-sig") as f:
            rd = csv.DictReader(f)
            for row in rd:
                v = row.get("spd_lim_kmh") or row.get("spd_lim")
                try:
                    spd_lim_source.append(float(v) / 3.6 if v else 0.0)
                except ValueError:
                    spd_lim_source.append(0.0)
    else:
        spd_lim_source = []
    if len(spd_lim_source) == len(S) and any(x > 1.0 for x in spd_lim_source):
        V_legal = [max(v, 3.0) for v in spd_lim_source]
    else:
        V_legal = [max(3.0, v * 1.10) for v in velocity]  # +10 % safety margin

    # Curvature from geometry
    R = curvature_radius_m(geometry)
    V_curve = curve_speed_limit_mps(R, a_y_mps2=a_y_mps2)
    V_cible = [min(V_legal[i], V_curve[i]) for i in range(len(S))]
    V_envelope = braking_feasible_speed(S, V_cible, b_plan_mps2=1.71)
    V_envelope = smooth_envelope_bilateral(
        S, V_envelope, tau_spatial_m=40.0, tau_range_mps=2.0
    )
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
        a_y_mps2=a_y_mps2,
    )


def run_n90_calibration(
    *,
    corridor: SpatialCorridor,
    corridor_id: str,
    reference_id: str = "avl_n90_bcb",
    driver_profile: DriverProfile = DriverProfile.NORMAL,
    seed: int | None = 42,
    lambda_a: float = 4.0,
    mu_dt: float = 0.08,
    a_max_grid: list[float] | None = None,
    b_comf_grid: list[float] | None = None,
    T_grid: list[float] | None = None,
    T_h_grid: list[float] | None = None,
    s0_grid: list[float] | None = None,
    jerk_max_grid: list[float] | None = None,
    jerk_brake_max_grid: list[float] | None = None,
    speed_factor_grid: list[float] | None = None,
    max_arms: int = 96,
) -> dict[str, Any]:
    """Run the calibration grid; returns dict compatible with ``N90CalibrateResponse``."""
    warnings: list[str] = []
    ref = load_reference(reference_id)
    if not ref:
        raise ValueError(f"Reference '{reference_id}' not found")
    if not (corridor.S and corridor.geometry):
        raise ValueError("Corridor is empty (no S / geometry)")

    arms_spec = build_grid(
        a_max_grid=a_max_grid,
        b_comf_grid=b_comf_grid,
        T_grid=T_grid,
        T_h_grid=T_h_grid,
        s0_grid=s0_grid,
        jerk_max_grid=jerk_max_grid,
        jerk_brake_max_grid=jerk_brake_max_grid,
        speed_factor_grid=speed_factor_grid,
        max_arms=max_arms,
    )
    if not arms_spec:
        raise ValueError("Empty grid — check *_grid overrides")

    scored: list[CalibrationArm] = []
    baseline = PROFILE_PARAMS.get(driver_profile) or PROFILE_PARAMS[DriverProfile.NORMAL]
    for spec in arms_spec:
        try:
            solver = IDMSolver(
                corridor,
                driver_profile=driver_profile,
                seed=seed,
                param_overrides=spec.overrides(),
                tls_override="green_wave",  # N90 is a rural corridor — TLS not the dominant factor
            )
            profile = solver.solve()
            profile_dict = profile.model_dump()
            cmp = compute_comparison(profile_dict, ref, align="time")
            kpis = cmp["kpis"]
            rmse_a = _rmse_accel(profile_dict, ref, cmp)
            score = _score(kpis, rmse_a, lam=lambda_a, mu=mu_dt)
            scored.append(
                CalibrationArm(
                    id=spec.id,
                    driver_profile=driver_profile,
                    speed_factor=spec.speed_factor,
                    a_max=spec.a_max,
                    b_comf=spec.b_comf,
                    T=spec.T,
                    T_h=spec.T_h,
                    s0=spec.s0,
                    jerk_max=spec.jerk_max,
                    jerk_brake_max=spec.jerk_brake_max,
                    rmse_v=float(kpis["rmse_v"]),
                    rmse_a=rmse_a,
                    delta_duration_s=float(kpis["delta_duration_s"]),
                    delta_duration_pct=float(kpis["delta_duration_pct"]),
                    delta_distance_m=float(kpis["delta_distance_m"]),
                    p95_abs_jerk=_p95_abs_jerk(profile_dict),
                    score=score,
                )
            )
        except Exception as exc:  # noqa: BLE001 — never blow up a whole grid
            warnings.append(f"arm {spec.id} failed: {exc}")
            logger.warning("arm %s failed: %s", spec.id, exc)

    if not scored:
        raise RuntimeError("All grid arms failed; check server logs")

    scored.sort(key=lambda a: a.score)
    best = scored[0]
    recommended = CalibrationRecommendation(
        driver_profile=driver_profile,
        speed_factor=best.speed_factor,
        a_max=best.a_max,
        b_comf=best.b_comf,
        T=best.T,
        T_h=best.T_h,
        s0=best.s0,
        jerk_max=best.jerk_max,
        jerk_brake_max=best.jerk_brake_max,
    )
    latest_json, latest_md = _write_report(
        out_dir=CALIBRATION_DIR,
        reference_id=reference_id,
        corridor_id=corridor_id,
        arms=scored,
        best=best,
        recommended=recommended,
    )

    return {
        "reference_id": reference_id,
        "corridor_id": corridor_id,
        "n_arms": len(scored),
        "best_arm_id": best.id,
        "recommended": recommended,
        "arms": scored,
        "written_json": str(latest_json),
        "written_markdown": str(latest_md),
        "warnings": warnings,
    }
