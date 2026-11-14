"""OSM maxspeed parsing and corridor overlay (posted legal speeds)."""

from __future__ import annotations

import re
from typing import Callable, Sequence

from app.models.schemas import (
    CycleGenWarning,
    LatLon,
    OsmSpeedLimitSegment,
)

# France / EU zone defaults (km/h) when OSM uses symbolic maxspeed.
_ZONE_MAXSPEED_KMH: dict[str, float] = {
    "fr:urban": 50.0,
    "fr:rural": 80.0,
    "fr:zone30": 30.0,
    "fr:zone20": 20.0,
    "fr:living_street": 20.0,
    "fr:trunk": 110.0,
    "fr:motorway": 130.0,
    "de:urban": 50.0,
    "de:rural": 100.0,
    "de:zone30": 30.0,
    "de:living_street": 7.0,
    "de:motorway": 130.0,  # advisory; treat as 130 for envelope
    "at:urban": 50.0,
    "at:rural": 100.0,
    "it:urban": 50.0,
    "it:rural": 90.0,
    "ch:urban": 50.0,
    "ch:rural": 80.0,
}

_NUMERIC_RE = re.compile(
    r"^\s*(\d+(?:\.\d+)?)\s*(km/h|kmh|kph|mph)?\s*$",
    re.IGNORECASE,
)


def parse_osm_maxspeed_kmh(tags: dict[str, str] | None) -> float | None:
    """Extract a posted speed (km/h) from OSM way tags, or None if unknown."""
    if not tags:
        return None

    for key in ("maxspeed", "maxspeed:forward", "maxspeed:backward"):
        raw = tags.get(key)
        if not raw:
            continue
        parsed = _parse_maxspeed_value(raw)
        if parsed is not None:
            return parsed

    for key in ("maxspeed:type", "source:maxspeed", "zone:maxspeed"):
        raw = tags.get(key)
        if not raw:
            continue
        zone = _ZONE_MAXSPEED_KMH.get(str(raw).strip().lower())
        if zone is not None:
            return zone

    return None


def _parse_maxspeed_value(raw: str) -> float | None:
    s = str(raw).strip()
    if not s or s.lower() in ("none", "signals", "variable", "walk", "unknown"):
        return None
    # Multi-value: take the most restrictive
    if ";" in s:
        parts = [_parse_maxspeed_value(p) for p in s.split(";")]
        vals = [p for p in parts if p is not None]
        return min(vals) if vals else None

    zone = _ZONE_MAXSPEED_KMH.get(s.lower())
    if zone is not None:
        return zone

    m = _NUMERIC_RE.match(s)
    if not m:
        return None
    val = float(m.group(1))
    unit = (m.group(2) or "km/h").lower()
    if unit == "mph":
        val *= 1.60934
    if val < 5.0 or val > 160.0:
        return None
    return val


def overlay_osm_maxspeed(
    S: Sequence[float],
    geometry: Sequence[LatLon],
    V_legal: Sequence[float],
    segments: Sequence[OsmSpeedLimitSegment],
    *,
    project_fn: Callable[
        [Sequence[LatLon], Sequence[float], float, float],
        tuple[float, float] | None,
    ],
    max_lateral_m: float = 35.0,
) -> tuple[list[float], list[CycleGenWarning]]:
    """Replace free-flow legal with OSM posted speeds where ways match the route.

    Unmatched samples keep the annotation-based V_legal. Matched samples use
    the OSM value (authoritative for agglomeration 50 / 70 zones).
    """
    n = min(len(S), len(V_legal), len(geometry))
    if n == 0:
        return [], []
    out = [float(V_legal[i]) for i in range(n)]
    covered = [False] * n
    warnings: list[CycleGenWarning] = []

    if not segments:
        return out, warnings

    for seg in segments:
        pts: list[LatLon] = []
        if seg.geometry:
            pts = list(seg.geometry)
        else:
            pts = [
                LatLon(lat=seg.lat0, lon=seg.lon0),
                LatLon(lat=seg.lat1, lon=seg.lon1),
            ]
        projected: list[float] = []
        for p in pts:
            hit = project_fn(geometry, S, float(p.lat), float(p.lon))
            if hit is None:
                continue
            s_m, lat_m = hit
            if abs(float(lat_m)) > max_lateral_m:
                continue
            projected.append(float(s_m))
        if len(projected) < 1:
            continue
        s0 = min(projected)
        s1 = max(projected)
        # Tiny ways: expand to at least ~25 m so a village plaque sticks.
        if s1 - s0 < 25.0:
            mid = 0.5 * (s0 + s1)
            s0 = mid - 12.5
            s1 = mid + 12.5
        v_mps = float(seg.maxspeed_kmh) / 3.6
        if v_mps <= 0:
            continue
        for i in range(n):
            si = float(S[i])
            if s0 - 1.0 <= si <= s1 + 1.0:
                # Prefer OSM posted; if several overlap, keep the lowest.
                if not covered[i] or v_mps < out[i]:
                    out[i] = v_mps
                    covered[i] = True

    n_cov = sum(1 for c in covered if c)
    if n_cov > 0:
        s_hit = [float(S[i]) for i in range(n) if covered[i]]
        warnings.append(
            CycleGenWarning(
                code="osm_maxspeed_overlay",
                message=(
                    f"V_legal enrichi avec maxspeed OSM sur {n_cov}/{n} points "
                    f"({len(segments)} ways)."
                ),
                s0=min(s_hit) if s_hit else 0.0,
                s1=max(s_hit) if s_hit else 0.0,
                source="overpass_maxspeed",
            )
        )
    else:
        warnings.append(
            CycleGenWarning(
                code="osm_maxspeed_miss",
                message=(
                    "Aucun maxspeed OSM n’a pu être projeté sur le tracé — "
                    "V_legal reste l’annotation free-flow Mapbox/OSRM."
                ),
                s0=0.0,
                s1=float(S[-1]) if S else 0.0,
                source="overpass_maxspeed",
            )
        )

    return out, warnings


def snap_kmh_to_posted(kmh: float) -> float:
    """Snap to common posted bins (cosmetic)."""
    bins = (10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130)
    best = bins[0]
    best_d = abs(best - kmh)
    for b in bins:
        d = abs(b - kmh)
        if d < best_d:
            best, best_d = b, d
    if best_d <= 4.5:
        return float(best)
    return float(round(kmh / 5.0) * 5.0)
