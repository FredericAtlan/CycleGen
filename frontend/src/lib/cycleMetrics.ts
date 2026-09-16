/** Stats + derived series for cycle library / comparison. */

import type { ConsolidatedProfile, LatLon, SpatialCorridor } from "./types";
import { slopeFromRad } from "./units";

export type CycleStats = {
  duration_s: number;
  distance_m: number;
  v_mean_kmh: number;
  v_max_kmh: number;
  v_min_kmh: number;
  a_lon_max_mps2: number;
  a_lon_min_mps2: number;
  a_lon_mean_accel_mps2: number | null;
  a_lon_mean_decel_mps2: number | null;
  a_lat_max_mps2: number | null;
  slope_mean_pct: number | null;
  slope_max_pct: number | null;
  slope_min_pct: number | null;
};

function sampleAtS(S: number[], values: number[], s: number): number {
  if (!S.length || !values.length) return Number.NaN;
  if (s <= S[0]) return values[0];
  if (s >= S[S.length - 1]) return values[values.length - 1];
  let lo = 0;
  let hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  const ds = S[hi] - S[lo];
  if (ds < 1e-9) return values[lo];
  const u = (s - S[lo]) / ds;
  return values[lo] + u * (values[hi] - values[lo]);
}

/**
 * Piecewise-constant sample (hold left segment) — correct for posted
 * speed limits which jump 30→50, never 37.4.
 */
export function sampleAtSHold(S: number[], values: number[], s: number): number {
  if (!S.length || !values.length) return Number.NaN;
  if (s <= S[0]) return values[0];
  if (s >= S[S.length - 1]) return values[values.length - 1];
  let lo = 0;
  let hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  return values[lo];
}

/** Common European / FR posted limits (km/h). */
const POSTED_SPEED_KMH = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130,
] as const;

/**
 * Snap free-flow / interpolated speeds to a posted sign when close;
 * otherwise round to the nearest 5 km/h (never leave 47.3 on a "legal" layer).
 */
export function snapPostedSpeedKmh(kmh: number): number {
  if (!Number.isFinite(kmh) || kmh <= 0) return kmh;
  let best: number = POSTED_SPEED_KMH[0];
  let bestD = Math.abs(best - kmh);
  for (const p of POSTED_SPEED_KMH) {
    const d = Math.abs(p - kmh);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (bestD <= 4.5) return best;
  return Math.round(kmh / 5) * 5;
}

export function legalSpeedKmhFromMps(mps: number): number {
  return snapPostedSpeedKmh(mps * 3.6);
}

/** Approximate lateral accel a_y·(v/V_curve)² when curve envelope is known. */
export function lateralAccelFromCorridor(
  profile: ConsolidatedProfile,
  corridor: SpatialCorridor | null | undefined,
  aY: number
): number[] {
  const n = profile.time.length;
  const out = Array.from({ length: n }, () => 0);
  const Vcurve = corridor?.V_curve;
  const S = corridor?.S;
  if (!Vcurve?.length || !S?.length || aY <= 0) return out;
  for (let i = 0; i < n; i++) {
    const s = profile.position[i] ?? 0;
    const v = profile.velocity[i] ?? 0;
    const vc = sampleAtS(S, Vcurve, s);
    if (!(vc > 0.5) || !Number.isFinite(vc)) {
      out[i] = 0;
      continue;
    }
    out[i] = (v * v * aY) / (vc * vc);
  }
  return out;
}

const EARTH_R_M = 6_371_000;
const MIN_R_M = 40;
const MAX_R_M = 50_000;
const CURVATURE_CHORD_M = 25;
const R_SMOOTH_WINDOW_M = 150;

function toLocalXy(
  lat0: number,
  lon0: number,
  lat: number,
  lon: number
): { x: number; y: number } {
  const φ0 = (lat0 * Math.PI) / 180;
  const φ = (lat * Math.PI) / 180;
  const λ0 = (lon0 * Math.PI) / 180;
  const λ = (lon * Math.PI) / 180;
  return {
    x: (λ - λ0) * Math.cos(φ0) * EARTH_R_M,
    y: (φ - φ0) * EARTH_R_M,
  };
}

function circumradiusM(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number }
): number {
  const a = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const b = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const c = Math.hypot(p2.x - p0.x, p2.y - p0.y);
  if (a < 1e-3 || b < 1e-3 || c < 1e-3) return MAX_R_M;
  const area2 = Math.abs(
    p0.x * (p1.y - p2.y) + p1.x * (p2.y - p0.y) + p2.x * (p0.y - p1.y)
  );
  if (area2 < 1e-6) return MAX_R_M;
  const r = (a * b * c) / (2 * area2);
  return Math.min(MAX_R_M, Math.max(MIN_R_M, r));
}

function neighborIndex(
  cumS: number[],
  i: number,
  targetM: number,
  forward: boolean
): number {
  const n = cumS.length;
  if (forward) {
    let j = i + 1;
    while (j < n - 1 && cumS[j] - cumS[i] < targetM) j += 1;
    return Math.min(n - 1, j);
  }
  let j = i - 1;
  while (j > 0 && cumS[i] - cumS[j] < targetM) j -= 1;
  return Math.max(0, j);
}

function median(vals: number[]): number {
  if (!vals.length) return MAX_R_M;
  const a = vals.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/**
 * Road curvature along corridor: R(s) (m) and signed κ=±1/R (1/m).
 * Spatial chord (~25 m) + median window 150 m — same spirit as backend Module A.
 */
export function curvatureAlongCorridor(
  corridor: SpatialCorridor | null | undefined
): { S: number[]; R_m: number[]; kappa_1_per_m: number[] } | null {
  const S = corridor?.S;
  const geometry = corridor?.geometry;
  if (!S?.length || !geometry?.length || geometry.length < 3) return null;
  const n = Math.min(S.length, geometry.length);
  const lat0 = geometry[0].lat;
  const lon0 = geometry[0].lon;
  const xy = geometry.slice(0, n).map((p) =>
    toLocalXy(lat0, lon0, p.lat, p.lon)
  );
  const cumS = S.slice(0, n).map(Number);
  const Rraw = Array.from({ length: n }, () => MAX_R_M);
  const sign = Array.from({ length: n }, () => 1);

  for (let i = 1; i < n - 1; i++) {
    let i0 = neighborIndex(cumS, i, CURVATURE_CHORD_M, false);
    let i2 = neighborIndex(cumS, i, CURVATURE_CHORD_M, true);
    if (i0 === i || i2 === i) {
      i0 = i - 1;
      i2 = i + 1;
    }
    Rraw[i] = circumradiusM(xy[i0], xy[i], xy[i2]);
    const cross =
      (xy[i].x - xy[i0].x) * (xy[i2].y - xy[i].y) -
      (xy[i].y - xy[i0].y) * (xy[i2].x - xy[i].x);
    sign[i] = cross >= 0 ? 1 : -1;
  }
  Rraw[0] = Rraw[1];
  Rraw[n - 1] = Rraw[n - 2];
  sign[0] = sign[1];
  sign[n - 1] = sign[n - 2];

  const half = R_SMOOTH_WINDOW_M * 0.5;
  const R_m: number[] = [];
  const kappa_1_per_m: number[] = [];
  let j0 = 0;
  let j1 = 0;
  for (let i = 0; i < n; i++) {
    const si = cumS[i];
    while (j0 < n && cumS[j0] < si - half) j0 += 1;
    if (j1 < j0) j1 = j0;
    while (j1 < n && cumS[j1] <= si + half) j1 += 1;
    const window = Rraw.slice(j0, j1);
    const r = Math.min(MAX_R_M, Math.max(MIN_R_M, median(window)));
    R_m.push(r);
    kappa_1_per_m.push(sign[i] / r);
  }
  return { S: cumS, R_m, kappa_1_per_m };
}

/** Sample corridor curvature onto a driving profile (same S abscissa). */
export function sampleCurvatureAlongProfile(
  profile: ConsolidatedProfile,
  corridor: SpatialCorridor | null | undefined
): { R_m: number[]; kappa_1_per_m: number[] } | null {
  const series = curvatureAlongCorridor(corridor);
  if (!series) return null;
  const n = profile.time.length;
  const R_m: number[] = [];
  const kappa_1_per_m: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = profile.position[i] ?? 0;
    R_m.push(sampleAtS(series.S, series.R_m, s));
    kappa_1_per_m.push(sampleAtS(series.S, series.kappa_1_per_m, s));
  }
  return { R_m, kappa_1_per_m };
}

/**
 * Lateral acceleration from GPS polyline: a_lat = ± v² / R
 * (R = circumradius of consecutive triplets; sign = turn direction).
 */
export function lateralAccelFromGps(
  velocity: number[],
  lat: number[] | null | undefined,
  lon: number[] | null | undefined
): number[] {
  const n = velocity.length;
  const out = Array.from({ length: n }, () => 0);
  if (
    n < 3 ||
    !lat ||
    !lon ||
    lat.length !== n ||
    lon.length !== n ||
    !Number.isFinite(lat[0]) ||
    !Number.isFinite(lon[0])
  ) {
    return out;
  }

  const xy = lat.map((la, i) => toLocalXy(lat[0], lon[0], la, lon[i]));
  const R = Array.from({ length: n }, () => MAX_R_M);
  const sign = Array.from({ length: n }, () => 1);

  for (let i = 1; i < n - 1; i++) {
    R[i] = circumradiusM(xy[i - 1], xy[i], xy[i + 1]);
    const cross =
      (xy[i].x - xy[i - 1].x) * (xy[i + 1].y - xy[i].y) -
      (xy[i].y - xy[i - 1].y) * (xy[i + 1].x - xy[i].x);
    sign[i] = cross >= 0 ? 1 : -1;
  }
  R[0] = R[1];
  R[n - 1] = R[n - 2];
  sign[0] = sign[1];
  sign[n - 1] = sign[n - 2];

  // Moving-average smooth on R (digitization noise)
  const Rs = R.slice();
  const w = Math.min(7, n);
  const half = Math.floor(w / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= n) continue;
      sum += R[j];
      c += 1;
    }
    Rs[i] = Math.min(MAX_R_M, Math.max(MIN_R_M, sum / Math.max(c, 1)));
  }

  for (let i = 0; i < n; i++) {
    const v = velocity[i] ?? 0;
    out[i] = sign[i] * ((v * v) / Rs[i]);
  }

  // Light 3-pt smooth on a_lat
  const sm = out.slice();
  for (let i = 1; i < n - 1; i++) {
    sm[i] = 0.25 * out[i - 1] + 0.5 * out[i] + 0.25 * out[i + 1];
  }
  return sm;
}

/** Fill missing accel / slope / a_lat when uploading a geo cycle. */
export function enrichSeriesFromGps(args: {
  time: number[];
  velocity: number[];
  acceleration?: number[] | null;
  a_lat?: number[] | null;
  slope?: number[] | null;
  position?: number[] | null;
  lat?: number[] | null;
  lon?: number[] | null;
  /** Slope already in radians; if values look like %, convert. */
  slopeIsPercent?: boolean;
}): {
  acceleration: number[];
  slope: number[];
  position: number[];
  a_lat: number[];
  geometry: LatLon[];
} {
  const n = args.time.length;
  const velocity = args.velocity;

  const acceleration =
    args.acceleration && args.acceleration.length === n
      ? args.acceleration.slice()
      : (() => {
          const a: number[] = [0];
          for (let i = 1; i < n; i++) {
            const dt = Math.max(args.time[i] - args.time[i - 1], 1e-6);
            a.push((velocity[i] - velocity[i - 1]) / dt);
          }
          return a;
        })();

  const positionSpan =
    args.position && args.position.length === n
      ? Math.abs(args.position[n - 1] - args.position[0])
      : 0;
  const position =
    args.position && args.position.length === n && positionSpan > 1e-3
      ? args.position.slice()
      : (() => {
          const s = [0];
          for (let i = 1; i < n; i++) {
            const dt = Math.max(args.time[i] - args.time[i - 1], 1e-6);
            s.push(s[i - 1] + 0.5 * (velocity[i] + velocity[i - 1]) * dt);
          }
          return s;
        })();

  let slopeRad: number[];
  if (args.slope && args.slope.length === n) {
    const maxAbs = Math.max(...args.slope.map((x) => Math.abs(x)));
    const asPercent =
      args.slopeIsPercent === true ||
      (args.slopeIsPercent !== false && maxAbs > 0.5);
    const MAX_GRADE = 0.15; // paved-road sanity (±15 %)
    slopeRad = args.slope.map((raw) => {
      let grade = asPercent ? raw / 100 : Math.tan(raw);
      if (!Number.isFinite(grade)) grade = 0;
      grade = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, grade));
      return Math.atan(grade);
    });
  } else {
    slopeRad = Array.from({ length: n }, () => 0);
  }

  const geometry: LatLon[] =
    args.lat &&
    args.lon &&
    args.lat.length === n &&
    args.lon.length === n
      ? args.lat.map((lat, i) => ({ lat, lon: args.lon![i] }))
      : [];

  // Prefer CSV a_lat if present; else derive from GPS
  const MAX_A_LAT = 6.5;
  const a_lat_raw =
    args.a_lat && args.a_lat.length === n
      ? args.a_lat.slice()
      : lateralAccelFromGps(velocity, args.lat, args.lon);
  const a_lat = a_lat_raw.map((x) =>
    Math.max(-MAX_A_LAT, Math.min(MAX_A_LAT, Number.isFinite(x) ? x : 0))
  );

  return {
    acceleration,
    slope: slopeRad,
    position,
    a_lat,
    geometry,
  };
}

export function computeCycleStats(args: {
  time: number[];
  velocity: number[];
  acceleration?: number[];
  slope?: number[];
  position?: number[];
  a_lat?: number[];
}): CycleStats {
  const { time, velocity } = args;
  const n = time.length;
  const duration_s =
    n >= 2 ? Math.max(0, time[n - 1] - time[0]) : 0;
  const distance_m =
    args.position && args.position.length === n
      ? Math.max(0, args.position[n - 1] - args.position[0])
      : (() => {
          let s = 0;
          for (let i = 1; i < n; i++) {
            const dt = Math.max(time[i] - time[i - 1], 1e-9);
            s += 0.5 * (velocity[i] + velocity[i - 1]) * dt;
          }
          return s;
        })();

  // Physical mean speed = distance / duration (matches backend profile_metrics).
  // Arithmetic sample mean of v is biased when Δt is irregular or stops dominate.
  const vMean =
    duration_s > 1e-9
      ? (distance_m / duration_s) * 3.6
      : n > 0
        ? (velocity.reduce((a, b) => a + b, 0) / n) * 3.6
        : 0;
  const vMax = n > 0 ? Math.max(...velocity) * 3.6 : 0;
  const vMin = n > 0 ? Math.min(...velocity) * 3.6 : 0;

  const acc = args.acceleration ?? [];
  const posA = acc.filter((a) => a > 0.05);
  const negA = acc.filter((a) => a < -0.05);

  const slopesPct = (args.slope ?? []).map((r) => slopeFromRad(r, "percent"));
  const aLat = args.a_lat ?? [];

  return {
    duration_s: Math.round(duration_s * 10) / 10,
    distance_m: Math.round(distance_m * 10) / 10,
    v_mean_kmh: Math.round(vMean * 100) / 100,
    v_max_kmh: Math.round(vMax * 100) / 100,
    v_min_kmh: Math.round(vMin * 100) / 100,
    a_lon_max_mps2: acc.length ? Math.round(Math.max(...acc) * 1000) / 1000 : 0,
    a_lon_min_mps2: acc.length ? Math.round(Math.min(...acc) * 1000) / 1000 : 0,
    a_lon_mean_accel_mps2: posA.length
      ? Math.round((posA.reduce((a, b) => a + b, 0) / posA.length) * 1000) / 1000
      : null,
    a_lon_mean_decel_mps2: negA.length
      ? Math.round((negA.reduce((a, b) => a + b, 0) / negA.length) * 1000) / 1000
      : null,
    a_lat_max_mps2: aLat.length
      ? Math.round(Math.max(...aLat.map(Math.abs)) * 1000) / 1000
      : null,
    slope_mean_pct: slopesPct.length
      ? Math.round(
          (slopesPct.reduce((a, b) => a + b, 0) / slopesPct.length) * 100
        ) / 100
      : null,
    slope_max_pct: slopesPct.length
      ? Math.round(Math.max(...slopesPct) * 100) / 100
      : null,
    slope_min_pct: slopesPct.length
      ? Math.round(Math.min(...slopesPct) * 100) / 100
      : null,
  };
}

/** Downsample parallel series to keep localStorage small. */
export function downsampleSeries(
  series: Record<string, number[]>,
  maxPoints = 1200
): Record<string, number[]> {
  const keys = Object.keys(series);
  if (!keys.length) return series;
  const n = series[keys[0]]?.length ?? 0;
  if (n <= maxPoints) return series;
  const step = Math.ceil(n / maxPoints);
  const out: Record<string, number[]> = {};
  for (const k of keys) {
    const arr = series[k] ?? [];
    const picked: number[] = [];
    for (let i = 0; i < arr.length; i += step) picked.push(arr[i]);
    if (picked[picked.length - 1] !== arr[arr.length - 1]) {
      picked.push(arr[arr.length - 1]);
    }
    out[k] = picked;
  }
  return out;
}

export function downsampleGeometry(
  geometry: LatLon[],
  maxPoints = 200
): LatLon[] {
  if (geometry.length <= maxPoints) return geometry;
  const step = Math.ceil(geometry.length / maxPoints);
  const out: LatLon[] = [];
  for (let i = 0; i < geometry.length; i += step) out.push(geometry[i]);
  const last = geometry[geometry.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function sampleLimitsAlongProfile(
  profile: ConsolidatedProfile,
  corridor: SpatialCorridor | null | undefined
): {
  envelope_kmh: number[];
  legal_kmh: number[];
  traffic_kmh: number[];
  curve_kmh: number[];
} | null {
  if (!corridor?.S?.length) return null;
  const S = corridor.S;
  const envelope =
    corridor.V_envelope?.length === S.length
      ? corridor.V_envelope
      : corridor.V_limite;
  const legal = corridor.V_limite_legal ?? corridor.V_limite;
  const traffic = corridor.V_traffic ?? corridor.V_limite;
  const curve = corridor.V_curve ?? corridor.V_limite;
  if (!legal?.length && !envelope?.length) return null;
  const n = profile.time.length;
  const envelope_kmh: number[] = [];
  const legal_kmh: number[] = [];
  const traffic_kmh: number[] = [];
  const curve_kmh: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = profile.position[i] ?? 0;
    envelope_kmh.push(
      envelope?.length ? sampleAtS(S, envelope, s) * 3.6 : Number.NaN
    );
    legal_kmh.push(
      legal?.length
        ? snapPostedSpeedKmh(sampleAtSHold(S, legal, s) * 3.6)
        : Number.NaN
    );
    traffic_kmh.push(
      traffic?.length ? sampleAtS(S, traffic, s) * 3.6 : Number.NaN
    );
    // Non-binding straights use ~1e6 m/s sentinel — mask like SpeedLimitChart (>160 km/h).
    const vCurveMps = curve?.length ? sampleAtS(S, curve, s) : Number.NaN;
    const vCurveKmh = vCurveMps * 3.6;
    curve_kmh.push(
      Number.isFinite(vCurveKmh) && vCurveKmh > 160 ? Number.NaN : vCurveKmh
    );
  }
  return { envelope_kmh, legal_kmh, traffic_kmh, curve_kmh };
}
