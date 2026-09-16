"""
CycleGen SUMO / TraCI bridge.

Environment variables:
  SUMO_BINARY   — sumo or sumo-gui executable name/path (default: ``sumo``)
  SUMO_HOME     — SUMO install root; ``tools/`` is added to ``sys.path`` for traci/sumolib
  SUMO_WORK_DIR — default work directory for prepared simulations (default: ``/tmp/cyclegen-sumo``)
  SUMO_PORT     — default TraCI listen port (default: ``8813``)
  SUMO_TEMPLATES — optional path to ``vtypes.add.xml`` / ``cyclegen.sumocfg`` templates

Limitations (TLS / OSM):
  - Corridor ``S_feux`` are injected as traffic-light junctions in geometry-derived
    (minimal) networks. On OSM nets from ``netconvert --tls.guess``, only TLS that
    survive conversion are visible via TraCI; unmatched ``S_feux`` are best-effort
    (nearest junction) and may be absent if OSM had no signal at that location.
  - Without SUMO/netconvert, ``prepare()`` still writes a hand-crafted polyline
    ``.net.xml`` from ``corridor.geometry``. If that also fails, raise with a Docker hint.
"""

from __future__ import annotations

import importlib.util
import logging
import math
import os
import shutil
import sys
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Env defaults
# ---------------------------------------------------------------------------

DEFAULT_WORK_DIR = Path(os.environ.get("SUMO_WORK_DIR", "/tmp/cyclegen-sumo"))
DEFAULT_PORT = int(os.environ.get("SUMO_PORT", "8813"))
EGO_ID = "ego"
NEARBY_RADIUS_M = 100.0

# P1 — Grade coupling. SUMO's built-in IDM ignores z, so we inject the
# projection of gravity along the local slope as an additive accel via
# ``traci.vehicle.setAcceleration`` at each step. Matches the correction
# applied inside ``IDMSolver.step`` (Python fallback).
G_EARTH = 9.80665

PROFILE_TO_VTYPE = {
    "Eco": "Eco",
    "Normal": "Normal",
    "Agressif": "Agressif",
    "Sportif": "Sportif",
    "eco": "Eco",
    "normal": "Normal",
    "agressif": "Agressif",
    "sportif": "Sportif",
    "sport": "Sportif",
}


class SumoNotAvailableError(RuntimeError):
    """Raised when SUMO binary and/or TraCI Python bindings are missing."""


class SumoNetworkError(RuntimeError):
    """Raised when network / work-dir preparation fails."""


# ---------------------------------------------------------------------------
# Path / import helpers
# ---------------------------------------------------------------------------


def _repo_root() -> Path:
    # backend/app/services/sumo_bridge.py → CycleGen/
    return Path(__file__).resolve().parents[3]


def _templates_dir() -> Path:
    env = os.environ.get("SUMO_TEMPLATES")
    if env:
        return Path(env)
    docker = Path("/sumo/templates")
    if docker.is_dir():
        return docker
    return _repo_root() / "sumo" / "templates"


def _prepare_network_module() -> Any:
    """Load ``sumo/scripts/prepare_network.py`` without requiring a package install."""
    candidates = [
        Path("/sumo/scripts/prepare_network.py"),
        _repo_root() / "sumo" / "scripts" / "prepare_network.py",
    ]
    for path in candidates:
        if path.is_file():
            spec = importlib.util.spec_from_file_location("cyclegen_prepare_network", path)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise SumoNetworkError(
        "prepare_network.py not found (expected /sumo/scripts or <repo>/sumo/scripts)"
    )


def _ensure_sumo_tools_on_path() -> None:
    sumo_home = os.environ.get("SUMO_HOME")
    if not sumo_home:
        return
    tools = Path(sumo_home) / "tools"
    if tools.is_dir():
        tools_s = str(tools)
        if tools_s not in sys.path:
            sys.path.insert(0, tools_s)


def _try_import_traci() -> Any | None:
    _ensure_sumo_tools_on_path()
    try:
        import traci  # type: ignore[import-not-found]

        return traci
    except ImportError:
        return None


def _try_import_sumolib() -> Any | None:
    _ensure_sumo_tools_on_path()
    try:
        import sumolib  # type: ignore[import-not-found]

        return sumolib
    except ImportError:
        return None


def _find_sumo_binary() -> str | None:
    try:
        mod = _prepare_network_module()
        finder = getattr(mod, "find_sumo_binary", None)
        if callable(finder):
            return finder()
    except SumoNetworkError:
        pass
    preferred = os.environ.get("SUMO_BINARY", "sumo")
    found = shutil.which(preferred)
    if found:
        return found
    sumo_home = os.environ.get("SUMO_HOME")
    if sumo_home:
        candidate = Path(sumo_home) / "bin" / preferred
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _docker_hint() -> str:
    return (
        "Install SUMO (sumo + sumo-tools) or use Docker: "
        "`docker compose build sumo` / `docker compose run --rm sumo ...`. "
        "Set SUMO_HOME (e.g. /usr/share/sumo) and ensure SUMO_BINARY is on PATH."
    )


def _profile_to_vtype(driver_profile: Any) -> str:
    if hasattr(driver_profile, "value"):
        key = str(driver_profile.value)
    else:
        key = str(driver_profile)
    vtype = PROFILE_TO_VTYPE.get(key) or PROFILE_TO_VTYPE.get(key.strip())
    if not vtype:
        raise ValueError(
            f"Unknown driver_profile {driver_profile!r}; "
            "expected Eco|Normal|Agressif|Sportif"
        )
    return vtype


# ---------------------------------------------------------------------------
# Geometry / corridor helpers
# ---------------------------------------------------------------------------


def _corridor_points(corridor: Any) -> list[tuple[float, float]]:
    """Return [(lat, lon), ...] from SpatialCorridor.geometry."""
    geom = getattr(corridor, "geometry", None) or []
    pts: list[tuple[float, float]] = []
    for p in geom:
        if hasattr(p, "lat") and hasattr(p, "lon"):
            pts.append((float(p.lat), float(p.lon)))
        elif isinstance(p, dict):
            pts.append((float(p["lat"]), float(p["lon"])))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            # accept (lat, lon) or (lon, lat) — LatLon schema is lat, lon
            pts.append((float(p[0]), float(p[1])))
        else:
            raise TypeError(f"Unsupported geometry point: {p!r}")
    if len(pts) < 2:
        raise SumoNetworkError(
            "corridor.geometry needs at least 2 points to build a SUMO network"
        )
    return pts


def _lonlat_to_xy(
    lon: float, lat: float, lon0: float, lat0: float
) -> tuple[float, float]:
    r = 6_371_000.0
    x = math.radians(lon - lon0) * r * math.cos(math.radians(lat0))
    y = math.radians(lat - lat0) * r
    return x, y


def _xy_to_lonlat(
    x: float, y: float, lon0: float, lat0: float
) -> tuple[float, float]:
    r = 6_371_000.0
    lat = lat0 + math.degrees(y / r)
    lon = lon0 + math.degrees(x / (r * math.cos(math.radians(lat0))))
    return lon, lat


def _interp_series(s_query: float, S: list[float], values: list[float]) -> float:
    if not S or not values:
        return 0.0
    if len(S) != len(values):
        n = min(len(S), len(values))
        S, values = S[:n], values[:n]
    if s_query <= S[0]:
        return float(values[0])
    if s_query >= S[-1]:
        return float(values[-1])
    for i in range(1, len(S)):
        if s_query <= S[i]:
            t = (s_query - S[i - 1]) / max(S[i] - S[i - 1], 1e-9)
            return float(values[i - 1] + t * (values[i] - values[i - 1]))
    return float(values[-1])


def _bbox_from_geometry(
    pts: list[tuple[float, float]], pad_deg: float = 0.005
) -> tuple[float, float, float, float]:
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    return (
        min(lats) - pad_deg,
        min(lons) - pad_deg,
        max(lats) + pad_deg,
        max(lons) + pad_deg,
    )


def _cumulative_distances_xy(xy: list[tuple[float, float]]) -> list[float]:
    dist = [0.0]
    for i in range(1, len(xy)):
        dx = xy[i][0] - xy[i - 1][0]
        dy = xy[i][1] - xy[i - 1][1]
        dist.append(dist[-1] + math.hypot(dx, dy))
    return dist


# ---------------------------------------------------------------------------
# Minimal / nod-edg network writers
# ---------------------------------------------------------------------------


def _write_corridor_nod_edg(
    work_dir: Path,
    corridor: Any,
    *,
    max_edge_len_m: float = 80.0,
) -> tuple[list[str], Path, Path]:
    """Write nodes.nod.xml + edges.edg.xml from corridor; return edge ids."""
    pts = _corridor_points(corridor)
    lat0, lon0 = pts[0][0], pts[0][1]
    xy = [_lonlat_to_xy(lon, lat, lon0, lat0) for lat, lon in pts]
    cum = _cumulative_distances_xy(xy)

    S = list(getattr(corridor, "S", []) or [])
    V = list(getattr(corridor, "V_limite", []) or [])
    S_feux = list(getattr(corridor, "S_feux", []) or [])

    # Resample polyline so edges are not huge; keep endpoints + S_feux snaps
    keep_idx = {0, len(xy) - 1}
    for s_f in S_feux:
        best_i = min(range(len(cum)), key=lambda i: abs(cum[i] - s_f))
        keep_idx.add(best_i)
    # densify by max_edge_len
    for i in range(len(cum) - 1):
        seg = cum[i + 1] - cum[i]
        if seg > max_edge_len_m:
            n_split = int(math.ceil(seg / max_edge_len_m))
            for k in range(1, n_split):
                # approximate by picking nearest existing vertex along parameter
                target = cum[i] + k * seg / n_split
                best_j = min(range(len(cum)), key=lambda j: abs(cum[j] - target))
                keep_idx.add(best_j)

    indices = sorted(keep_idx)
    nodes_xy = [xy[i] for i in indices]
    nodes_s = [cum[i] for i in indices]

    # Mark TLS node indices (by nearest kept vertex to each S_feux)
    tls_node_ids: dict[int, str] = {}
    for fi, s_f in enumerate(S_feux):
        # skip endpoints for TLS (dead_end cannot be TLS usefully)
        inner = list(range(1, len(nodes_s) - 1)) or list(range(len(nodes_s)))
        best = min(inner, key=lambda i: abs(nodes_s[i] - s_f))
        tls_node_ids[best] = f"tls_{fi}"

    nod_path = work_dir / "nodes.nod.xml"
    edg_path = work_dir / "edges.edg.xml"

    nod_root = ET.Element("nodes")
    for i, (x, y) in enumerate(nodes_xy):
        attrs = {
            "id": f"n{i}",
            "x": f"{x:.3f}",
            "y": f"{y:.3f}",
        }
        if i in tls_node_ids:
            attrs["type"] = "traffic_light"
            attrs["tl"] = tls_node_ids[i]
        elif i == 0 or i == len(nodes_xy) - 1:
            attrs["type"] = "dead_end"
        else:
            attrs["type"] = "priority"
        ET.SubElement(nod_root, "node", attrs)
    ET.ElementTree(nod_root).write(nod_path, encoding="UTF-8", xml_declaration=True)

    edg_root = ET.Element("edges")
    edge_ids: list[str] = []
    for i in range(len(nodes_xy) - 1):
        eid = f"e{i}"
        edge_ids.append(eid)
        mid_s = 0.5 * (nodes_s[i] + nodes_s[i + 1])
        speed = _interp_series(mid_s, S, V) if S and V else 13.89
        if speed <= 0:
            speed = 13.89
        length = max(math.hypot(
            nodes_xy[i + 1][0] - nodes_xy[i][0],
            nodes_xy[i + 1][1] - nodes_xy[i][1],
        ), 1.0)
        ET.SubElement(
            edg_root,
            "edge",
            {
                "id": eid,
                "from": f"n{i}",
                "to": f"n{i + 1}",
                "numLanes": "1",
                "speed": f"{speed:.3f}",
                "length": f"{length:.3f}",
                "priority": "1",
            },
        )
    ET.ElementTree(edg_root).write(edg_path, encoding="UTF-8", xml_declaration=True)

    # Persist projection origin for snapshot lat/lon
    (work_dir / "projection.txt").write_text(
        f"{lat0},{lon0}\n", encoding="utf-8"
    )
    return edge_ids, nod_path, edg_path


def _run_netconvert_nod_edg(
    nod_path: Path, edg_path: Path, net_out: Path, prepare_mod: Any
) -> None:
    netconvert = prepare_mod.find_netconvert()
    if not netconvert:
        raise SumoNetworkError("netconvert not found")
    import subprocess

    cmd = [
        netconvert,
        "--node-files",
        str(nod_path),
        "--edge-files",
        str(edg_path),
        "--output-file",
        str(net_out),
        "--no-turnaround",
        "true",
        "--tls.guess",
        "true",
    ]
    logger.info("running netconvert: %s", " ".join(cmd))
    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if result.returncode != 0 or not net_out.is_file():
        err = (result.stderr or result.stdout or "").strip()
        raise SumoNetworkError(f"netconvert (nod/edg) failed: {err}")


def _write_minimal_net_xml(
    work_dir: Path,
    corridor: Any,
) -> list[str]:
    """Hand-craft a linear passenger network when netconvert is unavailable."""
    pts = _corridor_points(corridor)
    lat0, lon0 = pts[0][0], pts[0][1]
    xy = [_lonlat_to_xy(lon, lat, lon0, lat0) for lat, lon in pts]
    cum = _cumulative_distances_xy(xy)

    S = list(getattr(corridor, "S", []) or [])
    V = list(getattr(corridor, "V_limite", []) or [])
    S_feux = list(getattr(corridor, "S_feux", []) or [])

    # Use corridor vertices; snap TLS to nearest non-endpoint
    tls_at: set[int] = set()
    for s_f in S_feux:
        inner = list(range(1, len(cum) - 1))
        if not inner:
            break
        best = min(inner, key=lambda i: abs(cum[i] - s_f))
        tls_at.add(best)

    xs = [p[0] for p in xy]
    ys = [p[1] for p in xy]
    conv = f"{min(xs):.2f},{min(ys):.2f},{max(xs):.2f},{max(ys):.2f}"

    lines: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<net version="1.16" junctionCornerDetail="0" limitTurnSpeed="5.50">',
        f'    <location netOffset="0.00,0.00" convBoundary="{conv}" '
        f'origBoundary="{conv}" projParameter="!"/>',
    ]

    edge_ids: list[str] = []
    for i in range(len(xy) - 1):
        eid = f"e{i}"
        edge_ids.append(eid)
        x0, y0 = xy[i]
        x1, y1 = xy[i + 1]
        length = max(math.hypot(x1 - x0, y1 - y0), 1.0)
        mid_s = 0.5 * (cum[i] + cum[i + 1])
        speed = _interp_series(mid_s, S, V) if S and V else 13.89
        if speed <= 0:
            speed = 13.89
        lines.append(
            f'    <edge id="{eid}" from="n{i}" to="n{i + 1}" priority="1">'
        )
        lines.append(
            f'        <lane id="{eid}_0" index="0" speed="{speed:.3f}" '
            f'length="{length:.3f}" shape="{x0:.3f},{y0:.3f} {x1:.3f},{y1:.3f}"/>'
        )
        lines.append("    </edge>")

    # Internal lanes for TLS / priority junctions (single straight connection)
    for i in range(1, len(xy) - 1):
        x, y = xy[i]
        via = f":n{i}_0"
        lines.append(
            f'    <edge id="{via}" function="internal">'
        )
        lines.append(
            f'        <lane id="{via}_0" index="0" speed="13.89" '
            f'length="0.10" shape="{x:.3f},{y:.3f} {x:.3f},{y:.3f}"/>'
        )
        lines.append("    </edge>")

    for i, (x, y) in enumerate(xy):
        if i == 0:
            lines.append(
                f'    <junction id="n{i}" type="dead_end" x="{x:.3f}" y="{y:.3f}" '
                f'incLanes="" intLanes="" shape="{x:.3f},{y:.3f}"/>'
            )
        elif i == len(xy) - 1:
            inc = f"e{i - 1}_0"
            lines.append(
                f'    <junction id="n{i}" type="dead_end" x="{x:.3f}" y="{y:.3f}" '
                f'incLanes="{inc}" intLanes="" shape="{x:.3f},{y:.3f}"/>'
            )
        else:
            jtype = "traffic_light" if i in tls_at else "priority"
            inc = f"e{i - 1}_0"
            via_lane = f":n{i}_0_0"
            tl_attr = f' tl="tls_{i}"' if i in tls_at else ""
            lines.append(
                f'    <junction id="n{i}" type="{jtype}" x="{x:.3f}" y="{y:.3f}" '
                f'incLanes="{inc}" intLanes="{via_lane}" shape="{x:.3f},{y:.3f}"{tl_attr}>'
            )
            lines.append(
                '        <request index="0" response="0" foes="0" cont="0"/>'
            )
            lines.append("    </junction>")

    for i in tls_at:
        lines.append(
            f'    <tlLogic id="tls_{i}" type="static" programID="0" offset="0">'
        )
        lines.append('        <phase duration="32" state="G"/>')
        lines.append('        <phase duration="3" state="y"/>')
        lines.append('        <phase duration="25" state="r"/>')
        lines.append("    </tlLogic>")

    for i in range(len(xy) - 1):
        if i < len(xy) - 2:
            via = f":n{i + 1}_0_0"
            tl = f' tl="tls_{i + 1}" linkIndex="0"' if (i + 1) in tls_at else ""
            lines.append(
                f'    <connection from="e{i}" to="e{i + 1}" fromLane="0" '
                f'toLane="0" via=":n{i + 1}_0" dir="s" state="M"{tl}/>'
            )
            lines.append(
                f'    <connection from=":n{i + 1}_0" to="e{i + 1}" fromLane="0" '
                f'toLane="0" dir="s" state="M"/>'
            )

    lines.append("</net>")
    net_out = work_dir / "network.net.xml"
    net_out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (work_dir / "projection.txt").write_text(f"{lat0},{lon0}\n", encoding="utf-8")
    logger.info(
        "wrote minimal network %s (%d edges, %d tls)",
        net_out,
        len(edge_ids),
        len(tls_at),
    )
    return edge_ids


def _write_sumocfg(work_dir: Path, port: int) -> Path:
    templates = _templates_dir()
    src = templates / "cyclegen.sumocfg"
    dst = work_dir / "cyclegen.sumocfg"
    if src.is_file():
        text = src.read_text(encoding="utf-8")
        # rewrite remote-port if present
        if "<remote-port" in text:
            import re

            text = re.sub(
                r'<remote-port\s+value="\d+"/>',
                f'<remote-port value="{port}"/>',
                text,
            )
        dst.write_text(text, encoding="utf-8")
    else:
        dst.write_text(
            f"""<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <input>
        <net-file value="network.net.xml"/>
        <route-files value="routes.rou.xml"/>
        <additional-files value="vtypes.add.xml"/>
    </input>
    <time>
        <begin value="0"/>
        <end value="7200"/>
        <step-length value="1"/>
    </time>
    <processing>
        <time-to-teleport value="-1"/>
    </processing>
    <traci_server>
        <remote-port value="{port}"/>
    </traci_server>
</configuration>
""",
            encoding="utf-8",
        )
    return dst


def _copy_vtypes(work_dir: Path) -> None:
    templates = _templates_dir()
    src = templates / "vtypes.add.xml"
    dst = work_dir / "vtypes.add.xml"
    if src.is_file():
        shutil.copy2(src, dst)
    else:
        # Minimal fallback mirroring templates (P5 — IDM aligned with PROFILE_PARAMS)
        dst.write_text(
            """<?xml version="1.0" encoding="UTF-8"?>
<additional>
    <vType id="Eco" vClass="passenger" carFollowModel="IDM" accel="1.2" decel="1.2"
           emergencyDecel="4.5" sigma="0.15" tau="2.0" length="4.5" minGap="3.0"
           maxSpeed="50" speedFactor="0.95" speedDev="0.05" impatience="0.0"/>
    <vType id="Normal" vClass="passenger" carFollowModel="IDM" accel="2.0" decel="2.0"
           emergencyDecel="7.0" sigma="0.3" tau="1.5" length="4.5" minGap="2.0"
           maxSpeed="55" speedFactor="1.05" speedDev="0.08" impatience="0.3"/>
    <vType id="Agressif" vClass="passenger" carFollowModel="IDM" accel="3.2" decel="3.2"
           emergencyDecel="8.5" sigma="0.5" tau="1.1" length="4.5" minGap="1.6"
           maxSpeed="60" speedFactor="1.12" speedDev="0.10" impatience="0.7"/>
    <vType id="Sportif" vClass="passenger" carFollowModel="IDM" accel="3.5" decel="3.5"
           emergencyDecel="9.5" sigma="0.55" tau="1.0" length="4.5" minGap="1.5"
           maxSpeed="65" speedFactor="1.10" speedDev="0.12" impatience="0.8"/>
</additional>
""",
            encoding="utf-8",
        )


# ---------------------------------------------------------------------------
# SumoBridge
# ---------------------------------------------------------------------------


class SumoBridge:
    """Prepare a corridor work dir and drive SUMO via TraCI.

    Typical Agent G flow (live WS)::

        bridge = SumoBridge()
        if not SumoBridge.available():
            # fall back to IDM
            ...
        bridge.prepare(corridor, driver_profile, work_dir)
        bridge.start_traci(port)
        while ...:
            bridge.step()
            frame = bridge.snapshot()
            # push frame over WebSocket
        bridge.stop()

    Offline (no WS yet)::

        bridge.prepare(...)
        for frame in bridge.run_offline(max_steps=3600):
            ...
    """

    def __init__(self) -> None:
        self._traci: Any | None = None
        self._label: str = "cyclegen"
        self._work_dir: Path | None = None
        self._cfg: Path | None = None
        self._corridor: Any | None = None
        self._vtype: str = "Normal"
        self._edge_ids: list[str] = []
        self._lat0: float = 0.0
        self._lon0: float = 0.0
        self._prev_speed: float | None = None
        self._step_length: float = 1.0
        self._started: bool = False
        self._ego_arrived: bool = False

    # -- availability --------------------------------------------------------

    @staticmethod
    def available() -> bool:
        """True if TraCI bindings and a SUMO binary can be resolved."""
        if _try_import_traci() is None:
            return False
        return _find_sumo_binary() is not None

    def _require_available(self) -> Any:
        traci = _try_import_traci()
        if traci is None or _find_sumo_binary() is None:
            raise SumoNotAvailableError(
                "SUMO/TraCI not available. " + _docker_hint()
            )
        return traci

    # -- prepare -------------------------------------------------------------

    def prepare(
        self,
        corridor: Any,
        driver_profile: Any = "Normal",
        work_dir: str | Path | None = None,
        *,
        port: int | None = None,
        use_osm: bool = False,
    ) -> Path:
        """Write a SUMO work directory for ``corridor`` and map the driver profile.

        Network strategy:
          1. Build nod/edg from ``corridor.geometry`` (+ TLS near ``S_feux``).
          2. Prefer ``netconvert`` when available.
          3. Else write a hand-crafted minimal ``network.net.xml``.
          4. Optional ``use_osm=True`` tries Overpass + netconvert via prepare_network
             (falls back to geometry net on failure).

        Returns the work directory path.
        """
        self._vtype = _profile_to_vtype(driver_profile)
        self._corridor = corridor
        work = Path(work_dir or DEFAULT_WORK_DIR)
        work.mkdir(parents=True, exist_ok=True)
        self._work_dir = work
        port = DEFAULT_PORT if port is None else int(port)

        prepare_mod = _prepare_network_module()
        _copy_vtypes(work)
        _write_sumocfg(work, port)

        edge_ids: list[str] | None = None
        errors: list[str] = []

        if use_osm:
            try:
                edge_ids = self._prepare_via_osm(corridor, work, prepare_mod)
            except Exception as exc:  # noqa: BLE001 — fall back to geometry
                errors.append(f"OSM path: {exc}")
                logger.warning("OSM network prepare failed, falling back: %s", exc)

        if edge_ids is None:
            try:
                edge_ids = self._prepare_via_geometry(corridor, work, prepare_mod)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"geometry path: {exc}")
                edge_ids = None

        if not edge_ids:
            detail = "; ".join(errors) if errors else "unknown error"
            raise SumoNetworkError(
                f"Network generation failed ({detail}). " + _docker_hint()
            )

        self._edge_ids = edge_ids
        prepare_mod.write_routes(work, edges=edge_ids, vtype=self._vtype)
        self._cfg = work / "cyclegen.sumocfg"
        self._load_projection(work)
        self._prev_speed = None
        self._ego_arrived = False
        logger.info(
            "SumoBridge prepared work_dir=%s vtype=%s edges=%d",
            work,
            self._vtype,
            len(edge_ids),
        )
        return work

    def _load_projection(self, work: Path) -> None:
        proj = work / "projection.txt"
        if proj.is_file():
            lat_s, lon_s = proj.read_text(encoding="utf-8").strip().split(",", 1)
            self._lat0 = float(lat_s)
            self._lon0 = float(lon_s)
        else:
            pts = _corridor_points(self._corridor) if self._corridor else [(0.0, 0.0)]
            self._lat0, self._lon0 = pts[0][0], pts[0][1]

    def _prepare_via_geometry(
        self, corridor: Any, work: Path, prepare_mod: Any
    ) -> list[str]:
        edge_ids, nod_path, edg_path = _write_corridor_nod_edg(work, corridor)
        net_out = work / "network.net.xml"
        if prepare_mod.find_netconvert():
            try:
                _run_netconvert_nod_edg(nod_path, edg_path, net_out, prepare_mod)
                return edge_ids
            except SumoNetworkError as exc:
                logger.warning("netconvert nod/edg failed (%s); minimal net", exc)
        return _write_minimal_net_xml(work, corridor)

    def _prepare_via_osm(
        self, corridor: Any, work: Path, prepare_mod: Any
    ) -> list[str]:
        pts = _corridor_points(corridor)
        bbox = _bbox_from_geometry(pts)
        prepare_mod.prepare_network(
            bbox=bbox,
            work_dir=work,
            templates_dir=_templates_dir(),
        )
        net_path = work / "network.net.xml"
        if not net_path.is_file():
            raise SumoNetworkError("OSM prepare_network did not produce network.net.xml")
        edges = self._match_edges_to_corridor(net_path, pts)
        if not edges:
            raise SumoNetworkError(
                "Could not map corridor.geometry onto OSM network edges "
                "(sumolib missing or no nearby edges)"
            )
        # Best-effort: note TLS limitation for OSM nets
        logger.info(
            "OSM net ready; S_feux TLS only if present after netconvert --tls.guess"
        )
        self._load_projection_from_pts(pts)
        return edges

    def _load_projection_from_pts(self, pts: list[tuple[float, float]]) -> None:
        self._lat0, self._lon0 = pts[0][0], pts[0][1]
        if self._work_dir:
            (self._work_dir / "projection.txt").write_text(
                f"{self._lat0},{self._lon0}\n", encoding="utf-8"
            )

    def _match_edges_to_corridor(
        self, net_path: Path, pts: list[tuple[float, float]]
    ) -> list[str]:
        sumolib = _try_import_sumolib()
        if sumolib is None:
            return []
        net = sumolib.net.readNet(str(net_path))
        edges: list[str] = []
        last: str | None = None
        for lat, lon in pts:
            x, y = net.convertLonLat2XY(lon, lat)
            nearby = net.getNeighboringEdges(x, y, r=50)
            if not nearby:
                nearby = net.getNeighboringEdges(x, y, r=120)
            if not nearby:
                continue
            edge = min(nearby, key=lambda t: t[1])[0]
            eid = edge.getID()
            if eid != last:
                edges.append(eid)
                last = eid
        return edges

    # -- TraCI lifecycle -----------------------------------------------------

    def start_traci(self, port: int | None = None) -> None:
        """Launch ``sumo`` and connect TraCI (uses prepared ``cyclegen.sumocfg``)."""
        traci = self._require_available()
        if self._cfg is None or self._work_dir is None:
            raise SumoNetworkError("call prepare() before start_traci()")
        if self._started:
            self.stop()

        port = DEFAULT_PORT if port is None else int(port)
        binary = _find_sumo_binary()
        assert binary is not None

        sumo_cmd = [
            binary,
            "-c",
            str(self._cfg),
            "--remote-port",
            str(port),
            "--start",
            "--quit-on-end",
            "true",
            "--no-step-log",
            "true",
            "--duration-log.disable",
            "true",
        ]
        # Ensure relative net/route paths resolve
        cwd = os.getcwd()
        try:
            os.chdir(self._work_dir)
            traci.start(sumo_cmd, port=port, label=self._label)
        finally:
            os.chdir(cwd)

        self._traci = traci
        self._started = True
        self._prev_speed = None
        self._ego_arrived = False
        try:
            self._step_length = float(traci.simulation.getDeltaT())
            if self._step_length > 10:
                # older SUMO returns ms
                self._step_length = self._step_length / 1000.0
        except Exception:  # noqa: BLE001
            self._step_length = 1.0
        logger.info("TraCI started on port %s (label=%s)", port, self._label)

    def step(self) -> None:
        """Advance the simulation by one step.

        P1 grade coupling: before ``simulationStep``, override the ego's
        accel with ``sumo_idm_accel + a_grade`` for one step.
        ``traci.vehicle.setAcceleration(veh, a, dt)`` fixes the accel used
        by SUMO's model integrator for the next ``dt`` seconds. We read the
        model's current decision (``getAcceleration``), then add the grade
        term derived from ``corridor.alpha`` at the ego's current abscissa.
        """
        traci = self._require_connection()

        # --- P1 grade injection (safe: only when ego is on the road) ---
        try:
            if EGO_ID in traci.vehicle.getIDList() and self._corridor is not None:
                S = list(getattr(self._corridor, "S", []) or [])
                alphas = list(getattr(self._corridor, "alpha", []) or [])
                if S and alphas:
                    s_ego = float(traci.vehicle.getDistance(EGO_ID))
                    alpha_s = _interp_series(s_ego, S, alphas)
                    a_grade = -G_EARTH * math.sin(alpha_s)
                    if abs(a_grade) > 1e-4:
                        try:
                            a_sumo = float(traci.vehicle.getAcceleration(EGO_ID))
                        except Exception:  # noqa: BLE001
                            a_sumo = 0.0
                        traci.vehicle.setAcceleration(
                            EGO_ID,
                            a_sumo + a_grade,
                            self._step_length,
                        )
        except Exception as exc:  # noqa: BLE001 — grade must never crash SUMO
            logger.debug("grade injection skipped: %s", exc)

        traci.simulationStep()
        if EGO_ID not in traci.vehicle.getIDList():
            # Departed and arrived, or never spawned
            if traci.simulation.getTime() > 0:
                self._ego_arrived = True

    def stop(self) -> None:
        """Close TraCI and shut down the SUMO process."""
        if not self._started:
            return
        traci = self._traci or _try_import_traci()
        if traci is not None:
            try:
                traci.close(False)
            except Exception as exc:  # noqa: BLE001
                logger.debug("traci.close: %s", exc)
        self._started = False
        self._traci = None

    def _require_connection(self) -> Any:
        traci = self._require_available()
        if not self._started:
            raise SumoNetworkError("TraCI not started; call start_traci() first")
        # Switch to our connection label when multiple exist
        try:
            traci.switch(self._label)
        except Exception:  # noqa: BLE001
            pass
        return traci

    # -- snapshot / offline --------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        """Return a frame dict compatible with Agent G / ``SimulationFrame``.

        Keys: ``t``, ``v``, ``a``, ``s``, ``alpha``, ``density``, ``nearby_count``,
        ``tls_state``, ``vehicles``, ``ego_arrived``.
        """
        traci = self._require_connection()
        t = float(traci.simulation.getTime())
        ids = list(traci.vehicle.getIDList())

        if EGO_ID not in ids:
            return {
                "t": t,
                "v": 0.0,
                "a": 0.0,
                "s": float(getattr(self._corridor, "S", [0.0])[-1] if self._corridor else 0.0)
                if self._ego_arrived
                else 0.0,
                "alpha": 0.0,
                "density": 0.0,
                "nearby_count": 0,
                "tls_state": None,
                "vehicles": [],
                "ego_arrived": self._ego_arrived,
            }

        speed = float(traci.vehicle.getSpeed(EGO_ID))
        try:
            accel = float(traci.vehicle.getAcceleration(EGO_ID))
        except Exception:  # noqa: BLE001
            if self._prev_speed is None:
                accel = 0.0
            else:
                accel = (speed - self._prev_speed) / max(self._step_length, 1e-6)
        self._prev_speed = speed

        try:
            s = float(traci.vehicle.getDistance(EGO_ID))
        except Exception:  # noqa: BLE001
            s = 0.0

        alpha = 0.0
        if self._corridor is not None:
            S = list(getattr(self._corridor, "S", []) or [])
            alphas = list(getattr(self._corridor, "alpha", []) or [])
            alpha = _interp_series(s, S, alphas)

        ego_xy = traci.vehicle.getPosition(EGO_ID)
        nearby = 0
        vehicles: list[dict[str, Any]] = []
        area_km2 = math.pi * (NEARBY_RADIUS_M / 1000.0) ** 2

        for vid in ids:
            pos = traci.vehicle.getPosition(vid)
            lon, lat = _xy_to_lonlat(pos[0], pos[1], self._lon0, self._lat0)
            v_spd = float(traci.vehicle.getSpeed(vid))
            vehicles.append(
                {
                    "id": vid,
                    "lat": lat,
                    "lon": lon,
                    "speed_mps": v_spd,
                    "is_ego": vid == EGO_ID,
                }
            )
            if vid == EGO_ID:
                continue
            if math.hypot(pos[0] - ego_xy[0], pos[1] - ego_xy[1]) <= NEARBY_RADIUS_M:
                nearby += 1

        density = float(nearby / area_km2) if area_km2 > 0 else float(nearby)

        tls_state: str | None = None
        try:
            next_tls = traci.vehicle.getNextTLS(EGO_ID)
            if next_tls:
                # (tlsID, tlsIndex, distance, state)
                tls_state = str(next_tls[0][3])
        except Exception:  # noqa: BLE001
            tls_state = None

        return {
            "t": t,
            "v": speed,
            "a": accel,
            "s": s,
            "alpha": alpha,
            "density": density,
            "nearby_count": nearby,
            "tls_state": tls_state,
            "vehicles": vehicles,
            "ego_arrived": False,
        }

    def run_offline(self, max_steps: int = 3600) -> Iterator[dict[str, Any]]:
        """Generator yielding ``snapshot()`` frames; starts TraCI if needed.

        Stops when ego arrives, the simulation empties, or ``max_steps`` is hit.
        Always calls ``stop()`` when the generator finishes or is closed.
        """
        if not self._started:
            self.start_traci()
        try:
            for _ in range(max_steps):
                self.step()
                frame = self.snapshot()
                yield frame
                if frame.get("ego_arrived"):
                    break
                traci = self._require_connection()
                if traci.simulation.getMinExpectedNumber() <= 0:
                    break
        finally:
            self.stop()
