import type { LatLon, SpatialCorridor } from "@/lib/types";

const R_EARTH = 6371000;
const DEFAULT_WINDOW_M = 50;
const RESAMPLE_STEP_M = 5;
const HALF_WIDTH_M = 1.75;
const TURN_THRESH_RAD = (15 * Math.PI) / 180;

export type LoupeSample = {
  s_m: number;
  lat: number;
  lon: number;
  z_m: number;
  /** Longitudinal grade (rad). */
  alpha_rad: number;
  /** Grade in percent. */
  grade_pct: number;
};

export type EnuPoint = {
  s_m: number;
  /** Forward along heading at anchor (m). */
  x: number;
  /** Lateral right (m). */
  y: number;
  /** Up relative to anchor altitude (m). */
  z: number;
  grade_pct: number;
};

export type RibbonQuad = {
  /** Four corners in ENU: left0, right0, right1, left1 */
  corners: [EnuPoint, EnuPoint, EnuPoint, EnuPoint];
  grade_pct: number;
};

export type NextTurnInfo = {
  s_m: number;
  distance_m: number;
  /** Positive = right turn, negative = left. */
  signed_rad: number;
  side: "L" | "R";
};

export type LoupeModel = {
  samples: LoupeSample[];
  enu: EnuPoint[];
  ribbon: RibbonQuad[];
  anchor: LoupeSample;
  heading_rad: number;
  mean_grade_pct: number;
  dz_m: number;
  next_turn: NextTurnInfo | null;
  /** Circumradius estimate at anchor (m), or null. */
  R_m: number | null;
};

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Project lat/lon to local ENU meters relative to origin. */
function latLonToEnu(
  lat: number,
  lon: number,
  originLat: number,
  originLon: number
): { e: number; n: number } {
  const lat0 = toRad(originLat);
  const dLat = toRad(lat - originLat);
  const dLon = toRad(lon - originLon);
  return {
    e: dLon * Math.cos(lat0) * R_EARTH,
    n: dLat * R_EARTH,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function headingFromEnu(e0: number, n0: number, e1: number, n1: number): number {
  return Math.atan2(e1 - e0, n1 - n0);
}

/** Nearest corridor sample index by haversine; returns curvilinear S. */
export function nearestSFromLatLon(
  corridor: Pick<SpatialCorridor, "S" | "geometry">,
  lat: number,
  lon: number
): number | null {
  const { S, geometry } = corridor;
  const n = Math.min(S.length, geometry.length);
  if (n === 0) return null;
  const target = { lat, lon };
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = haversineM(geometry[i], target);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return S[bestI];
}

function interpolateAtS(
  corridor: SpatialCorridor,
  s_m: number
): LoupeSample | null {
  const { S, geometry } = corridor;
  const elev = corridor.elevations_m;
  const alpha = corridor.alpha;
  const n = Math.min(
    S.length,
    geometry.length,
    elev?.length ?? 0,
    alpha.length
  );
  if (n < 2 || !elev) return null;

  const sMax = S[n - 1];
  const s = Math.max(0, Math.min(s_m, sMax));
  let i = 0;
  while (i < n - 2 && S[i + 1] < s) i++;
  const s0 = S[i];
  const s1 = S[i + 1];
  const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
  const a0 = alpha[i] ?? 0;
  const a1 = alpha[i + 1] ?? a0;
  const alpha_rad = lerp(a0, a1, t);
  return {
    s_m: s,
    lat: lerp(geometry[i].lat, geometry[i + 1].lat, t),
    lon: lerp(geometry[i].lon, geometry[i + 1].lon, t),
    z_m: lerp(elev[i], elev[i + 1], t),
    alpha_rad,
    grade_pct: 100 * Math.tan(alpha_rad),
  };
}

/** Dense resample of corridor window around s. */
export function sliceLoupeSamples(
  corridor: SpatialCorridor,
  s_m: number,
  windowM = DEFAULT_WINDOW_M,
  stepM = RESAMPLE_STEP_M
): LoupeSample[] {
  const elev = corridor.elevations_m;
  if (!elev?.length || corridor.S.length < 2) return [];
  const sMax = corridor.S[corridor.S.length - 1];
  const s0 = Math.max(0, s_m - windowM);
  const s1 = Math.min(sMax, s_m + windowM);
  if (s1 - s0 < 1) return [];

  const out: LoupeSample[] = [];
  for (let s = s0; s <= s1 + 1e-6; s += stepM) {
    const pt = interpolateAtS(corridor, Math.min(s, s1));
    if (pt) out.push(pt);
  }
  const end = interpolateAtS(corridor, s1);
  if (end && (out.length === 0 || Math.abs(out[out.length - 1].s_m - end.s_m) > 0.5)) {
    out.push(end);
  }
  return out;
}

function buildEnuFrame(
  samples: LoupeSample[],
  anchor: LoupeSample,
  heading_rad: number
): EnuPoint[] {
  const cosH = Math.cos(heading_rad);
  const sinH = Math.sin(heading_rad);
  return samples.map((p) => {
    const { e, n } = latLonToEnu(p.lat, p.lon, anchor.lat, anchor.lon);
    // Rotate so +X is forward (heading), +Y is right
    const x = e * sinH + n * cosH;
    const y = e * cosH - n * sinH;
    return {
      s_m: p.s_m,
      x,
      y,
      z: p.z_m - anchor.z_m,
      grade_pct: p.grade_pct,
    };
  });
}

function buildRibbon(enu: EnuPoint[], halfW = HALF_WIDTH_M): RibbonQuad[] {
  if (enu.length < 2) return [];
  const quads: RibbonQuad[] = [];
  for (let i = 0; i < enu.length - 1; i++) {
    const a = enu[i];
    const b = enu[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Horizontal normal (right)
    const nx = dy / len;
    const ny = -dx / len;
    const left0: EnuPoint = {
      ...a,
      x: a.x - nx * halfW,
      y: a.y - ny * halfW,
    };
    const right0: EnuPoint = {
      ...a,
      x: a.x + nx * halfW,
      y: a.y + ny * halfW,
    };
    const left1: EnuPoint = {
      ...b,
      x: b.x - nx * halfW,
      y: b.y - ny * halfW,
    };
    const right1: EnuPoint = {
      ...b,
      x: b.x + nx * halfW,
      y: b.y + ny * halfW,
    };
    quads.push({
      corners: [left0, right0, right1, left1],
      grade_pct: 0.5 * (a.grade_pct + b.grade_pct),
    });
  }
  return quads;
}

function findNextTurn(
  samples: LoupeSample[],
  s_m: number,
  thresh = TURN_THRESH_RAD
): NextTurnInfo | null {
  if (samples.length < 3) return null;
  const ahead = samples.filter((p) => p.s_m >= s_m - 1e-3);
  if (ahead.length < 3) return null;

  let prevH: number | null = null;
  for (let i = 0; i < ahead.length - 1; i++) {
    const a = ahead[i];
    const b = ahead[i + 1];
    const { e: e0, n: n0 } = latLonToEnu(a.lat, a.lon, a.lat, a.lon);
    const { e: e1, n: n1 } = latLonToEnu(b.lat, b.lon, a.lat, a.lon);
    const h = headingFromEnu(e0, n0, e1, n1);
    if (prevH != null) {
      const d = wrapAngle(h - prevH);
      if (Math.abs(d) >= thresh) {
        return {
          s_m: b.s_m,
          distance_m: Math.max(0, b.s_m - s_m),
          signed_rad: d,
          side: d >= 0 ? "R" : "L",
        };
      }
    }
    prevH = h;
  }
  return null;
}

/** Circumradius of triangle around anchor using neighbors ~step apart. */
function estimateR(
  samples: LoupeSample[],
  s_m: number
): number | null {
  if (samples.length < 3) return null;
  let i = 0;
  while (i < samples.length - 1 && samples[i].s_m < s_m) i++;
  i = Math.max(1, Math.min(i, samples.length - 2));
  const a = samples[i - 1];
  const b = samples[i];
  const c = samples[i + 1];
  const { e: ax, n: ay } = latLonToEnu(a.lat, a.lon, b.lat, b.lon);
  const bx = 0;
  const by = 0;
  const { e: cx, n: cy } = latLonToEnu(c.lat, c.lon, b.lat, b.lon);
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const R = Math.hypot(ux - bx, uy - by);
  if (!Number.isFinite(R) || R > 5e4) return null;
  return R;
}

export function buildLoupeModel(
  corridor: SpatialCorridor,
  s_m: number,
  windowM = DEFAULT_WINDOW_M
): LoupeModel | null {
  const samples = sliceLoupeSamples(corridor, s_m, windowM);
  if (samples.length < 2) return null;
  const anchor = interpolateAtS(corridor, s_m) ?? samples[Math.floor(samples.length / 2)];

  // Heading: prefer forward look-ahead within window
  const ahead = samples.find((p) => p.s_m >= s_m + 5) ?? samples[samples.length - 1];
  const behind = [...samples].reverse().find((p) => p.s_m <= s_m - 5) ?? samples[0];
  const { e: e0, n: n0 } = latLonToEnu(behind.lat, behind.lon, anchor.lat, anchor.lon);
  const { e: e1, n: n1 } = latLonToEnu(ahead.lat, ahead.lon, anchor.lat, anchor.lon);
  const heading_rad = headingFromEnu(e0, n0, e1, n1);

  const enu = buildEnuFrame(samples, anchor, heading_rad);
  const ribbon = buildRibbon(enu);
  const mean_grade_pct =
    samples.reduce((acc, p) => acc + p.grade_pct, 0) / samples.length;
  const zFirst = samples[0].z_m;
  const zLast = samples[samples.length - 1].z_m;

  return {
    samples,
    enu,
    ribbon,
    anchor,
    heading_rad,
    mean_grade_pct,
    dz_m: zLast - zFirst,
    next_turn: findNextTurn(samples, s_m),
    R_m: estimateR(samples, s_m),
  };
}

export const LOUPE_WINDOW_M = DEFAULT_WINDOW_M;
export const LOUPE_HALF_WIDTH_M = HALF_WIDTH_M;
/** Available ±window half-lengths for the 3D loupe. */
export const LOUPE_WINDOW_OPTIONS_M = [50, 100, 200, 300] as const;
export type LoupeWindowM = (typeof LOUPE_WINDOW_OPTIONS_M)[number];
