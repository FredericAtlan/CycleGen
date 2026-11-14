#!/usr/bin/env python3
"""Build / refresh pinned regulatory drive-cycle CSVs for CycleGen benchmark.

Sources:
  - US EPA 1 Hz dynamometer schedules (public text tables)
  - NEDC assembled from EPA mirrors of UN/ECE urban + EUDC
  - WLTC Class 1/2/3: engineering reconstructions matching GTR No.15
    phase durations / speed envelopes (NOT official UNECE binary tables)

Usage:
  python scripts/build_regulatory_cycles.py
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "backend" / "app" / "data" / "benchmark"
MANIFEST = OUT / "manifest.json"

EPA_BASE = "https://www.epa.gov/sites/default/files/2015-10"
EPA_FILES = {
    "udds": ("uddscol.txt", "udds.csv", "UDDS (EPA Urban Dynamometer)"),
    "ftp75": ("ftpcol.txt", "ftp75.csv", "FTP-75 (EPA Federal Test Procedure)"),
    "hwfet": ("hwycol.txt", "hwfet.csv", "HWFET (EPA Highway Fuel Economy)"),
    "us06": ("us06col.txt", "us06.csv", "US06 (EPA Supplemental FTP)"),
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_csv(path: Path, rows: list[tuple[float, float]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["time_s", "velocity_mps"])
        for t, v in rows:
            w.writerow([f"{t:.1f}", f"{v:.4f}"])


def _parse_epa_txt(text: str, *, speed_unit: str) -> list[tuple[float, float]]:
    """Parse EPA tab/space tables. speed_unit: 'mph' or 'kph'."""
    rows: list[tuple[float, float]] = []
    for line in text.splitlines():
        line = line.strip().strip('"')
        if not line:
            continue
        # Numeric data lines start with a digit (time)
        if not re.match(r"^-?\d", line):
            continue
        parts = re.split(r"[\t,;\s]+", line)
        if len(parts) < 2:
            continue
        try:
            t = float(parts[0])
            sp = float(parts[1])
        except ValueError:
            continue
        if speed_unit == "mph":
            v = sp * 0.44704
        elif speed_unit == "kph":
            v = sp / 3.6
        else:
            raise ValueError(speed_unit)
        rows.append((t, max(0.0, v)))
    rows.sort(key=lambda r: r[0])
    out: list[tuple[float, float]] = []
    for t, v in rows:
        if out and abs(t - out[-1][0]) < 1e-9:
            out[-1] = (t, v)
            continue
        if out and t < out[-1][0]:
            continue
        out.append((t, v))
    return out


def _download(url: str) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": "CycleGen/0.1 (engineering corpus builder)"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", errors="replace")


def build_epa_cycles() -> list[dict]:
    meta = []
    for cid, (fname, out_name, title) in EPA_FILES.items():
        url = f"{EPA_BASE}/{fname}"
        text = _download(url)
        rows = _parse_epa_txt(text, speed_unit="mph")
        if len(rows) < 100:
            raise RuntimeError(f"Too few points for {cid}: {len(rows)}")
        path = OUT / out_name
        _write_csv(path, rows)
        digest = _sha256(path)
        meta.append(
            {
                "id": cid,
                "name": title,
                "license": "US EPA public dynamometer schedule (engineering reuse)",
                "citation": (
                    f"US EPA Vehicle Chassis Dynamometer Driving Schedules — {fname}. "
                    f"{url}"
                ),
                "has_geo": False,
                "url": url,
                "sha256": digest,
                "filename": out_name,
                "velocity_unit": "m/s",
                "family": "regulatory",
                "source_dataset": "US-EPA",
            }
        )
        print(f"wrote {out_name} n={len(rows)} T={rows[-1][0]:.0f}s vmax={max(v for _,v in rows)*3.6:.1f} km/h")
    return meta


def build_nedc() -> dict:
    ece = _parse_epa_txt(
        _download(f"{EPA_BASE}/ececol.txt"), speed_unit="kph"
    )
    eudc = _parse_epa_txt(
        _download(f"{EPA_BASE}/eudccol.txt"), speed_unit="kph"
    )
    # Official NEDC: 4 × ECE-15 urban loops + EUDC
    combined: list[tuple[float, float]] = []
    t_off = 0.0
    for _ in range(4):
        for t, v in ece:
            combined.append((t_off + t, v))
        t_off = combined[-1][0] + 1.0
    # EUDC starts after urban block; keep continuous time
    t0_e = eudc[0][0]
    for t, v in eudc:
        combined.append((t_off + (t - t0_e), v))
    # reindex to integer seconds if needed
    path = OUT / "nedc.csv"
    _write_csv(path, combined)
    digest = _sha256(path)
    print(f"wrote nedc.csv n={len(combined)} T={combined[-1][0]:.0f}s")
    return {
        "id": "nedc",
        "name": "NEDC (4×ECE-15 + EUDC, EPA mirror)",
        "license": "UN/ECE Type I schedule via US EPA public mirror",
        "citation": (
            "Assembled from EPA ececol.txt (UN/ECE elementary urban) ×4 + eudccol.txt "
            "(Extra-Urban). https://www.epa.gov/vehicle-and-fuel-emissions-testing/dynamometer-drive-schedules"
        ),
        "has_geo": False,
        "url": "",
        "sha256": digest,
        "filename": "nedc.csv",
        "velocity_unit": "m/s",
        "family": "regulatory",
        "source_dataset": "NEDC-EPA-mirror",
    }


def _wltc_phase(
    duration_s: int,
    *,
    v_max_kmh: float,
    v_mean_kmh: float,
    stop_ratio: float,
    seed: int,
) -> list[float]:
    """Generate 1 Hz velocity samples (m/s) for one WLTC-like phase."""
    import random

    rng = random.Random(seed)
    v_max = v_max_kmh / 3.6
    v_mean = v_mean_kmh / 3.6
    out: list[float] = []
    t = 0
    v = 0.0
    while t < duration_s:
        if rng.random() < stop_ratio * 0.02 and v < 1.0:
            dwell = rng.randint(3, 18)
            for _ in range(min(dwell, duration_s - t)):
                out.append(0.0)
                t += 1
            continue
        # cruise / accel / decel segments
        target = rng.uniform(0.35 * v_mean, min(v_max, 1.35 * v_mean))
        if rng.random() < 0.15:
            target = rng.uniform(0.7 * v_max, v_max)
        seg = rng.randint(8, 45)
        a = (target - v) / max(seg, 1)
        a = max(-2.5, min(2.0, a))
        for _ in range(min(seg, duration_s - t)):
            v = max(0.0, min(v_max, v + a))
            # soft pull toward mean
            v = 0.92 * v + 0.08 * v_mean
            out.append(v)
            t += 1
    # trim / pad
    out = out[:duration_s]
    while len(out) < duration_s:
        out.append(0.0)
    # rescale to hit mean approximately
    mean = sum(out) / len(out)
    if mean > 0.1:
        scale = v_mean / mean
        out = [min(v_max, max(0.0, x * scale)) for x in out]
    out[0] = 0.0
    out[-1] = min(out[-1], 5.0 / 3.6)
    return out


def build_wltc_class(class_id: int) -> dict:
    """Engineering reconstruction of WLTC Class 1/2/3 (GTR No.15 envelopes)."""
    # Phase durations and envelope targets from UNECE GTR No.15 literature summaries
    specs = {
        1: {
            "phases": [
                (589, 49.0, 15.0, 0.25),
                (433, 64.0, 28.0, 0.12),
                (455, 80.0, 40.0, 0.05),
            ],
            "name": "WLTC Class 1 (engineering reconstruction)",
            "filename": "wltc_class1.csv",
            "id": "wltc_class1",
        },
        2: {
            "phases": [
                (589, 51.0, 17.0, 0.22),
                (433, 72.0, 35.0, 0.10),
                (455, 90.0, 52.0, 0.04),
                (323, 110.0, 70.0, 0.02),
            ],
            "name": "WLTC Class 2 (engineering reconstruction)",
            "filename": "wltc_class2.csv",
            "id": "wltc_class2",
        },
        3: {
            "phases": [
                (589, 56.5, 18.9, 0.24),
                (433, 76.6, 39.5, 0.10),
                (455, 97.4, 56.7, 0.04),
                (323, 131.3, 92.0, 0.01),
            ],
            "name": "WLTC Class 3 (engineering reconstruction)",
            "filename": "wltc_class3.csv",
            "id": "wltc_class3",
        },
    }
    spec = specs[class_id]
    vel: list[float] = []
    for i, (dur, vmax, vmean, stop_r) in enumerate(spec["phases"]):
        vel.extend(
            _wltc_phase(
                dur,
                v_max_kmh=vmax,
                v_mean_kmh=vmean,
                stop_ratio=stop_r,
                seed=1000 * class_id + i * 17,
            )
        )
    rows = [(float(t), float(v)) for t, v in enumerate(vel)]
    path = OUT / spec["filename"]
    _write_csv(path, rows)
    digest = _sha256(path)
    print(
        f"wrote {spec['filename']} n={len(rows)} T={rows[-1][0]:.0f}s "
        f"vmax={max(v for _, v in rows)*3.6:.1f} km/h"
    )
    return {
        "id": spec["id"],
        "name": spec["name"],
        "license": "CC0 — CycleGen engineering reconstruction (not UNECE official table)",
        "citation": (
            "Shape / phase durations / peak speeds inspired by UNECE GTR No.15 WLTC "
            f"Class {class_id}. Second-by-second values are a CycleGen reconstruction "
            "for offline benchmarking — not an official UNECE homologation file."
        ),
        "has_geo": False,
        "url": "",
        "sha256": digest,
        "filename": spec["filename"],
        "velocity_unit": "m/s",
        "family": "regulatory",
        "source_dataset": "WLTC-reconstruction",
    }


def _annotate_existing(sources: list[dict]) -> list[dict]:
    """Ensure family tags on existing corpus entries."""
    out = []
    for s in sources:
        sid = s.get("id", "")
        s = dict(s)
        if sid.startswith("ved_"):
            s.setdefault("family", "ved")
        elif sid.startswith("geolife_"):
            s.setdefault("family", "geolife")
        elif sid.startswith("demo_") or "proxy" in sid:
            s.setdefault("family", "demo" if sid.startswith("demo_") else "regulatory")
            if "proxy" in sid:
                s["family"] = "regulatory"
                s.setdefault("tier", "proxy_seed")
        else:
            s.setdefault("family", "regulatory")
        out.append(s)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    existing = _annotate_existing(list(manifest.get("sources", [])))

    # Drop previous full regulatory ids we are regenerating (keep proxies + gps corpora)
    keep_ids = {
        s["id"]
        for s in existing
        if s["id"]
        in {
            "wltc_class3_proxy",
            "nedc_proxy",
            "demo_gps_richebourg_houdan",
        }
        or s["id"].startswith("ved_")
        or s["id"].startswith("geolife_")
    }
    kept = [s for s in existing if s["id"] in keep_ids]

    new_regs: list[dict] = []
    new_regs.extend(build_epa_cycles())
    new_regs.append(build_nedc())
    for c in (1, 2, 3):
        new_regs.append(build_wltc_class(c))

    # Order: proxies/demo first, then regulatory full, then VED, GeoLife
    proxies = [s for s in kept if s["id"] in {"wltc_class3_proxy", "nedc_proxy", "demo_gps_richebourg_houdan"}]
    ved = [s for s in kept if s["id"].startswith("ved_")]
    geo = [s for s in kept if s["id"].startswith("geolife_")]
    # sort regulatory by id for stability
    new_regs = sorted(new_regs, key=lambda s: s["id"])

    manifest["sources"] = proxies + new_regs + ved + geo
    manifest["version"] = int(manifest.get("version", 1)) + 0  # keep 1
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("manifest sources:", len(manifest["sources"]))


if __name__ == "__main__":
    main()
