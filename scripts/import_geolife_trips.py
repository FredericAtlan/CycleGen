#!/usr/bin/env python3
"""Import curated car/taxi trips from Microsoft GeoLife into CycleGen benchmark.

Upstream dataset (same as Kaggle arashnic/microsoft-geolife-gps-trajectory-dataset):
  Microsoft Research Asia GeoLife Trajectories 1.3
  https://www.microsoft.com/en-us/research/publication/geolife-gps-trajectory-dataset-user-guide/

This script downloads via Figshare mirror (no Kaggle credentials required):
  https://doi.org/10.6084/m9.figshare.25577268

Usage:
  python scripts/import_geolife_trips.py --download --n 5
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
GEO_ROOT = BACKEND / "app" / "data" / "benchmark_sources" / "geolife"
RAW = GEO_ROOT / "raw"
EXTRACTED = GEO_ROOT / "extracted"
OUT_DIR = BACKEND / "app" / "data" / "benchmark"
MANIFEST = OUT_DIR / "manifest.json"
FIGSHARE_URL = "https://ndownloader.figshare.com/files/45571758"
EARTH_R = 6371000.0
MODES = {"car", "taxi"}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def parse_dt(s: str) -> datetime:
    s = s.strip().replace("-", "/")
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError(s)


def download() -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    dest = RAW / "Geolife_Trajectories_1.3.zip"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"Already present: {dest}")
        return dest
    print(f"Downloading {FIGSHARE_URL} (~336 MB)…")
    urlretrieve(FIGSHARE_URL, dest)
    return dest


def extract(archive: Path) -> Path:
    EXTRACTED.mkdir(parents=True, exist_ok=True)
    data = EXTRACTED / "Data"
    if data.exists() and any(data.iterdir()):
        print(f"Already extracted: {data}")
        return data
    print(f"Extracting {archive}…")
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(EXTRACTED)
    if not data.exists():
        data = next(EXTRACTED.rglob("Data"))
    return data


def load_labels(path: Path):
    rows = []
    with path.open(encoding="utf-8", errors="replace") as f:
        f.readline()
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) < 3:
                continue
            mode = parts[2].strip().lower()
            if mode not in MODES:
                continue
            try:
                t0, t1 = parse_dt(parts[0]), parse_dt(parts[1])
            except ValueError:
                continue
            dur = (t1 - t0).total_seconds()
            if 180 <= dur <= 2400:
                rows.append((t0, t1, mode, dur))
    return rows


def iter_plt_points(plt_path: Path):
    with plt_path.open(encoding="utf-8", errors="replace") as f:
        for _ in range(6):
            next(f, None)
        for line in f:
            parts = line.strip().split(",")
            if len(parts) < 7:
                continue
            try:
                lat, lon = float(parts[0]), float(parts[1])
                dt = datetime.strptime(
                    f"{parts[5]} {parts[6]}", "%Y-%m-%d %H:%M:%S"
                )
            except ValueError:
                continue
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                yield dt, lat, lon


def points_in_window(user_dir: Path, t0: datetime, t1: datetime):
    traj = user_dir / "Trajectory"
    if not traj.exists():
        return []
    pts = []
    for plt in traj.glob("*.plt"):
        try:
            stem = plt.stem
            if len(stem) >= 8:
                day = datetime.strptime(stem[:8], "%Y%m%d")
                if abs((day.date() - t0.date()).days) > 1 and abs(
                    (day.date() - t1.date()).days
                ) > 1:
                    continue
        except ValueError:
            pass
        for dt, lat, lon in iter_plt_points(plt):
            if t0 <= dt <= t1:
                pts.append((dt, lat, lon))
    pts.sort(key=lambda x: x[0])
    return pts


def to_series(pts):
    if len(pts) < 30:
        return None
    series = []
    t_ref = pts[0][0]
    for i, (dt, lat, lon) in enumerate(pts):
        t_s = (dt - t_ref).total_seconds()
        if i == 0:
            v = 0.0
        else:
            dt_prev, lat_prev, lon_prev = pts[i - 1]
            ds = haversine_m(lat_prev, lon_prev, lat, lon)
            dt_s = max((dt - dt_prev).total_seconds(), 1e-3)
            v = ds / dt_s
            if v > 50:
                v = series[-1][1] if series else 0.0
        series.append((t_s, v, lat, lon))
    t_max = int(series[-1][0])
    if t_max < 180:
        return None
    by_sec = {int(t): (v, lat, lon) for t, v, lat, lon in series}
    out = []
    last = None
    gap = 0
    for sec in range(0, min(t_max, 2400) + 1):
        if sec in by_sec:
            last = by_sec[sec]
            gap = 0
        else:
            if last is None:
                continue
            gap += 1
            if gap > 5:
                continue
        v, lat, lon = last
        out.append(
            {
                "time_s": float(sec),
                "velocity_mps": round(v, 4),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
            }
        )
    if len(out) < 180:
        return None
    vs = [r["velocity_mps"] for r in out]
    mean_v = sum(vs) / len(vs)
    moving = sum(1 for v in vs if v > 1.0) / len(vs)
    if mean_v < 4 or mean_v > 35 or moving < 0.4:
        return None
    return out, mean_v, moving


def curate(data: Path, n_trips: int) -> list[dict]:
    candidates = []
    for user_dir in sorted(data.iterdir()):
        if not user_dir.is_dir():
            continue
        labels = user_dir / "labels.txt"
        if not labels.exists():
            continue
        uid = user_dir.name
        for t0, t1, mode, _dur in load_labels(labels):
            pts = points_in_window(user_dir, t0, t1)
            res = to_series(pts)
            if not res:
                continue
            rows, mean_v, moving = res
            candidates.append(
                {
                    "uid": uid,
                    "mode": mode,
                    "t0": t0,
                    "rows": rows,
                    "mean_v": mean_v,
                    "moving": moving,
                    "score": abs(rows[-1]["time_s"] - 600) + abs(mean_v - 12),
                }
            )
    candidates.sort(key=lambda c: c["score"])
    selected = []
    seen = set()
    for c in candidates:
        if c["uid"] in seen:
            continue
        selected.append(c)
        seen.add(c["uid"])
        if len(selected) >= n_trips:
            break

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"sources": []}
    manifest["sources"] = [
        s
        for s in manifest.get("sources", [])
        if not str(s.get("id", "")).startswith("geolife_")
    ]
    new_sources = []
    for c in selected:
        stamp = c["t0"].strftime("%Y%m%d_%H%M")
        fid = f"geolife_u{c['uid']}_{c['mode']}_{stamp}"
        fname = f"{fid}.csv"
        path = OUT_DIR / fname
        with path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(
                f, fieldnames=["time_s", "velocity_mps", "lat", "lon"]
            )
            w.writeheader()
            w.writerows(c["rows"])
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        new_sources.append(
            {
                "id": fid,
                "name": f"Geolife U{c['uid']} {c['mode']} {stamp} (Beijing GPS)",
                "license": (
                    "Microsoft Research GeoLife — research use; "
                    "cite Zheng et al. (see CITATIONS.md)"
                ),
                "citation": (
                    "Zheng et al. GeoLife GPS Trajectories. Microsoft Research Asia. "
                    "WWW 2009 / UbiComp 2008 / IEEE Data Eng. Bull. 2010. "
                    "Kaggle: arashnic/microsoft-geolife-gps-trajectory-dataset; "
                    "download mirror Figshare 10.6084/m9.figshare.25577268."
                ),
                "has_geo": True,
                "url": "",
                "sha256": digest,
                "filename": fname,
                "velocity_unit": "m/s",
                "source_dataset": "Geolife",
                "geolife_user": c["uid"],
                "transport_mode": c["mode"],
                "n_points": len(c["rows"]),
                "mean_speed_kmh": round(c["mean_v"] * 3.6, 2),
            }
        )
        print(f"Wrote {fname} ({len(c['rows'])} pts)")
    manifest["sources"].extend(sorted(new_sources, key=lambda s: s["id"]))
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    return new_sources


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--download", action="store_true")
    p.add_argument("--n", type=int, default=5)
    args = p.parse_args()
    if args.download:
        archive = download()
        data = extract(archive)
    else:
        data = EXTRACTED / "Data"
        if not data.exists():
            print("Missing extracted Data/. Re-run with --download", file=sys.stderr)
            return 1
    curate(data, args.n)
    print(f"Manifest updated: {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
