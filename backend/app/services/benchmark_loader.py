"""Pinned benchmark corpus: manifest + SHA256 + optional HTTP fetch (no git clone)."""

from __future__ import annotations

import csv
import hashlib
import json
import logging
import math
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

BENCHMARK_DIR = Path(__file__).resolve().parent.parent / "data" / "benchmark"
MANIFEST_PATH = BENCHMARK_DIR / "manifest.json"

_TIME_ALIASES = ("time_s", "time", "t", "seconds", "time[s]", "temps")
_VEL_ALIASES = (
    "velocity_mps",
    "velocity",
    "v",
    "speed_mps",
    "speed",
    "speed_kmh",
    "v_kmh",
    "velocity_kmh",
)
_LAT_ALIASES = ("lat", "latitude")
_LON_ALIASES = ("lon", "lng", "longitude")
_POS_ALIASES = ("position", "s", "distance", "distance_m", "s_m", "position_m")
_SLOPE_ALIASES = ("slope_pct", "slope_percent", "grade_pct", "pente", "slope", "alpha", "grade")
_ACCEL_ALIASES = ("acceleration", "accel", "a", "acceleration_mps2", "a_mps2")
_ALAT_ALIASES = ("a_lat", "a_lat_mps2", "alat", "lateral_accel", "a_y")
_ZONE_ALIASES = ("zone_id", "zone", "part")
# Automotive paved-road sanity (OEM Grossglockner ≤ 13.5 %, alpine passes ~14 %).
_MAX_ABS_GRADE = 0.15
_MAX_ABS_A_LAT = 6.5


def _norm_header(name: str) -> str:
    return name.strip().lower().replace(" ", "_")


def _pick_column(headers: list[str], aliases: tuple[str, ...]) -> str | None:
    lookup = {_norm_header(h): h for h in headers}
    for alias in aliases:
        if alias in lookup:
            return lookup[alias]
    return None


def _slope_values_are_percent(raw: list[float], col_name: str | None) -> bool:
    """Decide whether raw slope column is % grade (vs radians / rise-run)."""
    if col_name:
        h = _norm_header(col_name)
        if any(tok in h for tok in ("pct", "percent", "pente", "%")):
            return True
        if "rad" in h:
            return False
    if not raw:
        return False
    sample = sorted(abs(x) for x in raw)
    med = sample[len(sample) // 2]
    # |grade| > 0.5 as dimensionless is already 50 % — treat as percent numbers.
    return med > 0.5


def _series_stats(ref: dict[str, Any]) -> dict[str, Any]:
    """Compute catalogue KPIs (incl. slope %) from a parsed reference series."""
    time_s = ref.get("time") or []
    velocity = ref.get("velocity") or []
    n = len(time_s)
    if n < 2:
        return {}

    duration_s = float(time_s[-1] - time_s[0])
    position = ref.get("position")
    if position and len(position) == n:
        distance_m = float(position[-1] - position[0])
    else:
        distance_m = 0.0
        for i in range(1, n):
            dt = max(float(time_s[i] - time_s[i - 1]), 1e-9)
            distance_m += 0.5 * (float(velocity[i]) + float(velocity[i - 1])) * dt

    v_mean = sum(velocity) / n
    out: dict[str, Any] = {
        "n_points": n,
        "duration_s": round(duration_s, 1),
        "distance_m": round(distance_m, 1),
        "v_mean_kmh": round(v_mean * 3.6, 2),
        "v_max_kmh": round(max(velocity) * 3.6, 2),
        "v_min_kmh": round(min(velocity) * 3.6, 2),
    }

    accel = ref.get("acceleration")
    if accel and len(accel) == n:
        pos_a = [a for a in accel if a > 0.05]
        neg_a = [a for a in accel if a < -0.05]
        out["a_max_mps2"] = round(max(accel), 3)
        out["a_min_mps2"] = round(min(accel), 3)
        if pos_a:
            out["a_mean_accel_mps2"] = round(sum(pos_a) / len(pos_a), 3)
        if neg_a:
            out["a_mean_decel_mps2"] = round(sum(neg_a) / len(neg_a), 3)

    a_lat = ref.get("a_lat")
    if a_lat and len(a_lat) == n:
        out["a_lat_max_mps2"] = round(max(abs(x) for x in a_lat), 3)

    slope = ref.get("slope")
    if slope and len(slope) == n:
        pct = [math.tan(float(a)) * 100.0 for a in slope]
        out["slope_mean_pct"] = round(sum(pct) / len(pct), 2)
        out["slope_min_pct"] = round(min(pct), 2)
        out["slope_max_pct"] = round(max(pct), 2)

    return out


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        raise FileNotFoundError(
            f"Benchmark manifest missing at {MANIFEST_PATH}. "
            "Seed files should be vendored under app/data/benchmark/."
        )
    with MANIFEST_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def ensure_sources() -> list[str]:
    """Ensure catalog files exist; fetch HTTP entries when missing. Returns warnings."""
    BENCHMARK_DIR.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    try:
        manifest = _load_manifest()
    except FileNotFoundError as exc:
        return [str(exc)]

    for src in manifest.get("sources", []):
        filename = src.get("filename")
        if not filename:
            continue
        path = BENCHMARK_DIR / filename
        expected = (src.get("sha256") or "").strip()
        url = (src.get("url") or "").strip()

        if path.exists():
            if expected and expected not in {"seed", ""}:
                got = _sha256_file(path)
                if got != expected:
                    warnings.append(
                        f"Hash mismatch for {filename}: expected {expected[:12]}… got {got[:12]}…"
                    )
            continue

        if not url:
            warnings.append(f"Missing local seed file (offline): {filename}")
            continue

        try:
            with httpx.Client(timeout=20.0, follow_redirects=True) as client:
                resp = client.get(url)
                resp.raise_for_status()
                content = resp.content
            if expected and expected not in {"seed", ""}:
                got = _sha256_bytes(content)
                if got != expected:
                    warnings.append(
                        f"Download hash mismatch for {filename}; file not written."
                    )
                    continue
            path.write_bytes(content)
            logger.info("Downloaded benchmark source %s", filename)
        except Exception as exc:  # noqa: BLE001 — offline tolerance
            warnings.append(f"Could not download {filename}: {exc}")

    return warnings


def list_sources() -> list[dict[str, Any]]:
    ensure_sources()
    manifest = _load_manifest()
    out: list[dict[str, Any]] = []
    for src in manifest.get("sources", []):
        path = BENCHMARK_DIR / src["filename"]
        n_points = 0
        duration_s = 0.0
        has_geo = bool(src.get("has_geo", False))
        live_stats: dict[str, Any] = {}
        if path.exists():
            try:
                ref = _parse_csv(path, velocity_unit=src.get("velocity_unit"))
                n_points = len(ref["time"])
                if n_points:
                    duration_s = float(ref["time"][-1] - ref["time"][0])
                has_geo = bool(ref.get("has_geo"))
                live_stats = _series_stats(ref)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to inspect %s: %s", path.name, exc)

        # File-derived KPIs win over stale manifest (e.g. missing Renault slope %).
        merged_stats: dict[str, Any] = {}
        if isinstance(src.get("stats"), dict):
            merged_stats.update(src["stats"])
        merged_stats.update(live_stats)

        out.append(
            {
                "id": src["id"],
                "name": src["name"],
                "license": src.get("license", ""),
                "has_geo": has_geo,
                "n_points": n_points,
                "duration_s": duration_s,
                "family": str(src.get("family") or "regulatory"),
                "source": src.get("source"),
                "added_at": src.get("added_at"),
                "stats": merged_stats or None,
                "zones": src.get("zones"),
                "zone_split": src.get("zone_split"),
                "vehicle": src.get("vehicle"),
                "citation": src.get("citation"),
                "url": (src.get("url") or "").strip() or None,
            }
        )
    return out


def load_reference(source_id: str) -> dict[str, Any] | None:
    ensure_sources()
    manifest = _load_manifest()
    target = next(
        (s for s in manifest.get("sources", []) if s.get("id") == source_id),
        None,
    )
    if not target:
        return None
    path = BENCHMARK_DIR / target["filename"]
    if not path.exists():
        return None
    try:
        return _parse_csv(path, velocity_unit=target.get("velocity_unit"))
    except Exception:
        logger.exception("Failed to parse reference %s", source_id)
        return None


def _parse_csv(
    path: Path, *, velocity_unit: str | None = None
) -> dict[str, Any]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError(f"Empty CSV: {path.name}")
        headers = list(reader.fieldnames)
        t_col = _pick_column(headers, _TIME_ALIASES)
        v_col = _pick_column(headers, _VEL_ALIASES)
        if not t_col or not v_col:
            raise ValueError(
                f"CSV {path.name} needs time + velocity columns "
                f"(got {headers})"
            )
        lat_col = _pick_column(headers, _LAT_ALIASES)
        lon_col = _pick_column(headers, _LON_ALIASES)
        pos_col = _pick_column(headers, _POS_ALIASES)
        slope_col = _pick_column(headers, _SLOPE_ALIASES)
        accel_col = _pick_column(headers, _ACCEL_ALIASES)
        alat_col = _pick_column(headers, _ALAT_ALIASES)

        time_s: list[float] = []
        velocity: list[float] = []
        lat: list[float] = []
        lon: list[float] = []
        position: list[float] = []
        slope_raw: list[float] = []
        acceleration: list[float] = []
        a_lat: list[float] = []

        v_name = _norm_header(v_col)
        force_kmh = (velocity_unit or "").lower() in {"km/h", "kmh"} or "kmh" in v_name
        # Heuristic: if unit unknown and median raw value > 60, treat as km/h
        raw_rows = list(reader)

        for row in raw_rows:
            time_s.append(float(row[t_col]))
            velocity.append(float(row[v_col]))
            if lat_col and lon_col and row.get(lat_col) not in (None, ""):
                lat.append(float(row[lat_col]))
                lon.append(float(row[lon_col]))
            if pos_col and row.get(pos_col) not in (None, ""):
                position.append(float(row[pos_col]))
            if slope_col and row.get(slope_col) not in (None, ""):
                slope_raw.append(float(row[slope_col]))
            if accel_col and row.get(accel_col) not in (None, ""):
                acceleration.append(float(row[accel_col]))
            if alat_col and row.get(alat_col) not in (None, ""):
                a_lat.append(float(row[alat_col]))

        if not force_kmh and velocity:
            sample = sorted(abs(x) for x in velocity)[len(velocity) // 2]
            if sample > 60.0:
                force_kmh = True

        if force_kmh:
            velocity = [v / 3.6 for v in velocity]

        slope: list[float] = []
        if slope_raw and len(slope_raw) == len(time_s):
            as_pct = _slope_values_are_percent(slope_raw, slope_col)
            for raw_sl in slope_raw:
                if as_pct:
                    # Clamp absurd GNSS / unit-mix spikes to paved-road range.
                    grade = max(-_MAX_ABS_GRADE, min(_MAX_ABS_GRADE, raw_sl / 100.0))
                    slope.append(math.atan(grade))
                else:
                    # Radians or rise/run — if |x| looks like percent, fix it.
                    if abs(raw_sl) > 0.5:
                        grade = max(
                            -_MAX_ABS_GRADE, min(_MAX_ABS_GRADE, raw_sl / 100.0)
                        )
                        slope.append(math.atan(grade))
                    else:
                        grade = math.tan(raw_sl)
                        grade = max(-_MAX_ABS_GRADE, min(_MAX_ABS_GRADE, grade))
                        slope.append(math.atan(grade))

        if a_lat and len(a_lat) == len(time_s):
            a_lat = [
                max(-_MAX_ABS_A_LAT, min(_MAX_ABS_A_LAT, float(x))) for x in a_lat
            ]

        has_geo = len(lat) == len(time_s) == len(lon) and len(lat) > 0
        result: dict[str, Any] = {
            "time": time_s,
            "velocity": velocity,
            "has_geo": has_geo,
            "lat": lat if has_geo else None,
            "lon": lon if has_geo else None,
            "position": position if len(position) == len(time_s) else None,
            "slope": slope if len(slope) == len(time_s) else None,
            "acceleration": (
                acceleration if len(acceleration) == len(time_s) else None
            ),
            "a_lat": a_lat if len(a_lat) == len(time_s) else None,
        }
        return result
