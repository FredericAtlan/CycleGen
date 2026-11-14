#!/usr/bin/env python3
"""Import curated trips from the Vehicle Energy Dataset (VED) into CycleGen benchmark.

Upstream: https://github.com/gsoh/VED  (Apache-2.0)
Paper: Oh, LeBlanc, Peng — IEEE T-ITS 2020 / arXiv:1905.02081

Usage (from repo root or backend/):
  python scripts/import_ved_trips.py --download
  python scripts/import_ved_trips.py --week VED_171108_week.csv --n 5

Raw archives live under backend/app/data/benchmark_sources/ved/ (gitignored).
Curated CSVs are written to backend/app/data/benchmark/ved_*.csv and registered
in manifest.json.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
VED_ROOT = BACKEND / "app" / "data" / "benchmark_sources" / "ved"
RAW = VED_ROOT / "raw"
EXTRACTED = VED_ROOT / "extracted"
OUT_DIR = BACKEND / "app" / "data" / "benchmark"
MANIFEST = OUT_DIR / "manifest.json"
PART1_URL = (
    "https://raw.githubusercontent.com/gsoh/VED/master/Data/VED_DynamicData_Part1.7z"
)


def _find(cols: list[str], *cands: str) -> int:
    lower = {c.strip().lower(): i for i, c in enumerate(cols)}
    for c in cands:
        if c.lower() in lower:
            return lower[c.lower()]
    for i, c in enumerate(cols):
        cl = c.lower()
        for cand in cands:
            if cand.lower() in cl:
                return i
    raise KeyError(cands)


def download_part1() -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    dest = RAW / "VED_DynamicData_Part1.7z"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"Already present: {dest}")
        return dest
    print(f"Downloading {PART1_URL} …")
    urlretrieve(PART1_URL, dest)
    return dest


def extract(archive: Path) -> None:
    EXTRACTED.mkdir(parents=True, exist_ok=True)
    if any(EXTRACTED.glob("VED_*_week.csv")):
        print(f"Extracted weeks already in {EXTRACTED}")
        return
    cmd = ["7z", "x", "-y", f"-o{EXTRACTED}", str(archive)]
    print(" ".join(cmd))
    subprocess.check_call(cmd)


def curate(week_name: str, n_trips: int) -> list[dict]:
    week = EXTRACTED / week_name
    if not week.exists():
        raise FileNotFoundError(week)

    with week.open(newline="", encoding="utf-8", errors="replace") as f:
        header = next(csv.reader(f))

    idx_veh = _find(header, "VehId")
    idx_trip = _find(header, "Trip")
    idx_ts = _find(header, "Timestamp(ms)", "Timestamp")
    idx_lat = _find(header, "Latitude[deg]", "Latitude")
    idx_lon = _find(header, "Longitude[deg]", "Longitude")
    idx_spd = _find(header, "Vehicle Speed[km/h]", "Vehicle Speed")

    trips: dict[tuple[int, int], dict] = defaultdict(
        lambda: {"n": 0, "t0": None, "t1": None, "v_sum": 0.0, "moving": 0}
    )
    with week.open(newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            try:
                veh = int(float(row[idx_veh]))
                trip = int(float(row[idx_trip]))
                ts = float(row[idx_ts])
                lat = float(row[idx_lat])
                lon = float(row[idx_lon])
                spd = float(row[idx_spd])
            except (ValueError, IndexError):
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
            st = trips[(veh, trip)]
            st["n"] += 1
            st["t0"] = ts if st["t0"] is None else st["t0"]
            st["t1"] = ts
            st["v_sum"] += spd
            if spd > 1.0:
                st["moving"] += 1

    candidates = []
    for (veh, trip), st in trips.items():
        if st["n"] < 60 or st["t0"] is None or st["t1"] is None:
            continue
        dur_s = (st["t1"] - st["t0"]) / 1000.0
        if dur_s < 180 or dur_s > 2400:
            continue
        mean_v = st["v_sum"] / st["n"]
        move_ratio = st["moving"] / st["n"]
        if mean_v < 5 or mean_v > 120 or move_ratio < 0.3:
            continue
        candidates.append((dur_s, mean_v, move_ratio, st["n"], veh, trip))

    candidates.sort(key=lambda x: abs(x[0] - 600))
    selected = []
    seen_veh: set[int] = set()
    for c in candidates:
        if c[4] in seen_veh:
            continue
        selected.append(c)
        seen_veh.add(c[4])
        if len(selected) >= n_trips:
            break

    want = {(c[4], c[5]) for c in selected}
    buffers: dict[tuple[int, int], list] = {k: [] for k in want}
    with week.open(newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            try:
                key = (int(float(row[idx_veh])), int(float(row[idx_trip])))
                if key not in want:
                    continue
                buffers[key].append(
                    (
                        float(row[idx_ts]),
                        float(row[idx_lat]),
                        float(row[idx_lon]),
                        float(row[idx_spd]),
                    )
                )
            except (ValueError, IndexError):
                continue

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"sources": []}
    manifest["sources"] = [
        s for s in manifest.get("sources", []) if not str(s.get("id", "")).startswith("ved_")
    ]

    new_sources = []
    for (veh, trip), rows in buffers.items():
        rows.sort(key=lambda r: r[0])
        t0 = rows[0][0]
        by_sec = {}
        for ts, lat, lon, spd in rows:
            by_sec[int((ts - t0) / 1000.0)] = (lat, lon, spd)
        out_rows = [
            {
                "time_s": float(sec),
                "velocity_mps": round(by_sec[sec][2] / 3.6, 4),
                "lat": round(by_sec[sec][0], 6),
                "lon": round(by_sec[sec][1], 6),
            }
            for sec in sorted(by_sec)
        ]
        fname = f"ved_veh{veh}_trip{trip}.csv"
        path = OUT_DIR / fname
        with path.open("w", newline="", encoding="utf-8") as out:
            w = csv.DictWriter(out, fieldnames=["time_s", "velocity_mps", "lat", "lon"])
            w.writeheader()
            w.writerows(out_rows)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        new_sources.append(
            {
                "id": f"ved_veh{veh}_trip{trip}",
                "name": f"VED Veh{veh} Trip{trip} (Ann Arbor, real GPS)",
                "license": "Apache-2.0 — Vehicle Energy Dataset (Oh, LeBlanc, Peng)",
                "citation": (
                    "Oh, G.S., LeBlanc, D.J., Peng, H. Vehicle Energy Dataset (VED). "
                    "IEEE T-ITS 2020. https://github.com/gsoh/VED arXiv:1905.02081. "
                    f"Source week {week_name}."
                ),
                "has_geo": True,
                "url": "",
                "sha256": digest,
                "filename": fname,
                "velocity_unit": "m/s",
                "source_dataset": "VED",
                "ved_vehid": veh,
                "ved_trip": trip,
                "n_points": len(out_rows),
            }
        )
        print(f"Wrote {fname} ({len(out_rows)} pts)")

    manifest["sources"].extend(sorted(new_sources, key=lambda s: s["id"]))
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    return new_sources


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--download", action="store_true", help="Download + extract Part1")
    p.add_argument("--week", default="VED_171108_week.csv")
    p.add_argument("--n", type=int, default=5, help="Number of curated trips")
    args = p.parse_args()

    if args.download:
        archive = download_part1()
        extract(archive)

    if not any(EXTRACTED.glob("VED_*_week.csv")):
        print("No extracted weeks. Re-run with --download", file=sys.stderr)
        return 1

    curate(args.week, args.n)
    print(f"Manifest updated: {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
