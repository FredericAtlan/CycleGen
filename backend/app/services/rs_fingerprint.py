"""Route Studio / trace fingerprint — pure functions (no FastAPI I/O).

CPU-light kinematics → IDM physics suggestion + SHA-256 of source bytes.
Defaults for pedal lag fields are always 0 (disabled) unless caller sets them.
"""

from __future__ import annotations

import csv
import hashlib
import io
import math
import re
from dataclasses import asdict, dataclass
from typing import Any


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _pctile(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    ys = sorted(xs)
    if len(ys) == 1:
        return ys[0]
    k = (p / 100.0) * (len(ys) - 1)
    lo = int(math.floor(k))
    hi = min(lo + 1, len(ys) - 1)
    w = k - lo
    return ys[lo] * (1.0 - w) + ys[hi] * w


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else float("nan")


def _clamp(x: float, lo: float, hi: float, *, fallback: float) -> float:
    """Clamp finite values; NaN/±inf → neutral fallback (never lo/hi edge)."""
    if not math.isfinite(x):
        return fallback
    return max(lo, min(hi, x))


@dataclass(frozen=True)
class DriverFingerprint:
    n: int
    duration_s: float
    distance_m: float
    v_mean_mps: float
    v_max_mps: float
    a_pos_p85: float
    a_pos_p95: float
    a_neg_p85: float
    a_neg_p95: float
    jerk_pos_p85: float
    jerk_neg_p85: float
    speed_factor_mean: float
    speed_factor_p90: float
    overspeed_pct: float
    dt_median: float


@dataclass(frozen=True)
class SuggestedPhysics:
    a_max: float
    b_comf: float
    speed_factor: float
    T: float
    T_h: float
    s0: float
    jerk_max: float
    jerk_brake_max: float
    # Pedal schema — defaults 0 (disabled).
    pedal_tau_s: float = 0.0
    vdes_tau_s: float = 0.0
    descent_hold_gain: float = 0.0
    a_y: float | None = None
    base_profile: str = "Normal"


def fingerprint_series(
    t: list[float],
    v: list[float],
    *,
    lim_kmh: list[float] | None = None,
    use_p85: bool = True,
) -> DriverFingerprint:
    """Fingerprint from time [s] and velocity [m/s]. Optional posted limit [km/h]."""
    n = min(len(t), len(v))
    if n < 3:
        raise ValueError("need at least 3 samples (t, v)")
    t = [float(x) for x in t[:n]]
    v = [float(x) for x in v[:n]]
    lim = (
        [float(x) for x in lim_kmh[:n]]
        if lim_kmh is not None and len(lim_kmh) >= n
        else None
    )

    a = [0.0] * n
    jerk = [0.0] * n
    for i in range(1, n):
        dt = t[i] - t[i - 1]
        a[i] = (v[i] - v[i - 1]) / dt if dt > 1e-6 else 0.0
    for i in range(1, n):
        dt = t[i] - t[i - 1]
        jerk[i] = (a[i] - a[i - 1]) / dt if dt > 1e-6 else 0.0

    a_pos = [x for x in a if x > 0.05]
    a_neg = [-x for x in a if x < -0.05]
    j_pos = [x for x in jerk if x > 0.05]
    j_neg = [-x for x in jerk if x < -0.05]
    dts = [t[i] - t[i - 1] for i in range(1, n) if t[i] > t[i - 1]]

    distance_m = 0.0
    for i in range(1, n):
        dt = max(0.0, t[i] - t[i - 1])
        distance_m += 0.5 * (v[i] + v[i - 1]) * dt

    ratios: list[float] = []
    over = moving = 0
    if lim is not None:
        for i in range(n):
            L = lim[i]
            if not math.isfinite(L) or L <= 0 or v[i] < 1.5:
                continue
            moving += 1
            r = (v[i] * 3.6) / L
            ratios.append(r)
            if r > 1.02:
                over += 1

    p_hi = 85.0 if use_p85 else 95.0
    return DriverFingerprint(
        n=n,
        duration_s=max(0.0, t[-1] - t[0]),
        distance_m=distance_m,
        v_mean_mps=_mean([x for x in v if x > 0.5]),
        v_max_mps=max(v) if v else 0.0,
        a_pos_p85=_pctile(a_pos, p_hi),
        a_pos_p95=_pctile(a_pos, 95),
        a_neg_p85=_pctile(a_neg, p_hi),
        a_neg_p95=_pctile(a_neg, 95),
        jerk_pos_p85=_pctile(j_pos, p_hi),
        jerk_neg_p85=_pctile(j_neg, p_hi),
        speed_factor_mean=_mean(ratios) if ratios else float("nan"),
        speed_factor_p90=_pctile(ratios, 90) if ratios else float("nan"),
        overspeed_pct=(100.0 * over / moving) if moving else float("nan"),
        dt_median=_pctile(dts, 50),
    )


def _estimate_tau_ar1(t: list[float], signal: list[float]) -> float:
    """First-order τ from lag-1 autocorrelation: ρ = e^(−dt/τ)."""
    n = min(len(t), len(signal))
    if n < 30:
        return 0.0
    dts = [
        t[i] - t[i - 1]
        for i in range(1, n)
        if 1e-4 < (t[i] - t[i - 1]) < 2.0
    ]
    if not dts:
        return 0.0
    dt = sum(dts) / len(dts)
    m = sum(signal[:n]) / n
    num = den = 0.0
    for i in range(1, n):
        x = signal[i] - m
        y = signal[i - 1] - m
        num += x * y
        den += x * x
    if den < 1e-12:
        return 0.0
    rho = num / den
    if rho <= 0.05 or rho >= 0.999:
        return 0.0
    try:
        tau = -dt / math.log(rho)
    except (ValueError, ZeroDivisionError):
        return 0.0
    if not math.isfinite(tau):
        return 0.0
    return round(_clamp(tau, 0.0, 10.0, fallback=0.0), 3)


def _estimate_hold_from_coast(t: list[float], v: list[float], a: list[float]) -> float:
    """Soft coast fraction while rolling → descent_hold_gain proxy."""
    n = min(len(t), len(v), len(a))
    moving = coast = 0.0
    for i in range(1, n):
        dt = max(0.0, t[i] - t[i - 1])
        if v[i] <= 3.0:
            continue
        moving += dt
        if -0.6 < a[i] < -0.05:
            coast += dt
    if moving < 1.0:
        return 0.0
    return round(_clamp(4.0 * (coast / moving), 0.0, 10.0, fallback=0.0), 3)


def suggest_physics(
    fp: DriverFingerprint,
    *,
    t: list[float] | None = None,
    a: list[float] | None = None,
    v: list[float] | None = None,
) -> SuggestedPhysics:
    """Map fingerprint → full IDM physics (incl. τ / hold when series given)."""
    a_src = fp.a_pos_p85 if math.isfinite(fp.a_pos_p85) else fp.a_pos_p95
    a_max = _clamp(a_src, 0.6, 7.5, fallback=2.0)
    b_src = fp.a_neg_p85 if math.isfinite(fp.a_neg_p85) else fp.a_neg_p95
    b_comf = _clamp(b_src, 0.8, 9.0, fallback=2.0)
    j_src = fp.jerk_pos_p85 if math.isfinite(fp.jerk_pos_p85) else 1.5
    jerk_max = _clamp(j_src, 0.3, 8.0, fallback=1.5)
    jb_src = fp.jerk_neg_p85 if math.isfinite(fp.jerk_neg_p85) else jerk_max
    jerk_brake = _clamp(jb_src, 0.3, 10.0, fallback=jerk_max)
    sf = fp.speed_factor_p90 if math.isfinite(fp.speed_factor_p90) else (
        fp.speed_factor_mean if math.isfinite(fp.speed_factor_mean) else 1.05
    )
    sf = _clamp(round(sf, 3), 0.7, 1.35, fallback=1.05)

    # Headway heuristic from aggressiveness
    if a_max >= 2.2:
        T, T_h, s0, base = 1.2, 3.0, 1.8, "Dynamique"
    elif a_max <= 1.4:
        T, T_h, s0, base = 1.8, 4.5, 2.8, "Prudent"
    else:
        T, T_h, s0, base = 1.5, 3.5, 2.0, "Normal"

    pedal_tau = 0.0
    vdes_tau = 0.0
    hold = 0.0
    if t is not None and a is not None and len(t) >= 30 and len(a) >= 30:
        pedal_tau = _estimate_tau_ar1(t, a)
        soft = [x if abs(x) < 0.8 else 0.0 for x in a]
        vdes_tau = max(round(pedal_tau * 0.85, 3), _estimate_tau_ar1(t, soft))
        if v is not None:
            hold = _estimate_hold_from_coast(t, v, a)

    # Lateral comfort from style bucket (corridor a_y)
    if base == "Dynamique":
        a_y = 4.9
    elif base == "Prudent":
        a_y = 3.27
    else:
        a_y = 3.5
    if a_max >= 3.2:
        a_y = max(a_y, 4.5)
    elif a_max <= 1.4:
        a_y = min(a_y, 2.5)

    return SuggestedPhysics(
        a_max=round(a_max, 3),
        b_comf=round(b_comf, 3),
        speed_factor=sf,
        T=T,
        T_h=T_h,
        s0=s0,
        jerk_max=round(jerk_max, 3),
        jerk_brake_max=round(jerk_brake, 3),
        pedal_tau_s=pedal_tau,
        vdes_tau_s=vdes_tau,
        descent_hold_gain=hold,
        a_y=round(a_y, 3),
        base_profile=base,
    )


def aggregate_fingerprints(
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    """Aggregate multi-file fingerprints → Prudent / Dynamique / PreA-ish.

    Each item: ``{"style": "prudent"|"dynamique"|..., "fingerprint": {...}}``.
    """

    def bucket(style: str) -> list[dict[str, Any]]:
        out = []
        for it in items:
            st = str(it.get("style") or "").lower()
            if style == "prudent" and ("prudent" in st or "eco" in st):
                out.append(it.get("fingerprint") or {})
            elif style == "dynamique" and (
                "dynam" in st or "sport" in st or "agress" in st
            ):
                out.append(it.get("fingerprint") or {})
            elif style == "prea" and ("prea" in st or "pre-a" in st or "pre_a" in st):
                out.append(it.get("fingerprint") or {})
        return out

    def agg_key(rows: list[dict[str, Any]], key: str) -> float:
        xs: list[float] = []
        for r in rows:
            if key not in r:
                continue
            try:
                x = float(r[key])
            except (TypeError, ValueError):
                raise ValueError("invalid fingerprint numeric field") from None
            if math.isfinite(x):
                xs.append(x)
        return round(_mean(xs), 3) if xs else float("nan")

    def pack(style: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
        if not rows:
            return {"n": 0}
        a_max = agg_key(rows, "a_pos_p85")
        if not math.isfinite(a_max):
            a_max = agg_key(rows, "a_pos_p95")
        b = agg_key(rows, "a_neg_p85")
        if not math.isfinite(b):
            b = agg_key(rows, "a_neg_p95")
        sf = agg_key(rows, "speed_factor_p90")
        if not math.isfinite(sf):
            sf = agg_key(rows, "speed_factor_mean")
        fp_stub = DriverFingerprint(
            n=0,
            duration_s=0,
            distance_m=0,
            v_mean_mps=0,
            v_max_mps=0,
            a_pos_p85=a_max,
            a_pos_p95=a_max,
            a_neg_p85=b,
            a_neg_p95=b,
            jerk_pos_p85=agg_key(rows, "jerk_pos_p85"),
            jerk_neg_p85=agg_key(rows, "jerk_neg_p85"),
            speed_factor_mean=sf,
            speed_factor_p90=sf,
            overspeed_pct=float("nan"),
            dt_median=float("nan"),
        )
        phys = suggest_physics(fp_stub)
        return {
            "n": len(rows),
            "style": style,
            "physics": asdict(phys),
            "fingerprint_means": {
                "a_pos_p85": a_max,
                "a_neg_p85": b,
                "jerk_pos_p85": agg_key(rows, "jerk_pos_p85"),
                "jerk_neg_p85": agg_key(rows, "jerk_neg_p85"),
                "speed_factor_p90": sf,
            },
        }

    return {
        "prudent": pack("prudent", bucket("prudent")),
        "dynamique": pack("dynamique", bucket("dynamique")),
        "prea": pack("prea", bucket("prea")),
    }


_T_ALIASES = (
    "t",
    "time",
    "temps",
    "temps [s]",
    "temps_s",
    "time_s",
    "time [s]",
)
# Prefer realized / measured over setpoint when both exist (ordered).
_VKMH_ALIASES = (
    "vitesse realized",
    "vitesse réalisée",
    "vitesse realisee",
    "velocity realized",
    "v_realized",
    "v_real",
    "speed realized",
    "velocity [km/h]",
    "v_kmh",
    "speed_kmh",
    "speed [km/h]",
    "vitesse",
    "vitesse sp",  # setpoint — last resort if alone
    "vitesse_sp",
)
_V_ALIASES = (
    "v",
    "velocity",
    "velocity [m/s]",
    "speed_mps",
    "v_mps",
)
_LIM_ALIASES = (
    "lim",
    "spd_lim [km/h]",
    "speed_limit",
    "v_lim",
    "posted_kmh",
    "vitesse sp",
    "vitesse_sp",
    "v_sp",
    "setpoint",
)

_MAX_PROFILE_POINTS = 12_000
_MAX_ROWS_SCANNED = 50_000


def _reject_if_over_max_points(n: int) -> None:
    if n > _MAX_PROFILE_POINTS:
        raise ValueError(
            f"series has {n} points; max {_MAX_PROFILE_POINTS}"
        )


def _reject_if_over_row_scan_budget(rows_scanned: int) -> None:
    if rows_scanned > _MAX_ROWS_SCANNED:
        raise ValueError(
            f"exceeded row scan budget ({_MAX_ROWS_SCANNED} rows)"
        )


def _norm_header(h: str) -> str:
    return re.sub(r"\s+", " ", h.strip().lower())


def _looks_like_unit_row(cells: list[Any]) -> bool:
    """PreA / Route Studio often put units on row 2: s, kph, %."""
    unitish = 0
    numeric = 0
    for c in cells:
        if c is None or c == "":
            continue
        if isinstance(c, (int, float)) and not isinstance(c, bool):
            numeric += 1
            continue
        s = str(c).strip().lower()
        if s in {"s", "sec", "ms", "kph", "km/h", "kmh", "m/s", "mps", "%", "pct", "-"}:
            unitish += 1
        else:
            try:
                float(s.replace(",", "."))
                numeric += 1
            except ValueError:
                unitish += 1
    return unitish >= 1 and numeric == 0


def _resolve_tv_columns(
    headers: list[str],
    *,
    col_t: int | None = None,
    col_v: int | None = None,
    v_unit: str | None = None,
) -> tuple[int, int, str]:
    """Return (t_idx, v_idx, v_unit) with v_unit in {mps, kmh}."""
    col = {_norm_header(h): i for i, h in enumerate(headers) if h}

    def find(aliases: tuple[str, ...]) -> int | None:
        for a in aliases:
            k = _norm_header(a)
            if k in col:
                return col[k]
        # substring soft match (min length 4 to avoid "v"/"t" false positives)
        for a in aliases:
            k = _norm_header(a)
            if len(k) < 4:
                continue
            for h, i in col.items():
                if k in h:
                    return i
        return None

    ti = col_t if col_t is not None else find(_T_ALIASES)
    if ti is None:
        raise ValueError(f"time column not found; headers={headers}")

    unit = (v_unit or "").lower().strip()
    if col_v is not None:
        vi = col_v
        if unit not in ("mps", "kmh"):
            # infer from header name
            hn = _norm_header(headers[vi]) if vi < len(headers) else ""
            unit = (
                "kmh"
                if any(x in hn for x in ("kmh", "km/h", "kph", "vitesse"))
                else "mps"
            )
    else:
        vi_kmh = find(_VKMH_ALIASES)
        vi_mps = find(_V_ALIASES)
        if vi_kmh is not None:
            vi = vi_kmh
            unit = "kmh"
        elif vi_mps is not None:
            vi = vi_mps
            unit = "mps"
        else:
            raise ValueError(f"velocity column not found; headers={headers}")
    if vi == ti:
        raise ValueError("time and velocity columns must differ")
    if unit not in ("mps", "kmh"):
        unit = "kmh"
    return ti, vi, unit


def _rows_to_series(
    headers: list[str],
    data_rows: list[list[Any]],
    *,
    col_t: int | None = None,
    col_v: int | None = None,
    v_unit: str | None = None,
    col_lim: int | None = None,
) -> dict[str, list[float]]:
    ti, vi, unit = _resolve_tv_columns(
        headers, col_t=col_t, col_v=col_v, v_unit=v_unit
    )
    if col_lim is None:
        col = {_norm_header(h): i for i, h in enumerate(headers) if h}
        for a in _LIM_ALIASES:
            k = _norm_header(a)
            if k in col and col[k] not in (ti, vi):
                col_lim = col[k]
                break

    t: list[float] = []
    v: list[float] = []
    lim: list[float] = []
    rows_scanned = 0
    for row in data_rows:
        rows_scanned += 1
        _reject_if_over_row_scan_budget(rows_scanned)
        if ti >= len(row) or vi >= len(row):
            continue
        try:
            tv = float(row[ti])
            vv = float(row[vi])
            if unit == "kmh":
                vv = vv / 3.6
        except (TypeError, ValueError):
            continue
        if not math.isfinite(tv) or not math.isfinite(vv):
            continue
        t.append(tv)
        v.append(vv)
        _reject_if_over_max_points(len(t))
        if col_lim is not None and col_lim < len(row):
            try:
                lim.append(float(row[col_lim]))
            except (TypeError, ValueError):
                lim.append(float("nan"))
    if len(t) < 3:
        raise ValueError("table yielded < 3 valid samples")
    out: dict[str, list[float]] = {"t": t, "v": v}
    if lim:
        out["lim"] = lim
    return out


def parse_series_xlsx(
    data: bytes,
    *,
    col_t: int | None = None,
    col_v: int | None = None,
    v_unit: str | None = None,
) -> dict[str, list[float]]:
    """Parse .xlsx (openpyxl) — PreA Temps / Vitesse realized supported."""
    try:
        from openpyxl import load_workbook
    except ImportError as exc:
        raise ValueError("openpyxl not installed — cannot parse .xlsx") from exc

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sh = wb[wb.sheetnames[0]]
    raw_rows: list[list[Any]] = []
    for r in sh.iter_rows(values_only=True):
        raw_rows.append(list(r))
        _reject_if_over_row_scan_budget(len(raw_rows))
        if len(raw_rows) > _MAX_ROWS_SCANNED:
            break
    if len(raw_rows) < 2:
        raise ValueError(".xlsx has no data rows")

    headers = [str(c) if c is not None else "" for c in raw_rows[0]]
    body = raw_rows[1:]
    if body and _looks_like_unit_row(body[0]):
        body = body[1:]
    return _rows_to_series(
        headers, body, col_t=col_t, col_v=col_v, v_unit=v_unit
    )


def preview_table_bytes(
    raw: bytes,
    filename: str | None = None,
    *,
    max_preview_rows: int = 12,
) -> dict[str, Any]:
    """Return headers + sample rows + suggested time/speed column mapping."""
    name = (filename or "").lower()
    headers: list[str] = []
    units: list[str] | None = None
    sample: list[list[Any]] = []
    n_rows = 0

    if name.endswith(".xlsx") or (
        not name.endswith(".xls") and raw[:2] == b"PK"
    ):
        try:
            from openpyxl import load_workbook
        except ImportError as exc:
            raise ValueError("openpyxl not installed") from exc
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        sh = wb[wb.sheetnames[0]]
        raw_rows: list[list[Any]] = []
        for r in sh.iter_rows(values_only=True):
            raw_rows.append(list(r))
            if len(raw_rows) > _MAX_ROWS_SCANNED:
                break
        if not raw_rows:
            raise ValueError("empty workbook")
        headers = [str(c) if c is not None else f"col_{i}" for i, c in enumerate(raw_rows[0])]
        body = raw_rows[1:]
        if body and _looks_like_unit_row(body[0]):
            units = [str(c) if c is not None else "" for c in body[0]]
            body = body[1:]
        n_rows = len(body)
        sample = [
            [None if c is None else (float(c) if isinstance(c, (int, float)) and not isinstance(c, bool) else str(c)) for c in row[: len(headers)]]
            for row in body[:max_preview_rows]
        ]
    elif name.endswith(".xls"):
        try:
            import xlrd
        except ImportError as exc:
            raise ValueError("xlrd not installed") from exc
        wb = xlrd.open_workbook(file_contents=raw)
        sh = wb.sheet_by_index(0)
        headers = [str(sh.cell_value(0, c)) for c in range(sh.ncols)]
        start = 1
        if sh.nrows > 1:
            unit_cells = [sh.cell_value(1, c) for c in range(sh.ncols)]
            if _looks_like_unit_row(unit_cells):
                units = [str(c) for c in unit_cells]
                start = 2
        n_rows = max(0, sh.nrows - start)
        for r in range(start, min(sh.nrows, start + max_preview_rows)):
            sample.append(
                [
                    float(sh.cell_value(r, c))
                    if isinstance(sh.cell_value(r, c), (int, float))
                    else str(sh.cell_value(r, c))
                    for c in range(sh.ncols)
                ]
            )
    else:
        # CSV / text
        text = raw.decode("utf-8", errors="replace")
        reader = csv.reader(io.StringIO(text))
        rows = list(reader)
        if not rows:
            raise ValueError("empty CSV")
        headers = [str(c) for c in rows[0]]
        body = rows[1:]
        if body and _looks_like_unit_row(body[0]):
            units = [str(c) for c in body[0]]
            body = body[1:]
        n_rows = len(body)
        sample = body[:max_preview_rows]

    suggested_t: int | None = None
    suggested_v: int | None = None
    suggested_unit = "kmh"
    try:
        suggested_t, suggested_v, suggested_unit = _resolve_tv_columns(headers)
    except ValueError:
        pass

    return {
        "filename": filename,
        "headers": headers,
        "units": units,
        "n_data_rows": n_rows,
        "preview_rows": sample,
        "suggested": {
            "col_t": suggested_t,
            "col_v": suggested_v,
            "v_unit": suggested_unit,
        },
    }


def parse_series_csv(text: str) -> dict[str, list[float]]:
    """Parse CSV with flexible headers → ``t``, ``v`` (m/s), optional ``lim``."""
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError("CSV has no header row")
    fields = {_norm_header(f): f for f in reader.fieldnames if f}

    def find(aliases: tuple[str, ...]) -> str | None:
        for a in aliases:
            key = _norm_header(a)
            if key in fields:
                return fields[key]
        return None

    col_t = find(_T_ALIASES)
    col_v = find(_V_ALIASES)
    col_vkmh = find(_VKMH_ALIASES)
    col_lim = find(_LIM_ALIASES)
    if not col_t or (not col_v and not col_vkmh):
        raise ValueError(
            f"CSV needs time + velocity columns; got {list(fields)}"
        )

    t: list[float] = []
    v: list[float] = []
    lim: list[float] = []
    rows_scanned = 0
    for row in reader:
        rows_scanned += 1
        _reject_if_over_row_scan_budget(rows_scanned)
        try:
            ti = float(row[col_t])  # type: ignore[index]
            if col_v:
                vi = float(row[col_v])  # type: ignore[index]
            else:
                vi = float(row[col_vkmh]) / 3.6  # type: ignore[index]
        except (TypeError, ValueError, KeyError):
            continue
        if not math.isfinite(ti) or not math.isfinite(vi):
            continue
        t.append(ti)
        v.append(vi)
        _reject_if_over_max_points(len(t))
        if col_lim:
            try:
                lim.append(float(row[col_lim]))
            except (TypeError, ValueError, KeyError):
                lim.append(float("nan"))
    if len(t) < 3:
        raise ValueError("CSV yielded < 3 valid samples")
    out: dict[str, list[float]] = {"t": t, "v": v}
    if lim:
        out["lim"] = lim
    return out


def parse_series_xls(
    data: bytes,
    *,
    col_t: int | None = None,
    col_v: int | None = None,
    v_unit: str | None = None,
) -> dict[str, list[float]]:
    """Minimal Route Studio / generic .xls via xlrd (t + v required)."""
    try:
        import xlrd
    except ImportError as exc:
        raise ValueError("xlrd not installed — cannot parse .xls") from exc

    wb = xlrd.open_workbook(file_contents=data)
    sh = wb.sheet_by_index(0)
    headers = [str(sh.cell_value(0, c)) for c in range(sh.ncols)]
    start = 1
    if sh.nrows > 1 and _looks_like_unit_row(
        [sh.cell_value(1, c) for c in range(sh.ncols)]
    ):
        start = 2
    body: list[list[Any]] = []
    for r in range(start, sh.nrows):
        body.append([sh.cell_value(r, c) for c in range(sh.ncols)])
        _reject_if_over_row_scan_budget(len(body))
    return _rows_to_series(
        headers, body, col_t=col_t, col_v=col_v, v_unit=v_unit
    )


def fingerprint_payload(
    *,
    raw: bytes | None = None,
    filename: str | None = None,
    series: dict[str, list[float]] | None = None,
    use_p85: bool = True,
    col_t: int | None = None,
    col_v: int | None = None,
    v_unit: str | None = None,
) -> dict[str, Any]:
    """Unified entry: bytes and/or series → fingerprint + suggested physics + sha256."""
    source_sha256 = sha256_bytes(raw) if raw is not None else None
    parsed = series
    if parsed is None:
        if raw is None:
            raise ValueError("provide file bytes or series")
        name = (filename or "").lower()
        is_json = name.endswith(".json") or raw[:1] in (b"{", b"[")
        if is_json:
            import json

            obj = json.loads(raw.decode("utf-8"))
            if isinstance(obj, dict) and "t" in obj and "v" in obj:
                t_raw = obj["t"]
                v_raw = obj["v"]
                if not isinstance(t_raw, list) or not isinstance(v_raw, list):
                    raise ValueError("JSON series must contain t and v arrays")
                _reject_if_over_max_points(len(t_raw))
                _reject_if_over_max_points(len(v_raw))
                t_parsed: list[float] = []
                v_parsed: list[float] = []
                for x in t_raw:
                    t_parsed.append(float(x))
                    _reject_if_over_max_points(len(t_parsed))
                for x in v_raw:
                    v_parsed.append(float(x))
                    _reject_if_over_max_points(len(v_parsed))
                parsed = {"t": t_parsed, "v": v_parsed}
                if "lim" in obj:
                    lim_raw = obj["lim"]
                    if not isinstance(lim_raw, list):
                        raise ValueError("JSON lim must be an array")
                    _reject_if_over_max_points(len(lim_raw))
                    lim_parsed: list[float] = []
                    for x in lim_raw:
                        lim_parsed.append(float(x))
                        _reject_if_over_max_points(len(lim_parsed))
                    parsed["lim"] = lim_parsed
            else:
                raise ValueError("JSON series must contain t and v arrays")
        elif name.endswith(".xlsx") or (
            not name.endswith((".xls", ".csv", ".json")) and raw[:2] == b"PK"
        ):
            parsed = parse_series_xlsx(
                raw, col_t=col_t, col_v=col_v, v_unit=v_unit
            )
        elif name.endswith(".xls"):
            parsed = parse_series_xls(
                raw, col_t=col_t, col_v=col_v, v_unit=v_unit
            )
        elif name.endswith(".csv") or b"," in raw[:200]:
            text = raw.decode("utf-8", errors="replace")
            if col_t is not None or col_v is not None:
                reader = csv.reader(io.StringIO(text))
                rows = list(reader)
                if not rows:
                    raise ValueError("empty CSV")
                headers = [str(c) for c in rows[0]]
                body: list[list[Any]] = rows[1:]
                if body and _looks_like_unit_row(body[0]):
                    body = body[1:]
                parsed = _rows_to_series(
                    headers, body, col_t=col_t, col_v=col_v, v_unit=v_unit
                )
            else:
                parsed = parse_series_csv(text)
        else:
            # try CSV then xls / xlsx
            try:
                parsed = parse_series_csv(raw.decode("utf-8", errors="replace"))
            except Exception:
                try:
                    parsed = parse_series_xlsx(
                        raw, col_t=col_t, col_v=col_v, v_unit=v_unit
                    )
                except Exception:
                    parsed = parse_series_xls(
                        raw, col_t=col_t, col_v=col_v, v_unit=v_unit
                    )

    n_pts = len(parsed["t"])
    if n_pts > _MAX_PROFILE_POINTS:
        raise ValueError(
            f"series has {n_pts} points; max {_MAX_PROFILE_POINTS}"
        )

    fp = fingerprint_series(
        parsed["t"],
        parsed["v"],
        lim_kmh=parsed.get("lim"),
        use_p85=use_p85,
    )
    t_s = [float(x) for x in parsed["t"][: fp.n]]
    v_s = [float(x) for x in parsed["v"][: fp.n]]
    a_s = [0.0] * fp.n
    for i in range(1, fp.n):
        dt = t_s[i] - t_s[i - 1]
        a_s[i] = (v_s[i] - v_s[i - 1]) / dt if dt > 1e-6 else 0.0
    if fp.n > 1:
        a_s[0] = a_s[1]
    phys = suggest_physics(fp, t=t_s, a=a_s, v=v_s)
    # Keep a downsampled copy of the identifying series for library / compare.
    max_store = 400
    if fp.n <= max_store:
        t_store, v_store = t_s, v_s
    else:
        step = max(1, fp.n // max_store)
        idxs = list(range(0, fp.n, step))
        if idxs[-1] != fp.n - 1:
            idxs.append(fp.n - 1)
        t_store = [t_s[i] for i in idxs]
        v_store = [v_s[i] for i in idxs]
    return {
        "source_sha256": source_sha256,
        "filename": filename,
        "n_points": fp.n,
        "fingerprint": asdict(fp),
        "physics": asdict(phys),
        "pedal_defaults": {
            "pedal_tau_s": phys.pedal_tau_s,
            "vdes_tau_s": phys.vdes_tau_s,
            "descent_hold_gain": phys.descent_hold_gain,
        },
        "source_profile": {
            "time": t_store,
            "velocity_mps": v_store,
            "n_raw": fp.n,
        },
    }
