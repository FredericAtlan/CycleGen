#!/usr/bin/env python3
"""Import alpine descent stress profiles into CycleGen benchmark corpus.

Sources (see CITATIONS.md):
  - Grossglockner: Bikemap route 3666733 GPX
  - Col de l'Iseran: VisuGPX XBQ5qiLV9r GPX
  - Stelvio Nord (Prato): PJAMM climb 26 embedded GPX (reversed → descent)

Usage (from repo root):
  python scripts/import_alpine_descents.py
  python scripts/import_alpine_descents.py --offline   # reuse /tmp/cyclegen_alpine/*.gpx
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import urllib.request
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "backend" / "app" / "data" / "benchmark"
MANIFEST = BENCH / "manifest.json"
CACHE = Path("/tmp/cyclegen_alpine")
UA = {"User-Agent": "Mozilla/5.0 (compatible; CycleGen/1.0; alpine-corpus)"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def parse_gpx(path: Path) -> list[tuple[float, float, float]]:
    root = ET.parse(path).getroot()
    pts: list[tuple[float, float, float]] = []
    last_ele: float | None = None
    for node in root.iter():
        if not (node.tag.endswith("trkpt") or node.tag.endswith("rtept")):
            continue
        lat = float(node.attrib["lat"])
        lon = float(node.attrib["lon"])
        ele = None
        for child in node:
            if child.tag.endswith("ele") and child.text:
                ele = float(child.text)
                break
        if ele is None:
            ele = last_ele if last_ele is not None else 0.0
        else:
            last_ele = ele
        pts.append((lat, lon, ele))
    return pts


def descent_leg(pts: list[tuple[float, float, float]]) -> list[tuple[float, float, float]]:
    """Keep summit → end if that drops; else reverse ascent into descent."""
    if len(pts) < 10:
        return pts
    imax = max(range(len(pts)), key=lambda i: pts[i][2])
    after = pts[imax:]
    before = pts[: imax + 1]
    drop_after = pts[imax][2] - pts[-1][2]
    drop_before = pts[imax][2] - pts[0][2]
    if drop_after >= drop_before and len(after) >= 20:
        return after
    # reverse ascent (start low → summit) into descent
    return list(reversed(before))


def _cumdist_m(pts: list[tuple[float, float, float]]) -> list[float]:
    s = [0.0]
    for i in range(1, len(pts)):
        s.append(
            s[-1]
            + haversine_m(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
        )
    return s


def final_valley_descent(
    pts: list[tuple[float, float, float]],
    *,
    target_len_m: float = 14200.0,
    len_min_m: float = 11000.0,
    len_max_m: float = 17000.0,
    min_drop_m: float = 900.0,
) -> list[tuple[float, float, float]]:
    """Extract a single continuous descent into the valley floor.

    Used for Grossglockner (Bikemap out-and-back with spurs): keep the last
    high→valley leg (~14 km / −1.2 km) so it is comparable to the Renault OEM
    Route Planner profile (~14.2 km, ≈ −1.38 km integrated).
    """
    if len(pts) < 40:
        return descent_leg(pts)

    s = _cumdist_m(pts)
    s_tot = s[-1]
    if s_tot < len_min_m:
        return descent_leg(pts)

    # Valley anchor: lowest point in the last 35 % of the trace
    tail = [i for i in range(len(pts)) if s[i] >= 0.65 * s_tot]
    if len(tail) < 5:
        tail = list(range(int(0.65 * len(pts)), len(pts)))
    imin = min(tail, key=lambda i: (pts[i][2], -s[i]))

    # Search starts that end at/near valley with length in [len_min, len_max]
    best: tuple[float, int, int] | None = None  # (score, i0, i1)
    j = 0
    for i in range(imin + 1):
        # advance j so s[j]-s[i] reaches len_min
        while j < imin and s[j] - s[i] < len_min_m:
            j += 1
        k = j
        while k <= imin and s[k] - s[i] <= len_max_m:
            dist = s[k] - s[i]
            drop = pts[i][2] - pts[k][2]
            if drop >= min_drop_m and dist >= len_min_m:
                # Prefer: large drop, length close to OEM, end near valley
                near_valley = 1.0 - min(1.0, (s[imin] - s[k]) / max(s_tot * 0.1, 1.0))
                len_fit = 1.0 - min(1.0, abs(dist - target_len_m) / target_len_m)
                score = drop + 80.0 * len_fit + 120.0 * near_valley
                if best is None or score > best[0]:
                    best = (score, i, k)
            k += 1

    if best is None:
        # Fallback: highest point within 20 km before valley → valley
        window = [i for i in range(imin + 1) if s[imin] - s[i] <= 20000.0]
        if not window:
            return descent_leg(pts)
        i0 = max(window, key=lambda i: pts[i][2])
        if pts[i0][2] - pts[imin][2] < min_drop_m:
            return descent_leg(pts)
        return pts[i0 : imin + 1]

    _, i0, i1 = best
    return pts[i0 : i1 + 1]


def extract_descent(
    pts: list[tuple[float, float, float]], key: str
) -> list[tuple[float, float, float]]:
    if key == "grossglockner":
        return final_valley_descent(pts)
    return descent_leg(pts)

def resample_by_distance(
    pts: list[tuple[float, float, float]], step_m: float = 12.0
) -> list[tuple[float, float, float, float]]:
    """Return [(lat, lon, ele, s_m), ...] roughly every step_m."""
    if len(pts) < 2:
        return []
    out: list[tuple[float, float, float, float]] = [
        (pts[0][0], pts[0][1], pts[0][2], 0.0)
    ]
    acc = 0.0
    for i in range(1, len(pts)):
        d = haversine_m(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
        if d < 0.05:
            continue
        acc += d
        if acc >= step_m or i == len(pts) - 1:
            s = out[-1][3] + acc
            out.append((pts[i][0], pts[i][1], pts[i][2], s))
            acc = 0.0
    return out


def heading_delta(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def smooth_elevation(
    pts_s: list[tuple[float, float, float, float]], window_m: float = 100.0
) -> list[float]:
    """Distance-weighted moving average on elevation (kills GNSS plateaus / jumps)."""
    n = len(pts_s)
    if n == 0:
        return []
    half = window_m / 2.0
    out: list[float] = []
    for i in range(n):
        s_i = pts_s[i][3]
        num = 0.0
        den = 0.0
        for j in range(n):
            ds = abs(pts_s[j][3] - s_i)
            if ds > half:
                if pts_s[j][3] > s_i + half:
                    break
                continue
            w = 1.0 - ds / half
            num += w * pts_s[j][2]
            den += w
        out.append(num / den if den > 0 else pts_s[i][2])
    return out


def grades_along_path(
    s_m: list[float],
    ele_m: list[float],
    *,
    base_m: float = 60.0,
    max_abs_grade: float = 0.14,
) -> list[float]:
    """Centered finite-difference grade, clamped to realistic paved alpine roads.

    Grossglockner / Stelvio / Iseran: typical max ~10–14 % (Renault OEM ≤ 13.5 %).
    """
    n = len(s_m)
    grades = [0.0] * n
    if n < 2:
        return grades
    j_lo = 0
    j_hi = 0
    for i in range(n):
        while j_lo < i and s_m[i] - s_m[j_lo] > base_m:
            j_lo += 1
        while j_hi + 1 < n and s_m[j_hi + 1] - s_m[i] < base_m:
            j_hi += 1
        ds = s_m[j_hi] - s_m[j_lo]
        if ds < 5.0:
            # fallback to neighbour
            if i == 0:
                ds = max(s_m[1] - s_m[0], 1.0)
                g = (ele_m[1] - ele_m[0]) / ds
            elif i == n - 1:
                ds = max(s_m[i] - s_m[i - 1], 1.0)
                g = (ele_m[i] - ele_m[i - 1]) / ds
            else:
                ds = max(s_m[i + 1] - s_m[i - 1], 1.0)
                g = (ele_m[i + 1] - ele_m[i - 1]) / ds
        else:
            g = (ele_m[j_hi] - ele_m[j_lo]) / ds
        grades[i] = max(-max_abs_grade, min(max_abs_grade, g))

    # light 3-point smooth then re-clamp
    sm = grades[:]
    for i in range(1, n - 1):
        sm[i] = 0.25 * grades[i - 1] + 0.5 * grades[i] + 0.25 * grades[i + 1]
        sm[i] = max(-max_abs_grade, min(max_abs_grade, sm[i]))
    return sm


def synthesize_rows(
    pts_s: list[tuple[float, float, float, float]],
    *,
    max_abs_grade: float = 0.14,
) -> list[dict[str, float]]:
    """Build automotive descent series from geometry + physically plausible grades.

    GNSS elevations on bike traces are stepped / noisy (fake 70–800 % grades).
    We:
      1. keep the endpoint altitudes (true net drop),
      2. estimate shape from distance-smoothed elevation,
      3. clamp instantaneous grade to ±max_abs_grade (paved alpine ≈ 14 %),
      4. affine-fit elevation so start/end match the GPX endpoints.
    """
    n = len(pts_s)
    if n < 3:
        return []

    s_m = [p[3] for p in pts_s]
    ele_raw = [p[2] for p in pts_s]
    ele_s = smooth_elevation(pts_s, window_m=120.0)

    # Shape grades from smoothed series, then shift so mean matches net drop
    grades = grades_along_path(
        s_m, ele_s, base_m=80.0, max_abs_grade=max_abs_grade
    )
    s_tot = max(s_m[-1] - s_m[0], 1.0)
    target_drop = ele_raw[0] - ele_raw[-1]
    g_target = max(-max_abs_grade, min(max_abs_grade, -target_drop / s_tot))
    g_mean = sum(grades) / n
    # Shift toward target mean grade (preserves local variations, then clamp)
    shift = g_target - g_mean
    grades = [
        max(-max_abs_grade, min(max_abs_grade, g + shift)) for g in grades
    ]

    # Integrate + affine map onto GPX endpoints (exact net drop)
    ele_int = [0.0]
    for i in range(1, n):
        ds = max(s_m[i] - s_m[i - 1], 0.0)
        ele_int.append(ele_int[-1] + grades[i] * ds)
    span = ele_int[-1] - ele_int[0]
    if abs(span) < 1e-6:
        ele_final = [
            ele_raw[0] + (ele_raw[-1] - ele_raw[0]) * (s_m[i] - s_m[0]) / s_tot
            for i in range(n)
        ]
    else:
        ele_final = [
            ele_raw[0]
            + (ele_int[i] - ele_int[0]) * (ele_raw[-1] - ele_raw[0]) / span
            for i in range(n)
        ]

    # Final grades from reconstructed elevation (still clamp)
    grades = grades_along_path(
        s_m, ele_final, base_m=80.0, max_abs_grade=max_abs_grade
    )
    # Re-integrate once more so ele and grade stay consistent after clamp
    ele_final = [ele_raw[0]]
    for i in range(1, n):
        ds = max(s_m[i] - s_m[i - 1], 0.0)
        ele_final.append(ele_final[-1] + grades[i] * ds)
    # Soft end correction (spread residual drop error)
    err = ele_raw[-1] - ele_final[-1]
    if abs(err) > 0.5 and s_tot > 0:
        for i in range(1, n):
            ele_final[i] += err * (s_m[i] - s_m[0]) / s_tot
        grades = grades_along_path(
            s_m, ele_final, base_m=80.0, max_abs_grade=max_abs_grade
        )

    turns: list[float] = [0.0] * n
    bearings: list[float] = [0.0] * n
    for i in range(1, n):
        bearings[i] = bearing_deg(
            pts_s[i - 1][0], pts_s[i - 1][1], pts_s[i][0], pts_s[i][1]
        )
    bearings[0] = bearings[1]
    for i in range(1, n):
        turns[i] = heading_delta(bearings[i], bearings[i - 1])
    turn80 = [0.0] * n
    for i in range(n):
        s0 = pts_s[i][3] - 40.0
        s1 = pts_s[i][3] + 40.0
        tot = 0.0
        for j in range(max(1, i - 20), min(n, i + 21)):
            if s0 <= pts_s[j][3] <= s1:
                tot += turns[j]
        turn80[i] = tot

    speeds: list[float] = []
    for i in range(n):
        g = grades[i]
        v = 20.0 - 90.0 * g
        if turn80[i] > 60:
            v *= 0.45
        elif turn80[i] > 30:
            v *= 0.65
        elif turn80[i] > 15:
            v *= 0.82
        v = max(6.0, min(27.0, v))
        speeds.append(v)

    sm = speeds[:]
    for i in range(1, n - 1):
        sm[i] = 0.25 * speeds[i - 1] + 0.5 * speeds[i] + 0.25 * speeds[i + 1]

    # Lateral accel from GPS polyline: a_lat = ± v² / R
    a_lat = [0.0] * n
    if n >= 3:
        lat0, lon0 = pts_s[0][0], pts_s[0][1]
        lat0r = math.radians(lat0)
        xy: list[tuple[float, float]] = []
        for lat, lon, _e, _s in pts_s:
            xy.append(
                (
                    (math.radians(lon) - math.radians(lon0))
                    * math.cos(lat0r)
                    * 6_371_000.0,
                    (math.radians(lat) - lat0r) * 6_371_000.0,
                )
            )
        min_r, max_r = 25.0, 50_000.0
        for i in range(1, n - 1):
            x0, y0 = xy[i - 1]
            x1, y1 = xy[i]
            x2, y2 = xy[i + 1]
            a = math.hypot(x1 - x0, y1 - y0)
            b = math.hypot(x2 - x1, y2 - y1)
            c = math.hypot(x2 - x0, y2 - y0)
            area2 = abs(x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1))
            if a < 1e-3 or b < 1e-3 or c < 1e-3 or area2 < 1e-6:
                r = max_r
            else:
                r = min(max_r, max(min_r, (a * b * c) / (2.0 * area2)))
            cross = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1)
            sign = 1.0 if cross >= 0 else -1.0
            a_lat[i] = sign * (sm[i] * sm[i]) / r
        a_lat[0] = a_lat[1]
        a_lat[-1] = a_lat[-2]
        for i in range(1, n - 1):
            a_lat[i] = 0.25 * a_lat[i - 1] + 0.5 * a_lat[i] + 0.25 * a_lat[i + 1]
        # Clamp to automotive lateral envelope (OEM test ~6 m/s²).
        max_alat = 6.5
        a_lat = [max(-max_alat, min(max_alat, x)) for x in a_lat]

    rows: list[dict[str, float]] = []
    t = 0.0
    for i in range(n):
        if i == 0:
            a = 0.0
        else:
            ds = max(pts_s[i][3] - pts_s[i - 1][3], 0.1)
            dt = ds / max(0.5 * (sm[i] + sm[i - 1]), 0.5)
            t += dt
            a = (sm[i] - sm[i - 1]) / max(dt, 1e-3)
        rows.append(
            {
                "time_s": round(t, 3),
                "velocity_mps": round(sm[i], 4),
                "acceleration_mps2": round(a, 4),
                "a_lat_mps2": round(a_lat[i], 4),
                "slope_pct": round(grades[i] * 100.0, 3),
                "position_m": round(pts_s[i][3], 2),
                "lat": round(pts_s[i][0], 6),
                "lon": round(pts_s[i][1], 6),
                "ele_m": round(ele_final[i], 1),
            }
        )
    return rows


def stats_from_rows(rows: list[dict[str, float]]) -> dict:
    vs = [r["velocity_mps"] for r in rows]
    acc = [r["acceleration_mps2"] for r in rows]
    alat = [abs(r.get("a_lat_mps2", 0.0)) for r in rows]
    pos_a = [a for a in acc if a > 0.05]
    neg_a = [a for a in acc if a < -0.05]
    return {
        "n_points": len(rows),
        "duration_s": round(rows[-1]["time_s"] - rows[0]["time_s"], 1),
        "distance_m": round(rows[-1]["position_m"] - rows[0]["position_m"], 1),
        "ele_start_m": rows[0]["ele_m"],
        "ele_end_m": rows[-1]["ele_m"],
        "ele_drop_m": round(rows[0]["ele_m"] - rows[-1]["ele_m"], 1),
        "v_mean_kmh": round(sum(vs) / len(vs) * 3.6, 2),
        "v_max_kmh": round(max(vs) * 3.6, 2),
        "v_min_kmh": round(min(vs) * 3.6, 2),
        "a_max_mps2": round(max(acc), 3),
        "a_min_mps2": round(min(acc), 3),
        "a_mean_accel_mps2": round(sum(pos_a) / len(pos_a), 3) if pos_a else None,
        "a_mean_decel_mps2": round(sum(neg_a) / len(neg_a), 3) if neg_a else None,
        "a_lat_max_mps2": round(max(alat), 3) if alat else None,
        "slope_mean_pct": round(sum(r["slope_pct"] for r in rows) / len(rows), 2),
        "slope_min_pct": round(min(r["slope_pct"] for r in rows), 2),
        "slope_max_pct": round(max(r["slope_pct"] for r in rows), 2),
    }


def write_csv(path: Path, rows: list[dict[str, float]]) -> str:
    fields = [
        "time_s",
        "velocity_mps",
        "acceleration_mps2",
        "a_lat_mps2",
        "slope_pct",
        "position_m",
        "lat",
        "lon",
        "ele_m",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ensure_gpx(offline: bool) -> dict[str, Path]:
    CACHE.mkdir(parents=True, exist_ok=True)
    paths = {
        "grossglockner": CACHE / "grossglockner.gpx",
        "iseran": CACHE / "iseran.gpx",
        "stelvio": CACHE / "stelvio.gpx",
    }
    if offline and all(p.exists() for p in paths.values()):
        return paths

    print("Downloading Grossglockner (Bikemap)…")
    paths["grossglockner"].write_bytes(
        fetch("https://www.bikemap.net/download/r/3666733/gpx/")
    )

    print("Downloading Iseran (VisuGPX)…")
    paths["iseran"].write_bytes(
        fetch("https://www.visugpx.com/dl/XBQ5qiLV9r-col-de-l-iseran.gpx")
    )

    print("Downloading Stelvio (PJAMM climb page)…")
    html = fetch(
        "https://pjammcycling.com/climb/26.Passo%20dello%20Stelvio%20Prato"
    ).decode("utf-8", errors="replace")
    scripts = re.findall(r"<script[^>]*>([\s\S]*?)</script>", html)
    big = max(scripts, key=len)
    climb = json.loads(big)["climbPageData-26"]
    paths["stelvio"].write_text(climb["gpxFile"]["fileData"], encoding="utf-8")
    return paths


PROFILES = [
    {
        "key": "grossglockner",
        "id": "grossglockner_descent",
        "filename": "grossglockner_descent.csv",
        "name": "Grossglockner High Alpine Descent (Stress Freins)",
        "license": "Open Data / Bikemap route reuse (engineering)",
        "url": "https://www.bikemap.net/fr/r/3666733/",
        "citation": (
            "Bikemap route « Grossglockner High Alpine Road » #3666733. "
            "Final north valley descent only (~14 km, col/plateau → Ferleiten) "
            "for OEM brake-stress comparison with Renault Route Planner."
        ),
        "source": "Bikemap #3666733 — Grossglockner High Alpine Road",
        "notes_extra": (
            "Spurs / out-and-back trimmed; segment chosen for length≈14 km "
            "and max elevation drop into the valley (Renault-comparable)."
        ),
    },
    {
        "key": "iseran",
        "id": "iseran_descent",
        "filename": "iseran_descent.csv",
        "name": "Col de l'Iseran Descent (Dénivelé Brut Max)",
        "license": "Open Data / VisuGPX (engineering reuse)",
        "url": "https://www.visugpx.com/XBQ5qiLV9r",
        "citation": (
            "VisuGPX trace « Col de l'iseran » (id XBQ5qiLV9r). "
            "Descent extracted from summit to valley."
        ),
        "source": "VisuGPX XBQ5qiLV9r — Col de l'Iseran",
    },
    {
        "key": "stelvio",
        "id": "stelvio_north_descent",
        "filename": "stelvio_north_descent.csv",
        "name": "Stelvio Pass Northern Descent (48 Lacets)",
        "license": "Open Data / PJAMM Cycling (engineering reuse)",
        "url": "https://pjammcycling.com/climb/26.Passo%20dello%20Stelvio%20Prato",
        "citation": (
            "PJAMM Cycling climb #26 Passo dello Stelvio from Prato Allo Stelvio. "
            "Ascent GPX reversed to synthesize northern descent (48 hairpins)."
        ),
        "source": "PJAMM climb #26 — Stelvio (Prato) reversed descent",
    },
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    gpx_paths = ensure_gpx(args.offline)
    BENCH.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    sources = [
        s
        for s in manifest.get("sources", [])
        if s.get("id") not in {p["id"] for p in PROFILES}
    ]

    for spec in PROFILES:
        raw = parse_gpx(gpx_paths[spec["key"]])
        desc = extract_descent(raw, spec["key"])
        pts_s = resample_by_distance(desc, step_m=12.0)
        rows = synthesize_rows(pts_s)
        if len(rows) < 50:
            raise SystemExit(f"Too few points for {spec['id']}: {len(rows)}")
        out = BENCH / spec["filename"]
        digest = write_csv(out, rows)
        st = stats_from_rows(rows)
        notes = (
            "Velocity synthesized from grade + hairpin turn density for "
            "automotive brake-stress comparison (not raw bicycle GNSS speed). "
            "Elevation smoothed; slope from ~80 m baseline, clamped to ±14 % "
            "(realistic paved alpine max; raw GNSS grades are unusable)."
        )
        if spec.get("notes_extra"):
            notes = f"{notes} {spec['notes_extra']}"
        entry = {
            "id": spec["id"],
            "name": spec["name"],
            "license": spec["license"],
            "citation": spec["citation"],
            "has_geo": True,
            "url": spec["url"],
            "sha256": digest,
            "filename": spec["filename"],
            "velocity_unit": "m/s",
            "family": "alpine",
            "source_dataset": "alpine-descent-stress",
            "source": spec["source"],
            "added_at": today,
            "tier": "open_trace_descent",
            "notes": notes,
            "stats": st,
            "n_points": st["n_points"],
            "duration_s_approx": st["duration_s"],
            "mean_speed_kmh": st["v_mean_kmh"],
        }
        sources.append(entry)
        print(
            f"OK {spec['id']}: {st['distance_m']/1000:.1f} km, "
            f"drop {st['ele_drop_m']:.0f} m, {st['n_points']} pts, "
            f"v̄ {st['v_mean_kmh']:.0f} km/h"
        )

    manifest["sources"] = sources
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Updated", MANIFEST, "total sources", len(sources))


if __name__ == "__main__":
    main()
