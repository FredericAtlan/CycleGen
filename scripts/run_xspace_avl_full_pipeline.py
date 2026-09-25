#!/usr/bin/env python3
"""Full XSPACE pipeline: batch IDM compare + seed cycles + HTML report + UI polish.

Usage:
  cd backend && .venv/bin/python ../scripts/run_xspace_avl_full_pipeline.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
_BACKEND = _ROOT / "backend"
sys.path.insert(0, str(_BACKEND))
sys.path.insert(0, str(_HERE))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    t0 = time.time()
    print("=== 1/4 HTML report + series (IDM batch) ===", flush=True)
    report = _load("report_xspace_avl_html", _HERE / "report_xspace_avl_html.py")
    rc = report.main()
    if rc != 0:
        return rc

    print("\n=== 2/4 Seed 6 library cycles ===", flush=True)
    seed = _load("seed_xspace_avl_cycles", _HERE / "seed_xspace_avl_cycles.py")
    rc = seed.main()
    if rc != 0:
        print("WARN seed returned", rc, flush=True)

    latest = (
        _BACKEND
        / "app/data/benchmark/calibration/xspace_avl_report_latest.html"
    )
    print("\n=== 3/4 (skip raw twopage — shell already 2-page) ===", flush=True)

    print("\n=== 4/4 Inject payload into UI shell + reco ===", flush=True)
    polish = _load("xspace_polish", _HERE / "polish_xspace_avl_report.py")
    polish.polish_all()

    # Print matched-style scoreboard from latest JSON
    slim = _BACKEND / "app/data/benchmark/calibration/xspace_avl_batch_latest.json"
    if slim.exists():
        data = json.loads(slim.read_text(encoding="utf-8"))
        print("\n=== Scoreboard (best CG arm vs each AVL Route Studio trace) ===", flush=True)
        for tr in data.get("traces", []):
            avl = tr["avl"]
            best = tr.get("best") or {}
            style = avl.get("style")
            matched = None
            for arm in tr.get("arms") or []:
                if arm.get("preset") == ("Dynamique" if style == "dynamique" else "Prudent"):
                    matched = arm
                    break
            print(
                f"  {avl.get('route_hint')} · RS {style}: "
                f"best={best.get('preset')} RMSE={best.get('rmse_v_kmh')} "
                f"ΔT={best.get('delta_duration_pct')}% | "
                f"matched={matched.get('preset') if matched else '—'} "
                f"RMSE={matched.get('rmse_v_kmh') if matched else '—'} "
                f"ΔT={matched.get('delta_duration_pct') if matched else '—'}%",
                flush=True,
            )

    print(f"\nDone in {(time.time()-t0)/60:.1f} min", flush=True)
    print(f"Report: {_ROOT / 'docs/reports/xspace_avl_calibration_report.html'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
