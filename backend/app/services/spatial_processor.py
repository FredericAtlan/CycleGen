"""Build a SpatialCorridor from RouteAnalyzeResponse-like route data (Vague 1)."""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence

import numpy as np
from scipy.signal import savgol_filter
from scipy.spatial import cKDTree

from app.models.schemas import (
    CycleGenWarning,
    DetectedEvent,
    FeuMeta,
    LatLon,
    ResolvedViaPoint,
    RoadStructureSegment,
    RouteAnalyzeResponse,
    ScheduledStop,
    SlopeKmSegment,
    SlopeProfile,
    SlopeTrapezoid,
    SpatialCorridor,
    TrafficSignalPoint,
)
from app.services.curvature import (
    braking_feasible_speed,
    curve_speed_limit_mps,
    curvature_radius_m,
    smooth_envelope_bilateral,
    smooth_envelope_spatial,
)
from app.services.osm_maxspeed import overlay_osm_maxspeed

EARTH_RADIUS_M = 6_371_000.0
SIGNAL_DEDUP_M = 15.0
MIN_DS_M = 1e-6
SPEED_CHANGE_EPS = 1e-3
MAX_LATERAL_SIGNAL_M = 5.0
MAX_GRADE = 0.15
# Physical window (m) for spatial MA on DEM altitude before slope — kills
# Mapbox/OSM point-noise sawteeth without AVL-style multi-km fake waves.
SG_MIN_SPAN_M = 150.0
SG_MIN_WINDOW = 5
DEFAULT_TRAP_LENGTH_M = 50.0
# Spatial elevation smoother half-window is ``window_m / 2``.
ELEV_SPATIAL_WINDOW_M = 150.0
KM_SEGMENT_M = 1000.0
GREEN_WAVE_HIGHWAYS = frozenset({"primary", "trunk"})
GREEN_WAVE_MIN_SPACING_M = 500.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters between two WGS84 points."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2.0) ** 2
    )
    return 2.0 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def cumulative_distance_m(
    geometry: Sequence[LatLon],
    segment_distances_m: Sequence[float] | None = None,
) -> list[float]:
    """
    Cumulative distance vector S (meters from start), length = len(geometry).

    Prefers ``segment_distances_m`` when it has n-1 entries; otherwise haversine.
    Zero-length segments are kept (S plateaus) so index alignment is preserved.
    """
    n = len(geometry)
    if n == 0:
        return []
    if n == 1:
        return [0.0]

    use_segments = (
        segment_distances_m is not None and len(segment_distances_m) == n - 1
    )
    s = [0.0]
    for i in range(n - 1):
        if use_segments:
            ds = float(segment_distances_m[i])
            if not math.isfinite(ds) or ds < 0.0:
                ds = 0.0
        else:
            a, b = geometry[i], geometry[i + 1]
            ds = haversine_m(a.lat, a.lon, b.lat, b.lon)
        s.append(s[-1] + ds)
    return s


def align_speeds_to_points(
    n_points: int,
    segment_speeds_mps: Sequence[float],
) -> list[float]:
    """
    Map segment speeds (typically n-1) onto n geometry points.

    Point i uses segment i for i < n-1; the last point pads with the last
    known segment speed. Missing / empty inputs yield zeros.
    """
    if n_points <= 0:
        return []
    if not segment_speeds_mps:
        return [0.0] * n_points

    speeds = [
        float(v) if v is not None and math.isfinite(float(v)) else 0.0
        for v in segment_speeds_mps
    ]
    out: list[float] = []
    for i in range(n_points):
        if i < len(speeds):
            out.append(speeds[i])
        else:
            out.append(speeds[-1])
    return out


# Common FR / EU posted limits (km/h). Mapbox "speed" is free-flow, not signs.
_POSTED_SPEED_KMH = (10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130)


def snap_posted_speed_mps(v_mps: float) -> float:
    """Snap free-flow / float speeds to discrete posted limits for V_legal."""
    if not math.isfinite(v_mps) or v_mps <= 0:
        return 0.0 if (isinstance(v_mps, (int, float)) and v_mps <= 0) else 0.0
    kmh = v_mps * 3.6
    best = _POSTED_SPEED_KMH[0]
    best_d = abs(best - kmh)
    for p in _POSTED_SPEED_KMH:
        d = abs(p - kmh)
        if d < best_d:
            best = p
            best_d = d
    if best_d <= 4.5:
        return best / 3.6
    return (round(kmh / 5.0) * 5.0) / 3.6


def snap_legal_speeds_mps(speeds: Sequence[float]) -> list[float]:
    return [snap_posted_speed_mps(float(v)) for v in speeds]


def smooth_legal_speeds_spatial(
    S: Sequence[float],
    V_legal: Sequence[float],
    *,
    window_m: float = 250.0,
    mode: str = "majority",
    min_run_m: float = 120.0,
) -> list[float]:
    """Stabilize posted V_legal along S (OSM fragments / free-flow flicker).

    Modes (spatial window of width ``window_m``):
      - ``none``: identity
      - ``majority``: most frequent snapped km/h bin (robust vs plaque noise)
      - ``min``: lowest binding speed in the window (conservative)
      - ``mean_snap``: arithmetic mean then re-snap to posted bins

    Then ``min_run_m`` debounce: a new plateau must span at least that distance
    along S before the limit is allowed to change.
    """
    n = min(len(S), len(V_legal))
    if n == 0:
        return []
    mode_l = str(mode or "none").strip().lower()
    if mode_l not in ("none", "majority", "min", "mean_snap"):
        mode_l = "majority"
    out = [float(V_legal[i]) for i in range(n)]

    if mode_l != "none" and float(window_m) > 0 and n > 1:
        half = float(window_m) * 0.5
        S_arr = [float(S[i]) for i in range(n)]
        V_arr = list(out)
        j0 = 0
        j1 = 0
        for i in range(n):
            si = S_arr[i]
            while j0 < n and S_arr[j0] < si - half:
                j0 += 1
            if j1 < j0:
                j1 = j0
            while j1 < n and S_arr[j1] <= si + half:
                j1 += 1
            window = [V_arr[j] for j in range(j0, j1) if V_arr[j] > 0.0]
            if not window:
                continue
            if mode_l == "min":
                out[i] = min(window)
            elif mode_l == "mean_snap":
                out[i] = sum(window) / len(window)
            else:
                bins = [int(round(v * 3.6)) for v in window]
                counts: dict[int, int] = {}
                for b in bins:
                    counts[b] = counts.get(b, 0) + 1
                best_b = bins[0]
                best_c = -1
                for b, c in counts.items():
                    if c > best_c or (c == best_c and b < best_b):
                        best_c = c
                        best_b = b
                out[i] = best_b / 3.6
        out = snap_legal_speeds_mps(out)

    run_m = max(0.0, float(min_run_m))
    if run_m > 0 and n > 1:
        debounced = list(out)
        i = 0
        guard = 0
        while i < n and guard < n * 3:
            guard += 1
            v_cur = debounced[i]
            j = i + 1
            while j < n and abs(debounced[j] - v_cur) < 1e-6:
                j += 1
            if j >= n:
                break
            v_new = debounced[j]
            k = j
            while k < n and abs(debounced[k] - v_new) < 1e-6:
                k += 1
            span = float(S[k - 1] - S[j]) if k > j else 0.0
            if span + 1e-6 < run_m:
                for t in range(j, k):
                    debounced[t] = v_cur
                continue
            i = j
        out = debounced

    return out


def _to_local_xy(
    lat: float,
    lon: float,
    *,
    lat0: float,
    lon0: float,
) -> tuple[float, float]:
    """Equirectangular local meters around (lat0, lon0), matching curvature.py."""
    lat0_r = math.radians(lat0)
    x = (math.radians(lon) - math.radians(lon0)) * math.cos(lat0_r) * EARTH_RADIUS_M
    y = (math.radians(lat) - math.radians(lat0)) * EARTH_RADIUS_M
    return x, y


def project_point_onto_polyline_ortho(
    geometry: Sequence[LatLon],
    S: Sequence[float],
    lat: float,
    lon: float,
) -> tuple[float, float] | None:
    """
    Orthogonal projection of (lat, lon) onto the route polyline.

    Returns ``(s_m, lateral_m)`` in local equirectangular meters, or ``None``
    if geometry / S are empty or mismatched.
    """
    n = len(geometry)
    if n == 0 or not S or len(S) != n:
        return None

    lat0 = float(geometry[0].lat)
    lon0 = float(geometry[0].lon)
    px, py = _to_local_xy(lat, lon, lat0=lat0, lon0=lon0)

    if n == 1:
        ax, ay = 0.0, 0.0
        return float(S[0]), math.hypot(px - ax, py - ay)

    best_dist2: float | None = None
    best_s = 0.0
    best_lateral = 0.0

    for i in range(n - 1):
        ax, ay = _to_local_xy(geometry[i].lat, geometry[i].lon, lat0=lat0, lon0=lon0)
        bx, by = _to_local_xy(
            geometry[i + 1].lat, geometry[i + 1].lon, lat0=lat0, lon0=lon0
        )
        abx, aby = bx - ax, by - ay
        apx, apy = px - ax, py - ay
        ab2 = abx * abx + aby * aby
        if ab2 < 1e-12:
            t = 0.0
            qx, qy = ax, ay
        else:
            t = (apx * abx + apy * aby) / ab2
            t = max(0.0, min(1.0, t))
            qx = ax + t * abx
            qy = ay + t * aby
        dx, dy = px - qx, py - qy
        dist2 = dx * dx + dy * dy
        s_m = float(S[i]) + t * (float(S[i + 1]) - float(S[i]))
        if best_dist2 is None or dist2 < best_dist2:
            best_dist2 = dist2
            best_s = s_m
            best_lateral = math.sqrt(dist2)

    if best_dist2 is None:
        return None
    return best_s, best_lateral


def _dedup_feux_along_s(
    feux: Sequence[FeuMeta],
    *,
    dedup_m: float,
) -> list[FeuMeta]:
    if not feux:
        return []
    ordered = sorted(feux, key=lambda f: float(f.s_m))
    out: list[FeuMeta] = [ordered[0]]
    for f in ordered[1:]:
        if abs(float(f.s_m) - float(out[-1].s_m)) >= dedup_m:
            out.append(f)
        elif out[-1].highway is None and f.highway:
            out[-1] = FeuMeta(
                s_m=out[-1].s_m,
                highway=f.highway,
                tls_mode=out[-1].tls_mode,
            )
    return out


def project_signals_strict(
    geometry: Sequence[LatLon],
    S: Sequence[float],
    traffic_signals: Sequence[TrafficSignalPoint],
    max_lateral_m: float = MAX_LATERAL_SIGNAL_M,
) -> tuple[list[FeuMeta], list[CycleGenWarning]]:
    """
    Ortho-project OSM signals onto the corridor; reject if lateral > max_lateral_m.

    Deduplicates along S within ``SIGNAL_DEDUP_M``. Initial ``tls_mode`` is
    ``\"stochastic\"`` (green-wave assignment is a separate pass).
    """
    warnings: list[CycleGenWarning] = []
    if not geometry or not S or not traffic_signals:
        return [], warnings

    accepted: list[FeuMeta] = []
    for sig in traffic_signals:
        proj = project_point_onto_polyline_ortho(geometry, S, sig.lat, sig.lon)
        if proj is None:
            continue
        s_m, lateral_m = proj
        if lateral_m > max_lateral_m:
            warnings.append(
                CycleGenWarning(
                    code="signal_rejected_5m",
                    message=(
                        f"Traffic signal rejected: lateral {lateral_m:.2f} m "
                        f"> {max_lateral_m:.1f} m"
                    ),
                    s0=float(s_m),
                    s1=float(s_m),
                    source="spatial_processor",
                )
            )
            continue
        accepted.append(
            FeuMeta(
                s_m=float(s_m),
                highway=sig.highway,
                tls_mode="stochastic",
            )
        )

    return _dedup_feux_along_s(accepted, dedup_m=SIGNAL_DEDUP_M), warnings


def assign_tls_modes(
    feux: list[FeuMeta],
    highway_along_s: Callable[[float], str | None]
    | Sequence[str | None]
    | None = None,
) -> list[FeuMeta]:
    """
    Set ``tls_mode``: green_wave if highway in (primary, trunk) and nearest
    neighbor feu is at least 500 m away; otherwise stochastic.
    """
    if not feux:
        return []

    ordered = sorted(feux, key=lambda f: float(f.s_m))

    def _resolve_highway(idx: int, feu: FeuMeta) -> str | None:
        if feu.highway:
            return feu.highway
        if highway_along_s is None:
            return None
        if callable(highway_along_s):
            return highway_along_s(float(feu.s_m))
        if idx < len(highway_along_s):
            return highway_along_s[idx]
        return None

    out: list[FeuMeta] = []
    for i, feu in enumerate(ordered):
        hw = _resolve_highway(i, feu)
        dist_nn = float("inf")
        if i > 0:
            dist_nn = min(dist_nn, abs(float(feu.s_m) - float(ordered[i - 1].s_m)))
        if i + 1 < len(ordered):
            dist_nn = min(dist_nn, abs(float(ordered[i + 1].s_m) - float(feu.s_m)))

        mode: str = "stochastic"
        if hw in GREEN_WAVE_HIGHWAYS and dist_nn >= GREEN_WAVE_MIN_SPACING_M:
            mode = "green_wave"

        out.append(
            FeuMeta(
                s_m=float(feu.s_m),
                highway=hw,
                tls_mode=mode,  # type: ignore[arg-type]
            )
        )
    return out


def _nearest_vertex_index(
    geometry: Sequence[LatLon],
    lat: float,
    lon: float,
) -> int | None:
    if not geometry:
        return None
    best_i = 0
    best_d = float("inf")
    for i, p in enumerate(geometry):
        d = haversine_m(lat, lon, p.lat, p.lon)
        if d < best_d:
            best_d = d
            best_i = i
    return best_i


def _pad_elevations(elevations: Sequence[float], n: int) -> list[float]:
    if n <= 0:
        return []
    elev = [float(e) for e in elevations[:n]]
    if len(elev) < n:
        pad = elev[-1] if elev else 0.0
        elev.extend([pad] * (n - len(elev)))
    return elev


def prepare_elevations(
    elevations: Sequence[float],
    S: Sequence[float],
    geometry: Sequence[LatLon],
    road_structures: Sequence[RoadStructureSegment] | None,
    *,
    max_grade: float = MAX_GRADE,
) -> tuple[list[float], list[CycleGenWarning]]:
    """
    Correct DEM elevations for bridge/tunnel spans, then clamp extreme grades.

    Bridge/tunnel: linear Z between nearest geometry indices of the structure
    endpoints. Then any step with ``|dz/ds| > max_grade`` is linearly interpolated
    across the offending region.
    """
    n = len(S)
    warnings: list[CycleGenWarning] = []
    if n == 0:
        return [], warnings

    grade_lim = max(float(max_grade), 0.01)
    elev = _pad_elevations(elevations, n)

    for struct in road_structures or []:
        if struct.kind not in ("bridge", "tunnel"):
            continue
        i0 = _nearest_vertex_index(geometry, struct.lat0, struct.lon0)
        i1 = _nearest_vertex_index(geometry, struct.lat1, struct.lon1)
        if i0 is None or i1 is None:
            continue
        lo, hi = (i0, i1) if i0 <= i1 else (i1, i0)
        if hi <= lo:
            continue
        z0, z1 = elev[lo], elev[hi]
        s0, s1 = float(S[lo]), float(S[hi])
        span = s1 - s0
        for k in range(lo, hi + 1):
            if abs(span) < MIN_DS_M:
                elev[k] = z0
            else:
                t = (float(S[k]) - s0) / span
                elev[k] = z0 + t * (z1 - z0)
        warnings.append(
            CycleGenWarning(
                code="elevation_structure_interp",
                message=f"Linear elevation interpolation on {struct.kind}",
                s0=s0,
                s1=s1,
                source="spatial_processor",
            )
        )

    i = 1
    while i < n:
        ds = float(S[i] - S[i - 1])
        if abs(ds) < MIN_DS_M:
            i += 1
            continue
        if abs((elev[i] - elev[i - 1]) / ds) <= grade_lim:
            i += 1
            continue

        # Expand until bridging i-1 → j has acceptable average grade, else to end.
        j = i
        while j + 1 < n:
            span = float(S[j + 1] - S[i - 1])
            if abs(span) < MIN_DS_M:
                j += 1
                continue
            if abs((elev[j + 1] - elev[i - 1]) / span) <= grade_lim:
                j = j + 1
                break
            j += 1
        else:
            j = n - 1

        s0, s1 = float(S[i - 1]), float(S[j])
        z0, z1 = elev[i - 1], elev[j]
        span = s1 - s0
        for k in range(i - 1, j + 1):
            if abs(span) < MIN_DS_M:
                elev[k] = z0
            else:
                elev[k] = z0 + (float(S[k]) - s0) / span * (z1 - z0)
        warnings.append(
            CycleGenWarning(
                code="elevation_grade_clamp",
                message=(
                    f"Interpolated elevation where |dz/ds| > {grade_lim:.3f} "
                    f"({grade_lim * 100:.0f}% grade)"
                ),
                s0=s0,
                s1=s1,
                source="spatial_processor",
            )
        )
        i = max(j, i) + 1

    return elev, warnings


def _savgol_safe(
    values: np.ndarray,
    window: int,
    polyorder: int,
) -> np.ndarray:
    n = len(values)
    if n < 3 or window < 3:
        return values

    w = min(int(window), n)
    if w % 2 == 0:
        w -= 1
    if w < 3:
        return values

    po = min(int(polyorder), w - 1)
    if po < 1:
        return values
    return savgol_filter(values, window_length=w, polyorder=po, mode="interp")


def _sg_window_length(
    S: Sequence[float],
    smooth_window: int,
    *,
    sg_min_span_m: float = SG_MIN_SPAN_M,
) -> int:
    """Odd SG window raised so physical span ≥ ``sg_min_span_m``, clamped to n."""
    n = len(S)
    if n <= 0:
        return 1

    ds_pos = [
        abs(float(S[i] - S[i - 1]))
        for i in range(1, n)
        if abs(float(S[i] - S[i - 1])) >= MIN_DS_M
    ]
    median_ds = float(np.median(ds_pos)) if ds_pos else 1.0
    if median_ds < MIN_DS_M:
        median_ds = 1.0

    span_m = max(float(sg_min_span_m), 5.0)
    w_for_span = int(math.ceil(span_m / median_ds))
    if w_for_span % 2 == 0:
        w_for_span += 1
    w_for_span = max(SG_MIN_WINDOW, w_for_span)

    w = max(int(smooth_window), w_for_span, SG_MIN_WINDOW)
    if w % 2 == 0:
        w += 1
    if n >= 3:
        w = min(w, n if n % 2 == 1 else n - 1)
    else:
        w = n if n % 2 == 1 else max(1, n - 1)
    return w


def _interp_z_at_s(S: Sequence[float], elev: Sequence[float], s_q: float) -> float:
    """Linear interpolation of elevation along cumulative distance S."""
    n = min(len(S), len(elev))
    if n == 0:
        return 0.0
    if n == 1:
        return float(elev[0])

    s = float(s_q)
    if s <= float(S[0]):
        return float(elev[0])
    if s >= float(S[n - 1]):
        return float(elev[n - 1])

    for i in range(n - 1):
        s0 = float(S[i])
        s1 = float(S[i + 1])
        if s1 < s0:
            continue
        if s0 <= s <= s1 or (i == n - 2 and s <= s1):
            ds = s1 - s0
            if abs(ds) < MIN_DS_M:
                return float(elev[i])
            t = (s - s0) / ds
            return float(elev[i]) + t * (float(elev[i + 1]) - float(elev[i]))
        if s < s0:
            return float(elev[i])
    return float(elev[n - 1])


def build_slope_trapezoids(
    elev: Sequence[float],
    S: Sequence[float],
    trap_length_m: float,
) -> list[SlopeTrapezoid]:
    """
    Fixed-length trapezoid / palier slopes along S.

    Walks s from 0 to S[-1] in steps of ``trap_length_m``; the last trap may
    be shorter. Skips intervals with ``ds < MIN_DS_M``.
    """
    n = min(len(S), len(elev))
    if n == 0:
        return []
    if n == 1:
        z = float(elev[0])
        return [
            SlopeTrapezoid(
                s0_m=float(S[0]),
                s1_m=float(S[0]),
                z0_m=z,
                z1_m=z,
                slope_rad=0.0,
                slope_pct=0.0,
            )
        ]

    total = float(S[n - 1])
    L = max(float(trap_length_m), MIN_DS_M)
    traps: list[SlopeTrapezoid] = []
    s0 = 0.0
    while s0 < total - MIN_DS_M:
        s1 = min(s0 + L, total)
        ds = s1 - s0
        if ds < MIN_DS_M:
            break
        z0 = _interp_z_at_s(S, elev, s0)
        z1 = _interp_z_at_s(S, elev, s1)
        dz = z1 - z0
        slope_pct = 100.0 * dz / ds
        slope_rad = math.atan(dz / ds)
        traps.append(
            SlopeTrapezoid(
                s0_m=s0,
                s1_m=s1,
                z0_m=z0,
                z1_m=z1,
                slope_rad=slope_rad,
                slope_pct=slope_pct,
            )
        )
        s0 = s1
    return traps


def smooth_elevation_spatial(
    S: Sequence[float],
    elev: Sequence[float],
    *,
    window_m: float = ELEV_SPATIAL_WINDOW_M,
) -> list[float]:
    """Distance-based moving average on Z(s) — never index windows.

    Mapbox/OSM DEM samples are uneven; an index SG (i±5) turns every bridge
    abutment / 0.5 m DEM error into a slope spike. Aggregate Z_k for
    S_k ∈ [S_i − W/2, S_i + W/2] so valley routes stay ~flat (−0.8 %) without
    inventing AVL-scale hills.
    """
    n = min(len(S), len(elev))
    if n == 0:
        return []
    if n == 1 or window_m <= 0:
        return [float(elev[i]) for i in range(n)]
    half = float(window_m) * 0.5
    S_arr = [float(S[i]) for i in range(n)]
    Z_arr = [float(elev[i]) for i in range(n)]
    out: list[float] = []
    j0 = 0
    j1 = 0
    for i in range(n):
        si = S_arr[i]
        while j0 < n and S_arr[j0] < si - half:
            j0 += 1
        if j1 < j0:
            j1 = j0
        while j1 < n and S_arr[j1] <= si + half:
            j1 += 1
        if j1 > j0:
            out.append(sum(Z_arr[j0:j1]) / (j1 - j0))
        else:
            out.append(Z_arr[i])
    return out


def _optional_sg_smooth_z(
    elev: Sequence[float],
    S: Sequence[float],
    smooth_window: int,
    smooth_polyorder: int,
    *,
    sg_min_span_m: float,
) -> list[float]:
    """Spatial MA on Z (primary), then light Savitzky–Golay polish.

    Order matters: distance filter first (same lesson as V_curve / R), then
    an optional index SG whose physical span is already ≥ ``sg_min_span_m``.
    Pass ``sg_min_span_m <= 0`` and ``smooth_window < 5`` to skip (already smoothed).
    """
    n = len(S)
    elev_arr = np.asarray(_pad_elevations(elev, n), dtype=float)
    if float(sg_min_span_m) <= 0.0 and int(smooth_window) < SG_MIN_WINDOW:
        return elev_arr.tolist()
    # Primary: spatial mean — window = physical span requested by the UI preset.
    span = max(float(sg_min_span_m), 5.0)
    z_spatial = smooth_elevation_spatial(
        S, elev_arr.tolist(), window_m=span
    )
    if smooth_window < SG_MIN_WINDOW or n < SG_MIN_WINDOW:
        return z_spatial
    # Secondary polish: SG sized to the same physical span (not raw sample count).
    w = _sg_window_length(S, smooth_window, sg_min_span_m=span)
    if w >= SG_MIN_WINDOW:
        return _savgol_safe(
            np.asarray(z_spatial, dtype=float), w, smooth_polyorder
        ).tolist()
    return z_spatial


def slope_from_elevation_trapezoids(
    elev: Sequence[float],
    S: Sequence[float],
    trap_length_m: float = DEFAULT_TRAP_LENGTH_M,
    *,
    smooth_window: int = 11,
    smooth_polyorder: int = 3,
    sg_min_span_m: float = SG_MIN_SPAN_M,
) -> tuple[list[float], list[SlopeTrapezoid]]:
    """
    Slope α (rad) as piecewise-constant paliers of length ``trap_length_m``.

    Pre-smooths Z with a **spatial** moving average (window ≈ ``sg_min_span_m``)
    plus optional Savitzky–Golay, then builds trapezoids and maps each
    geometry sample onto the trap containing S[i].
    """
    n = len(S)
    if n == 0:
        return [], []

    z_work = _optional_sg_smooth_z(
        elev,
        S,
        smooth_window,
        smooth_polyorder,
        sg_min_span_m=sg_min_span_m,
    )
    traps = build_slope_trapezoids(z_work, S, trap_length_m)
    if not traps:
        return [0.0] * n, []

    return _alpha_from_traps(S, traps), traps


def _alpha_from_traps(
    S: Sequence[float],
    traps: Sequence[SlopeTrapezoid],
) -> list[float]:
    """Map piecewise-constant trap slopes onto geometry abscissae S."""
    n = len(S)
    if n == 0:
        return []
    if not traps:
        return [0.0] * n

    alpha = [0.0] * n
    ti = 0
    n_traps = len(traps)
    for i in range(n):
        s_i = float(S[i])
        while ti + 1 < n_traps and s_i >= float(traps[ti].s1_m):
            ti += 1
        alpha[i] = float(traps[ti].slope_rad)
    alpha[0] = float(traps[0].slope_rad)
    return alpha


def build_slope_profile(
    traps: Sequence[SlopeTrapezoid],
    elev: Sequence[float],
    S: Sequence[float],
    trap_length_m: float,
) -> SlopeProfile:
    """Group trapezoids into 1 km segments with nested traps for UI drill-down."""
    if not S:
        return SlopeProfile(trap_length_m=float(trap_length_m), km_segments=[])

    total = float(S[-1]) if S else 0.0
    if total < MIN_DS_M and not traps:
        return SlopeProfile(trap_length_m=float(trap_length_m), km_segments=[])

    n_km = max(1, int(math.ceil(total / KM_SEGMENT_M))) if total > MIN_DS_M else 1
    segments: list[SlopeKmSegment] = []

    for k in range(n_km):
        s0_km = k * KM_SEGMENT_M
        s1_km = min((k + 1) * KM_SEGMENT_M, total)
        if s1_km - s0_km < MIN_DS_M and k > 0:
            continue

        km_traps = [
            t
            for t in traps
            if float(t.s0_m) < s1_km and float(t.s1_m) > s0_km
        ]
        # Prefer traps whose start falls in [s0, s1); keep overlaps as fallback
        started = [t for t in km_traps if s0_km <= float(t.s0_m) < s1_km]
        if started:
            km_traps = started

        z0 = _interp_z_at_s(S, elev, s0_km)
        z1 = _interp_z_at_s(S, elev, s1_km)
        ds_km = s1_km - s0_km
        if abs(ds_km) < MIN_DS_M:
            mean_pct = 0.0
        else:
            mean_pct = 100.0 * (z1 - z0) / ds_km

        if km_traps:
            pcts = [float(t.slope_pct) for t in km_traps]
            min_pct = min(pcts)
            max_pct = max(pcts)
            if len(pcts) >= 2:
                mean_t = sum(pcts) / len(pcts)
                var = sum((p - mean_t) ** 2 for p in pcts) / (len(pcts) - 1)
                std_pct = math.sqrt(var)
            else:
                std_pct = 0.0
        else:
            min_pct = mean_pct
            max_pct = mean_pct
            std_pct = 0.0

        segments.append(
            SlopeKmSegment(
                km_index=k,
                s0_m=s0_km,
                s1_m=s1_km,
                z0_m=z0,
                z1_m=z1,
                mean_pct=mean_pct,
                min_pct=min_pct,
                max_pct=max_pct,
                std_pct=std_pct,
                traps=list(km_traps),
            )
        )

    return SlopeProfile(trap_length_m=float(trap_length_m), km_segments=segments)


def slope_from_elevation_sg(
    elev_corrected: Sequence[float],
    S: Sequence[float],
    smooth_window: int,
    smooth_polyorder: int,
    *,
    sg_min_span_m: float = SG_MIN_SPAN_M,
) -> list[float]:
    """
    Slope α (rad) after spatial MA (+ optional SG) on Z, then α = atan(dz/ds).

    Window length is raised so the physical span is at least ``sg_min_span_m``
    (odd sample count, minimum 5), then clamped to series length.
    """
    n = len(S)
    if n == 0:
        return []

    z_smooth = _optional_sg_smooth_z(
        elev_corrected,
        S,
        smooth_window,
        smooth_polyorder,
        sg_min_span_m=sg_min_span_m,
    )

    alpha = np.zeros(n, dtype=float)
    for i in range(1, n):
        ds = float(S[i] - S[i - 1])
        if abs(ds) < MIN_DS_M:
            alpha[i] = alpha[i - 1]
        else:
            alpha[i] = math.atan((float(z_smooth[i]) - float(z_smooth[i - 1])) / ds)
    if n > 1:
        alpha[0] = alpha[1]
    return alpha.tolist()


def clip_alpha_to_grade_pct(
    alpha: Sequence[float],
    *,
    min_pct: float | None = None,
    max_pct: float | None = None,
) -> tuple[list[float], list[CycleGenWarning]]:
    """Hard-clip slope α (rad) to optional % grade bounds (tan α × 100)."""
    if min_pct is None and max_pct is None:
        return list(alpha), []

    lo = math.atan(float(min_pct) / 100.0) if min_pct is not None else None
    hi = math.atan(float(max_pct) / 100.0) if max_pct is not None else None
    if lo is not None and hi is not None and lo > hi:
        lo, hi = hi, lo

    out: list[float] = []
    n_clip = 0
    for a in alpha:
        v = float(a)
        if lo is not None and v < lo:
            v = lo
            n_clip += 1
        if hi is not None and v > hi:
            v = hi
            n_clip += 1
        out.append(v)

    warnings: list[CycleGenWarning] = []
    if n_clip:
        parts: list[str] = []
        if min_pct is not None:
            parts.append(f"min {min_pct:g}%")
        if max_pct is not None:
            parts.append(f"max {max_pct:g}%")
        warnings.append(
            CycleGenWarning(
                code="slope_alpha_clip",
                message=(
                    f"Clamped {n_clip} slope sample(s) to imposed "
                    f"{' / '.join(parts)}"
                ),
                source="spatial_processor",
            )
        )
    return out, warnings


def clip_traps_to_grade_pct(
    traps: Sequence[SlopeTrapezoid],
    *,
    min_pct: float | None = None,
    max_pct: float | None = None,
) -> tuple[list[SlopeTrapezoid], list[CycleGenWarning]]:
    """Hard-clip each trapezoid slope to optional % grade bounds."""
    if min_pct is None and max_pct is None:
        return [SlopeTrapezoid(**t.model_dump()) for t in traps], []

    lo_pct = float(min_pct) if min_pct is not None else None
    hi_pct = float(max_pct) if max_pct is not None else None
    if lo_pct is not None and hi_pct is not None and lo_pct > hi_pct:
        lo_pct, hi_pct = hi_pct, lo_pct

    out: list[SlopeTrapezoid] = []
    n_clip = 0
    for t in traps:
        pct = float(t.slope_pct)
        rad = float(t.slope_rad)
        clipped = False
        if lo_pct is not None and pct < lo_pct:
            pct = lo_pct
            rad = math.atan(pct / 100.0)
            clipped = True
        if hi_pct is not None and pct > hi_pct:
            pct = hi_pct
            rad = math.atan(pct / 100.0)
            clipped = True
        if clipped:
            n_clip += 1
        out.append(
            SlopeTrapezoid(
                s0_m=float(t.s0_m),
                s1_m=float(t.s1_m),
                z0_m=float(t.z0_m),
                z1_m=float(t.z1_m),
                slope_rad=rad,
                slope_pct=pct,
            )
        )

    warnings: list[CycleGenWarning] = []
    if n_clip:
        parts: list[str] = []
        if min_pct is not None:
            parts.append(f"min {min_pct:g}%")
        if max_pct is not None:
            parts.append(f"max {max_pct:g}%")
        warnings.append(
            CycleGenWarning(
                code="slope_alpha_clip",
                message=(
                    f"Clamped {n_clip} trapezoid slope(s) to imposed "
                    f"{' / '.join(parts)}"
                ),
                source="spatial_processor",
            )
        )
    return out, warnings


def detect_slope_spikes(
    alpha: Sequence[float],
    S: Sequence[float],
    *,
    abs_thresh_rad: float = 0.20,
) -> list[CycleGenWarning]:
    """Flag residual |α| spikes after slope filter (scenario E)."""
    warnings: list[CycleGenWarning] = []
    n = min(len(alpha), len(S))
    if n < 2:
        return warnings
    i = 0
    while i < n:
        if abs(float(alpha[i])) < abs_thresh_rad:
            i += 1
            continue
        j = i + 1
        peak = abs(float(alpha[i]))
        while j < n and abs(float(alpha[j])) >= abs_thresh_rad:
            peak = max(peak, abs(float(alpha[j])))
            j += 1
        s0 = float(S[i])
        s1 = float(S[min(j - 1, n - 1)])
        warnings.append(
            CycleGenWarning(
                code="slope_spike_residual",
                message=(
                    f"Residual slope spike |α|≈{peak:.3f} rad "
                    f"({math.tan(peak)*100:.1f}% grade) after slope filter "
                    f"between s={s0:.0f}–{s1:.0f} m — check bridge/tunnel tags "
                    "or elevation source."
                ),
                s0=s0,
                s1=s1,
                source="slope",
            )
        )
        i = j
    return warnings


def local_slope_rad(
    elevations_m: Sequence[float],
    S: Sequence[float],
    *,
    smooth_window: int = 11,
    smooth_polyorder: int = 3,
    sg_min_span_m: float = SG_MIN_SPAN_M,
) -> list[float]:
    """Backward-compatible alias of ``slope_from_elevation_sg``."""
    return slope_from_elevation_sg(
        elevations_m,
        S,
        smooth_window,
        smooth_polyorder,
        sg_min_span_m=sg_min_span_m,
    )


def project_signals_onto_route(
    geometry: Sequence[LatLon],
    S: Sequence[float],
    traffic_signals: Sequence[TrafficSignalPoint],
    *,
    dedup_m: float = SIGNAL_DEDUP_M,
) -> list[float]:
    """
    Backward-compatible signal projection → sorted deduplicated S positions.

    Uses strict ortho projection (5 m lateral) then optional re-dedup.
    """
    feux, _warnings = project_signals_strict(geometry, S, traffic_signals)
    if dedup_m != SIGNAL_DEDUP_M:
        feux = _dedup_feux_along_s(feux, dedup_m=dedup_m)
    return [float(f.s_m) for f in feux]


def _dedup_along_s(positions: Sequence[float], *, dedup_m: float) -> list[float]:
    if not positions:
        return []
    ordered = sorted(float(s) for s in positions)
    out: list[float] = [ordered[0]]
    for s in ordered[1:]:
        if abs(s - out[-1]) >= dedup_m:
            out.append(s)
    return out


def project_via_stops(
    geometry: Sequence[LatLon],
    S: Sequence[float],
    vias: Sequence[ResolvedViaPoint],
) -> list[ScheduledStop]:
    """Project intermediate waypoints onto the corridor centerline."""
    if not geometry or not vias or not S:
        return []
    coords = np.array([[p.lat, p.lon] for p in geometry], dtype=float)
    tree = cKDTree(coords)
    stops: list[ScheduledStop] = []
    for via in vias:
        _d, idx = tree.query([via.lat, via.lon], k=1)
        i = int(np.atleast_1d(idx)[0])
        stops.append(
            ScheduledStop(
                s_m=float(S[i]),
                stop_duration_s=float(via.stop_duration_s or 0.0),
                label=via.label or f"Stop {via.index + 1}",
                lat=float(via.lat),
                lon=float(via.lon),
            )
        )
    stops.sort(key=lambda st: st.s_m)
    return stops


def build_events(
    S: Sequence[float],
    V_limite: Sequence[float],
    S_feux: Sequence[float],
    scheduled_stops: Sequence[ScheduledStop] | None = None,
) -> list[DetectedEvent]:
    """DetectedEvent list for traffic signals, speed-limit changes and waypoint stops."""
    events: list[DetectedEvent] = []

    for s_feu in S_feux:
        events.append(
            DetectedEvent(
                s_m=float(s_feu),
                kind="traffic_signal",
                label="traffic_signal",
                value=None,
            )
        )

    for stop in scheduled_stops or []:
        dwell = float(stop.stop_duration_s or 0.0)
        events.append(
            DetectedEvent(
                s_m=float(stop.s_m),
                kind="waypoint_stop",
                label=f"{stop.label} ({dwell:.0f}s)" if dwell > 0 else stop.label,
                value=dwell if dwell > 0 else None,
            )
        )

    if S and V_limite:
        n = min(len(S), len(V_limite))
        prev = float(V_limite[0])
        events.append(
            DetectedEvent(
                s_m=float(S[0]),
                kind="speed_limit",
                label=_speed_label(prev),
                value=prev,
            )
        )
        for i in range(1, n):
            v = float(V_limite[i])
            if abs(v - prev) > SPEED_CHANGE_EPS:
                events.append(
                    DetectedEvent(
                        s_m=float(S[i]),
                        kind="speed_limit",
                        label=_speed_label(v),
                        value=v,
                    )
                )
                prev = v

    events.sort(key=lambda e: (e.s_m, 0 if e.kind == "speed_limit" else 1))
    return events


def _speed_label(v_mps: float) -> str:
    return f"{v_mps * 3.6:.0f} km/h"


def _min_envelope(*sources: float) -> float:
    """Elementwise min treating non-positive values as +inf when others are positive."""
    positive = [float(v) for v in sources if float(v) > 0.0 and math.isfinite(float(v))]
    if positive:
        return min(positive)
    vals = [float(v) for v in sources if math.isfinite(float(v))]
    return min(vals) if vals else 0.0


# Emergency posted speeds (m/s) when OSM maxspeed overlay is unavailable.
_EXPRESS_LEGAL_MPS: dict[str, float] = {
    "motorway": 130.0 / 3.6,
    "motorway_link": 110.0 / 3.6,
    "trunk": 110.0 / 3.6,
    "trunk_link": 110.0 / 3.6,
}


def apply_express_legal_heuristic(
    S: Sequence[float],
    V_legal: Sequence[float],
    highway_at: Callable[[float], str | None],
    *,
    osm_overlay_applied: bool,
) -> tuple[list[float], list[CycleGenWarning]]:
    """Force express posted limits when OSM maxspeed did not enrich the corridor.

    Without OSM, Mapbox/OSRM free-flow often misses FR:urban 50 and under/over
    classifies trunk → AVL-like 110 km/h sections never appear as V_legal.
    """
    n = min(len(S), len(V_legal))
    out = [float(V_legal[i]) for i in range(n)]
    warnings: list[CycleGenWarning] = []
    if osm_overlay_applied or n == 0:
        return out, warnings
    touched = 0
    for i in range(n):
        hw = highway_at(float(S[i]))
        if not hw:
            continue
        target = _EXPRESS_LEGAL_MPS.get(str(hw).lower())
        if target is None:
            continue
        # Replace free-flow guess with class default (snap later).
        out[i] = target
        touched += 1
    if touched:
        warnings.append(
            CycleGenWarning(
                code="express_legal_heuristic",
                message=(
                    f"OSM maxspeed absent — posted express heuristic applied "
                    f"on {touched}/{n} samples (trunk=110, motorway=130 km/h)."
                ),
                s0=float(S[0]),
                s1=float(S[-1]),
                source="spatial_processor",
            )
        )
    return out, warnings


def _build_highway_lookup(
    geometry: Sequence[LatLon],
    S: Sequence[float],
    road_structures: Sequence[RoadStructureSegment],
) -> Callable[[float], str | None]:
    """Return a callable mapping along-route s → nearest highway class."""
    intervals: list[tuple[float, float, str]] = []
    for rs in road_structures:
        if rs.kind != "highway" or not rs.highway:
            continue
        p0 = project_point_onto_polyline_ortho(geometry, S, rs.lat0, rs.lon0)
        p1 = project_point_onto_polyline_ortho(geometry, S, rs.lat1, rs.lon1)
        if p0 is None or p1 is None:
            continue
        s0, s1 = float(p0[0]), float(p1[0])
        if s0 > s1:
            s0, s1 = s1, s0
        intervals.append((s0, s1, rs.highway))

    def highway_at(s_m: float) -> str | None:
        if not intervals:
            return None
        s = float(s_m)
        containing = [h for s0, s1, h in intervals if s0 - 1.0 <= s <= s1 + 1.0]
        if containing:
            # Prefer primary/trunk if several overlap
            for pref in ("trunk", "primary"):
                if pref in containing:
                    return pref
            return containing[0]
        best_h: str | None = None
        best_d = float("inf")
        for s0, s1, h in intervals:
            if s0 <= s <= s1:
                return h
            d = min(abs(s - s0), abs(s - s1))
            if d < best_d:
                best_d = d
                best_h = h
        return best_h

    return highway_at


def _attach_highway_from_structures(
    feux: list[FeuMeta],
    highway_at: Callable[[float], str | None],
) -> list[FeuMeta]:
    out: list[FeuMeta] = []
    for f in feux:
        hw = f.highway or highway_at(float(f.s_m))
        out.append(
            FeuMeta(s_m=float(f.s_m), highway=hw, tls_mode=f.tls_mode)
        )
    return out


def _combine_speed_series(
    series: list[list[float]],
    mode: str,
) -> list[float]:
    """Combine multiple aligned V_legal series (m/s) into one.

    Ignores non-positive samples per position (a router that has no info at
    that vertex must not force the min down to zero).
    """
    if not series:
        return []
    n = min(len(s) for s in series)
    out: list[float] = []
    for i in range(n):
        vals = [
            float(s[i]) for s in series
            if i < len(s) and math.isfinite(float(s[i])) and float(s[i]) > 0.0
        ]
        if not vals:
            out.append(0.0)
            continue
        if mode == "min":
            out.append(min(vals))
        elif mode == "mean_snap":
            out.append(sum(vals) / len(vals))
        elif mode == "majority":
            bins = [int(round(v * 3.6)) for v in vals]
            counts: dict[int, int] = {}
            for b in bins:
                counts[b] = counts.get(b, 0) + 1
            best_b = bins[0]
            best_c = -1
            for b, c in counts.items():
                if c > best_c or (c == best_c and b < best_b):
                    best_c = c
                    best_b = b
            out.append(best_b / 3.6)
        else:
            out.append(min(vals))
    return out


def _combine_elevation_series(
    series: list[list[float]],
    mode: str,
) -> list[float]:
    """Combine multiple aligned Z(s) sources (m). Ignores 0.0 (missing DEM)."""
    if not series:
        return []
    n = min(len(s) for s in series)
    out: list[float] = []
    for i in range(n):
        vals = [float(s[i]) for s in series if i < len(s) and math.isfinite(float(s[i]))]
        # Drop pure 0 (DEM fallback marker) when at least one source is non-zero.
        non_zero = [v for v in vals if abs(v) > 1e-6]
        if non_zero:
            vals = non_zero
        if not vals:
            out.append(0.0)
            continue
        if mode == "min":
            out.append(min(vals))
        elif mode == "max":
            out.append(max(vals))
        else:
            out.append(sum(vals) / len(vals))
    return out


def build_spatial_corridor(
    route: RouteAnalyzeResponse,
    *,
    smooth_window: int = 11,
    smooth_polyorder: int = 3,
    signal_dedup_m: float = SIGNAL_DEDUP_M,
    a_y_mps2: float | None = None,
    max_grade: float = MAX_GRADE,
    sg_min_span_m: float = SG_MIN_SPAN_M,
    trap_length_m: float = DEFAULT_TRAP_LENGTH_M,
    alpha_min_pct: float | None = None,
    alpha_max_pct: float | None = None,
    legal_smooth_mode: str = "majority",
    legal_smooth_window_m: float = 250.0,
    legal_min_run_m: float = 120.0,
    enable_speed_limits: bool = True,
    global_max_speed_kmh: float = 130.0,
    include_traffic_in_envelope: bool = False,
    speed_sources: list[str] | None = None,
    speed_combine: str = "min",
    elevation_sources: list[str] | None = None,
    elevation_combine: str = "mean",
    speed_min_kmh: float | None = None,
    speed_max_kmh: float | None = None,
) -> SpatialCorridor:
    """
    Process RouteAnalyzeResponse into a scientific SpatialCorridor (Vague 1).

    Builds S, elevation-corrected α via fixed-length trapezoids, legal/traffic/
    curve envelopes, feux meta with TLS mode assignment, and aggregated warnings.
    """
    geometry = list(route.geometry)
    n = len(geometry)
    traffic_source = getattr(route, "traffic_source", None) or "osrm_freeflow"
    a_y = float(
        a_y_mps2
        if a_y_mps2 is not None
        else getattr(route, "a_y_mps2", None) or 3.5
    )

    if n == 0:
        return SpatialCorridor(
            S=[],
            V_limite=[],
            V_limite_legal=[],
            V_traffic=[],
            V_curve=[],
            V_envelope=[],
            alpha=[],
            elevations_m=[],
            S_feux=[],
            feux_meta=[],
            events=[],
            geometry=[],
            scheduled_stops=[],
            traffic_source=traffic_source,
            warnings=list(route.warnings or []),
            a_y_mps2=a_y,
            slope_profile=None,
        )

    S = cumulative_distance_m(geometry, route.segment_distances_m)

    # ----- Router source selection for V_legal --------------------------------
    allowed_sources = {
        str(s).strip().lower()
        for s in (speed_sources if speed_sources is not None else ["here", "mapbox", "osrm", "osm"])
    }
    router_series: dict[str, list[float]] = getattr(
        route, "segment_speeds_by_router", None
    ) or {}
    active_router_legal: list[list[float]] = []
    for key, series in router_series.items():
        if key not in allowed_sources:
            continue
        if not series or len(series) < n:
            continue
        active_router_legal.append([float(v) for v in series[:n]])

    if active_router_legal:
        V_legal = _combine_speed_series(active_router_legal, mode=speed_combine)
        V_legal = snap_legal_speeds_mps(V_legal)
    else:
        # Fallback to primary router's per-segment speeds (backwards compat).
        V_legal = snap_legal_speeds_mps(
            align_speeds_to_points(n, route.segment_speeds_mps)
        )
    # Overlay OSM posted maxspeed (agglomeration 50 / 70) on free-flow annotation.
    osm_limits = getattr(route, "osm_speed_limits", None) or []
    if "osm" not in allowed_sources:
        osm_limits = []  # respect UI toggle
    osm_warnings: list[CycleGenWarning] = []
    osm_overlay_applied = False
    if osm_limits:
        V_legal, osm_warnings = overlay_osm_maxspeed(
            S,
            geometry,
            V_legal,
            osm_limits,
            project_fn=project_point_onto_polyline_ortho,
            max_lateral_m=35.0,
        )
        V_legal = snap_legal_speeds_mps(V_legal)
        osm_overlay_applied = any(
            w.code == "osm_maxspeed_overlay" for w in osm_warnings
        )

    highway_at = _build_highway_lookup(
        geometry, S, route.road_structures or []
    )
    V_legal, express_warnings = apply_express_legal_heuristic(
        S,
        V_legal,
        highway_at,
        osm_overlay_applied=osm_overlay_applied,
    )
    if express_warnings:
        V_legal = snap_legal_speeds_mps(V_legal)

    V_legal = smooth_legal_speeds_spatial(
        S,
        V_legal,
        window_m=legal_smooth_window_m,
        mode=legal_smooth_mode,
        min_run_m=legal_min_run_m,
    )
    V_legal = snap_legal_speeds_mps(V_legal)

    traffic_segs = route.segment_traffic_speeds_mps or route.segment_speeds_mps
    V_traffic = align_speeds_to_points(n, traffic_segs)

    # ----- Elevation source combination ---------------------------------------
    allowed_elev = {
        str(s).strip().lower()
        for s in (
            elevation_sources
            if elevation_sources is not None
            else ["here", "open-meteo", "open-elevation", "opentopodata"]
        )
    }
    elev_by_source: dict[str, list[float]] = getattr(
        route, "elevations_by_source", None
    ) or {}
    active_elev: list[list[float]] = []
    for key, series in elev_by_source.items():
        if key.lower() not in allowed_elev:
            continue
        if not series or len(series) != n:
            continue
        active_elev.append([float(z) for z in series])

    if active_elev:
        base_elev = _combine_elevation_series(active_elev, mode=elevation_combine)
    else:
        base_elev = list(route.elevations_m)

    elev_corrected, topo_warnings = prepare_elevations(
        base_elev,
        S,
        geometry,
        route.road_structures or [],
        max_grade=max_grade,
    )
    # HERE Z is already road-aligned — keep a light spatial MA only.
    elev_src = (getattr(route, "elevation_source", None) or "").lower()
    z_window = (
        min(float(sg_min_span_m), 60.0)
        if elev_src == "here"
        else float(sg_min_span_m)
    )
    # Spatial MA (+ light SG) on Z before deriving θ — removes DEM sawteeth.
    elev_smooth = _optional_sg_smooth_z(
        elev_corrected,
        S,
        smooth_window,
        smooth_polyorder,
        sg_min_span_m=z_window,
    )
    # Trapezoids on already-smoothed Z (skip second smooth pass).
    _alpha_raw, traps = slope_from_elevation_trapezoids(
        elev_smooth,
        S,
        trap_length_m,
        smooth_window=0,
        smooth_polyorder=smooth_polyorder,
        sg_min_span_m=0.0,
    )
    traps, clip_warnings = clip_traps_to_grade_pct(
        traps, min_pct=alpha_min_pct, max_pct=alpha_max_pct
    )
    alpha = _alpha_from_traps(S, traps)
    spike_warnings = detect_slope_spikes(alpha, S)
    slope_profile = build_slope_profile(
        traps, elev_smooth, S, trap_length_m
    )

    # --- Envelope pipeline (strict order before IDM) ---
    # 1) Spatial median R (±75 m) then V_curve_brute = √(a_y · R_smooth)
    R = curvature_radius_m(geometry)
    V_curve = curve_speed_limit_mps(R, a_y_mps2=a_y)
    # 2) Driving-mode min: curve + Vmax [+ legal] [+ traffic]
    v_cap = max(30.0, float(global_max_speed_kmh)) / 3.6
    V_cible: list[float] = []
    for i in range(n):
        parts = [V_curve[i], v_cap]
        if enable_speed_limits:
            parts.append(V_legal[i])
        if include_traffic_in_envelope:
            parts.append(V_traffic[i])
        V_cible.append(_min_envelope(*parts) if len(parts) > 1 else parts[0])
    V_envelope = braking_feasible_speed(S, V_cible, b_plan_mps2=1.71)
    # P4 — bilateral edge-preserving smoother (C¹).
    # Removes the residual C⁰ kinks left by min(...) while preserving
    # genuine speed drops (posted-limit changes, hairpins).
    # Small MA pass at the very end guarantees no >2 km/h/m gradient.
    V_envelope = smooth_envelope_bilateral(
        S,
        V_envelope,
        tau_spatial_m=40.0,
        tau_range_mps=2.0,
    )
    V_envelope = smooth_envelope_spatial(S, V_envelope, window_m=25.0)
    # Optional user-defined clamps (km/h → m/s).
    vmax_mps = (
        float(speed_max_kmh) / 3.6
        if (speed_max_kmh is not None and float(speed_max_kmh) > 0)
        else None
    )
    vmin_mps = (
        float(speed_min_kmh) / 3.6
        if (speed_min_kmh is not None and float(speed_min_kmh) > 0)
        else None
    )
    if vmax_mps is not None or vmin_mps is not None:
        clamped: list[float] = []
        for v in V_envelope:
            vv = float(v)
            if vmax_mps is not None and vv > vmax_mps:
                vv = vmax_mps
            if vmin_mps is not None and vv < vmin_mps:
                vv = vmin_mps
            clamped.append(vv)
        V_envelope = clamped
    V_limite = list(V_envelope)

    feux, signal_warnings = project_signals_strict(
        geometry,
        S,
        route.traffic_signals,
        max_lateral_m=MAX_LATERAL_SIGNAL_M,
    )
    if signal_dedup_m != SIGNAL_DEDUP_M:
        feux = _dedup_feux_along_s(feux, dedup_m=signal_dedup_m)

    # highway_at already built above for express heuristic
    # (was: highway_at = _build_highway_lookup(...))
    feux = _attach_highway_from_structures(feux, highway_at)
    feux = assign_tls_modes(feux, highway_along_s=highway_at)

    S_feux = [float(f.s_m) for f in feux]
    scheduled_stops = project_via_stops(geometry, S, route.via_points or [])
    events = build_events(S, V_limite, S_feux, scheduled_stops)

    warnings = (
        list(route.warnings or [])
        + osm_warnings
        + express_warnings
        + topo_warnings
        + signal_warnings
        + clip_warnings
        + spike_warnings
    )

    return SpatialCorridor(
        S=S,
        V_limite=V_limite,
        V_limite_legal=V_legal,
        V_traffic=V_traffic,
        V_curve=V_curve,
        V_envelope=V_envelope,
        alpha=alpha,
        elevations_m=elev_smooth,
        S_feux=S_feux,
        feux_meta=feux,
        events=events,
        geometry=geometry,
        scheduled_stops=scheduled_stops,
        traffic_source=traffic_source,
        warnings=warnings,
        a_y_mps2=a_y,
        slope_profile=slope_profile,
    )


# ---------------------------------------------------------------------------
# Smoke / manual check
# ---------------------------------------------------------------------------


def _synthetic_route() -> RouteAnalyzeResponse:
    """Short synthetic polyline with elevation, speeds and nearby signals."""
    # ~111 m per 0.001° latitude; duplicate vertex → zero-length segment
    geometry = [
        LatLon(lat=48.8500, lon=2.3500),
        LatLon(lat=48.8505, lon=2.3500),
        LatLon(lat=48.8510, lon=2.3500),
        LatLon(lat=48.8510, lon=2.3500),  # zero dS
        LatLon(lat=48.8515, lon=2.3500),
        LatLon(lat=48.8520, lon=2.3500),
        LatLon(lat=48.8525, lon=2.3500),
        LatLon(lat=48.8530, lon=2.3500),
    ]
    segment_distances_m = [
        haversine_m(
            geometry[i].lat,
            geometry[i].lon,
            geometry[i + 1].lat,
            geometry[i + 1].lon,
        )
        for i in range(len(geometry) - 1)
    ]
    elevations_m = [10.0, 12.0, 15.0, 15.0, 18.0, 20.0, 19.0, 17.0]
    segment_speeds_mps = [13.89, 13.89, 13.89, 13.89, 8.33, 8.33, 8.33]
    traffic_signals = [
        TrafficSignalPoint(lat=48.85105, lon=2.35001, osm_id=1),
        TrafficSignalPoint(lat=48.85108, lon=2.35002, osm_id=2),  # ~same S → dedup
        TrafficSignalPoint(lat=48.8526, lon=2.3500, osm_id=3),
    ]
    return RouteAnalyzeResponse(
        geometry=geometry,
        distance_m=sum(segment_distances_m),
        duration_s=60.0,
        segment_speeds_mps=segment_speeds_mps,
        segment_distances_m=segment_distances_m,
        elevations_m=elevations_m,
        traffic_signals=traffic_signals,
        bbox=(48.85, 2.35, 48.853, 2.3501),
        road_structures=[],
        segment_traffic_speeds_mps=[],
        warnings=[],
        a_y_mps2=2.5,
    )


if __name__ == "__main__":
    route = _synthetic_route()
    corridor = build_spatial_corridor(route, smooth_window=5, smooth_polyorder=2)
    assert len(corridor.S) == len(corridor.geometry)
    assert len(corridor.alpha) == len(corridor.geometry)
    assert len(corridor.V_limite) == len(corridor.geometry)
    assert len(corridor.V_envelope) == len(corridor.geometry)
    assert len(corridor.V_limite_legal) == len(corridor.geometry)
    assert len(corridor.V_traffic) == len(corridor.geometry)
    assert len(corridor.V_curve) == len(corridor.geometry)
    assert corridor.S[0] == 0.0
    assert any(
        abs(corridor.S[i] - corridor.S[i - 1]) < MIN_DS_M
        for i in range(1, len(corridor.S))
    )
    assert len(corridor.S_feux) == 2  # two clusters after 15 m dedup
    assert len(corridor.feux_meta) == 2
    assert all(f.tls_mode in ("stochastic", "green_wave") for f in corridor.feux_meta)
    kinds = {e.kind for e in corridor.events}
    assert "traffic_signal" in kinds and "speed_limit" in kinds
    print(
        f"OK: n={len(corridor.S)} S_end={corridor.S[-1]:.1f}m "
        f"S_feux={corridor.S_feux} feux_meta={len(corridor.feux_meta)} "
        f"events={len(corridor.events)} warnings={len(corridor.warnings)}"
    )
