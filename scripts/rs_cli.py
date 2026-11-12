#!/usr/bin/env python3
"""Thin CLI wrappers over rs_* services (P5).

Usage (from repo root, backend venv):

  cd backend && .venv/bin/python ../scripts/rs_cli.py fingerprint path.xls
  .venv/bin/python ../scripts/rs_cli.py pack-summary
  .venv/bin/python ../scripts/rs_cli.py compare --t-ref a.json --t-cg b.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_BACKEND = _REPO / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


def cmd_fingerprint(args: argparse.Namespace) -> int:
    from app.services.rs_fingerprint import fingerprint_payload

    path = Path(args.path).expanduser().resolve()
    raw = path.read_bytes()
    out = fingerprint_payload(raw=raw, filename=path.name, use_p85=True)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


def cmd_pack_summary(_: argparse.Namespace) -> int:
    candidates = [
        _BACKEND
        / "app/data/benchmark/calibration/route_studio_here/route_studio_fit_pack.json",
        _REPO / "frontend/public/data/route_studio_fit_pack.json",
    ]
    for p in candidates:
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            summary = data.get("summary") or {}
            print(
                json.dumps(
                    {
                        "path": str(p),
                        "stamp": data.get("stamp"),
                        "summary": summary,
                        "n_cycles": len(data.get("cycles") or []),
                    },
                    indent=2,
                    ensure_ascii=False,
                )
            )
            return 0
    print("pack not found", file=sys.stderr)
    return 1


def cmd_compare(args: argparse.Namespace) -> int:
    from app.services.rs_compare import score_profiles

    def load_series(path: Path) -> tuple[list[float], list[float]]:
        obj = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(obj, dict) and "t" in obj and "v" in obj:
            return [float(x) for x in obj["t"]], [float(x) for x in obj["v"]]
        if isinstance(obj, dict) and "time" in obj and "velocity" in obj:
            return (
                [float(x) for x in obj["time"]],
                [float(x) for x in obj["velocity"]],
            )
        raise ValueError(f"need {{t,v}} or {{time,velocity}} in {path}")

    t_r, v_r = load_series(Path(args.t_ref))
    t_c, v_c = load_series(Path(args.t_cg))
    sc = score_profiles(t_ref=t_r, v_ref_mps=v_r, t_cg=t_c, v_cg_mps=v_c)
    print(json.dumps(sc, indent=2))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="CycleGen rs_* CLI wrappers")
    sub = p.add_subparsers(dest="cmd", required=True)

    fp = sub.add_parser("fingerprint", help="Fingerprint CSV/XLS/JSON file")
    fp.add_argument("path")
    fp.set_defaults(func=cmd_fingerprint)

    pk = sub.add_parser("pack-summary", help="Print Route Studio pack summary")
    pk.set_defaults(func=cmd_pack_summary)

    cp = sub.add_parser("compare", help="Score two JSON series {t,v}")
    cp.add_argument("--t-ref", required=True)
    cp.add_argument("--t-cg", required=True)
    cp.set_defaults(func=cmd_compare)

    args = p.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
