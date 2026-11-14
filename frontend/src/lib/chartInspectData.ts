/** Shared row builder for results chart inspection. */

import type { ConsolidatedProfile, SpatialCorridor } from "@/lib/types";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import {
  lateralAccelApprox,
  mechanicalPowerSample,
} from "@/lib/vehiclePower";
import { slopeFromRad, type SlopeUnit } from "@/lib/units";
import { DEFAULT_A_Y } from "@/lib/driverPresets";

export type InspectSeriesId =
  | "v_kmh"
  | "slope"
  | "a_lon"
  | "a_lat"
  | "p_trac_kw"
  | "p_regen_kw"
  | "p_wheel_kw"
  | "wheel_torque_nm"
  | "wheel_rpm";

export type InspectRow = {
  t: number;
  s: number;
  v_kmh: number;
  slope: number;
  a_lon: number;
  a_lat: number;
  p_trac_kw: number;
  p_regen_kw: number;
  /** Signed mechanical power at wheels (kW); >0 traction, <0 braking. */
  p_wheel_kw: number;
  /** Signed wheel torque τ = F_trac · r_dyn (N·m). */
  wheel_torque_nm: number;
  /** Wheel rotational speed (rpm) = v / r_dyn · 60/(2π). */
  wheel_rpm: number;
};

export type RollingMode = "mean" | "rms";

export const INSPECT_SERIES: {
  id: InspectSeriesId;
  defaultLabel: string;
  /** Short tag for cursor / tooltip vignettes. */
  short: string;
  unit: string;
  color: string;
  needsVehicle?: boolean;
}[] = [
  { id: "v_kmh", defaultLabel: "Vitesse", short: "V", unit: "km/h", color: "#0ea5e9" },
  { id: "slope", defaultLabel: "Pente", short: "α", unit: "%", color: "#16a34a" },
  {
    id: "a_lon",
    defaultLabel: "Accel. longitudinale",
    short: "Ax",
    unit: "m/s²",
    color: "#f59e0b",
  },
  {
    id: "a_lat",
    defaultLabel: "Accel. latérale",
    short: "Ay",
    unit: "m/s²",
    color: "#a855f7",
  },
  {
    id: "p_trac_kw",
    defaultLabel: "Puissance traction",
    short: "Pt",
    unit: "kW",
    color: "#2563eb",
    needsVehicle: true,
  },
  {
    id: "p_regen_kw",
    defaultLabel: "Puissance freinage (|P|)",
    short: "Pf",
    unit: "kW",
    color: "#059669",
    needsVehicle: true,
  },
  {
    id: "wheel_torque_nm",
    defaultLabel: "Couple à la roue",
    short: "τ",
    unit: "N·m",
    color: "#dc2626",
    needsVehicle: true,
  },
  {
    id: "p_wheel_kw",
    defaultLabel: "Puissance mécanique",
    short: "Pw",
    unit: "kW",
    color: "#0ea5e9",
    needsVehicle: true,
  },
  {
    id: "wheel_rpm",
    defaultLabel: "Vitesse rotation roue",
    short: "N",
    unit: "tr/min",
    color: "#0891b2",
    needsVehicle: true,
  },
];

export function seriesShort(id: InspectSeriesId): string {
  return INSPECT_SERIES.find((s) => s.id === id)?.short ?? id;
}

export function inspectSeriesMeta(id: InspectSeriesId): (typeof INSPECT_SERIES)[number] {
  return (
    INSPECT_SERIES.find((s) => s.id === id) ?? {
      id,
      defaultLabel: id,
      short: id.slice(0, 2),
      unit: "",
      color: "#64748b",
    }
  );
}

/** Single-sample series value (Versus / overlays), with optional vehicle road-load. */
export function inspectSampleValue(args: {
  series: InspectSeriesId;
  v_mps: number;
  a_lon_mps2: number;
  a_lat_mps2: number;
  alpha_rad: number;
  vehicle?: Pick<
    VehicleCard,
    | "mass_kg"
    | "f0_n"
    | "f1_n_per_kph"
    | "f2_n_per_kph2"
    | "r_dyn_m"
    | "tau_brake_max_nm"
  > | null;
  slopeUnit?: SlopeUnit;
}): number {
  const {
    series,
    v_mps,
    a_lon_mps2,
    a_lat_mps2,
    alpha_rad,
    vehicle = null,
    slopeUnit = "percent",
  } = args;
  switch (series) {
    case "v_kmh":
      return v_mps * 3.6;
    case "a_lon":
      return a_lon_mps2;
    case "a_lat":
      return a_lat_mps2;
    case "slope":
      return slopeFromRad(alpha_rad, slopeUnit);
    default:
      break;
  }
  if (!vehicle) return Number.NaN;
  const pow = mechanicalPowerSample({
    v_mps,
    a_lon_mps2,
    alpha_rad,
    vehicle,
  });
  switch (series) {
    case "p_trac_kw":
      return pow.p_trac_kw;
    case "p_regen_kw":
      return pow.p_regen_kw;
    case "p_wheel_kw":
      return pow.p_mech_w / 1000;
    case "wheel_torque_nm":
      return pow.wheel_torque_nm;
    case "wheel_rpm":
      return pow.wheel_rpm;
    default:
      return Number.NaN;
  }
}

function sampleVcurve(
  corridor: SpatialCorridor | null,
  s: number
): number | null {
  const S = corridor?.S;
  const Vc = corridor?.V_curve;
  if (!S?.length || !Vc?.length) return null;
  if (s <= S[0]) return Vc[0];
  if (s >= S[S.length - 1]) return Vc[Vc.length - 1];
  let lo = 0;
  let hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  const ds = S[hi] - S[lo];
  if (ds < 1e-9) return Vc[lo];
  const u = (s - S[lo]) / ds;
  return Vc[lo] + u * (Vc[hi] - Vc[lo]);
}

export function buildInspectRows(args: {
  profile: ConsolidatedProfile;
  corridor?: SpatialCorridor | null;
  vehicle?: VehicleCard | null;
  aY?: number;
  slopeUnit?: SlopeUnit;
}): InspectRow[] {
  const {
    profile,
    corridor = null,
    vehicle = null,
    aY = DEFAULT_A_Y,
    slopeUnit = "percent",
  } = args;
  const n = Math.min(
    profile.time.length,
    profile.velocity.length,
    profile.position.length
  );
  const out: InspectRow[] = [];
  for (let i = 0; i < n; i++) {
    const t = profile.time[i];
    const s = profile.position[i] ?? 0;
    const v = profile.velocity[i] ?? 0;
    const a =
      profile.acceleration?.[i] ??
      (i > 0
        ? (v - (profile.velocity[i - 1] ?? 0)) /
          Math.max(1e-3, t - profile.time[i - 1])
        : 0);
    const alpha = profile.slope?.[i] ?? 0;
    const vc = sampleVcurve(corridor, s);
    const a_lat = lateralAccelApprox(v, vc, aY);
    const pow = vehicle
      ? mechanicalPowerSample({
          v_mps: v,
          a_lon_mps2: a,
          alpha_rad: alpha,
          vehicle,
        })
      : null;
    out.push({
      t,
      s,
      v_kmh: v * 3.6,
      slope: slopeFromRad(alpha, slopeUnit),
      a_lon: a,
      a_lat,
      p_trac_kw: pow?.p_trac_kw ?? 0,
      p_regen_kw: pow?.p_regen_kw ?? 0,
      p_wheel_kw: pow ? pow.p_mech_w / 1000 : 0,
      wheel_torque_nm: pow?.wheel_torque_nm ?? 0,
      wheel_rpm: pow?.wheel_rpm ?? 0,
    });
  }
  if (out.length <= 2000) return out;
  const step = Math.ceil(out.length / 1600);
  return out.filter((_, i) => i % step === 0 || i === out.length - 1);
}

export function nearestRow(rows: InspectRow[], t: number): InspectRow | null {
  if (!rows.length) return null;
  let best = rows[0];
  let bestD = Math.abs(rows[0].t - t);
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i].t - t);
    if (d < bestD) {
      best = rows[i];
      bestD = d;
    }
  }
  return best;
}

export function sliceStats(
  rows: InspectRow[],
  t0: number,
  t1: number,
  key: InspectSeriesId
): {
  n: number;
  mean: number;
  rms: number;
  min: number;
  max: number;
  dt: number;
  /** Mean over samples with |series| > eps (ignores idle zeros). */
  meanActive: number | null;
  /** Fraction of samples with |v| > eps. */
  duty: number;
  nActive: number;
  /** ∫|P| dt for power-like series (kWh if key is * _kw), else null. */
  energyKwh: number | null;
} | null {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  const slice = rows.filter((r) => r.t >= lo && r.t <= hi);
  if (!slice.length) return null;
  const vals = slice.map((r) => r[key]);
  const sum = vals.reduce((a, b) => a + b, 0);
  const sumSq = vals.reduce((a, b) => a + b * b, 0);
  const eps = 1e-9;
  const active = vals.filter((v) => Math.abs(v) > eps);
  const sumActive = active.reduce((a, b) => a + b, 0);

  let energyKwh: number | null = null;
  if (key.endsWith("_kw") || key === "p_wheel_kw") {
    let e = 0;
    for (let i = 1; i < slice.length; i++) {
      const dt = Math.max(0, slice[i].t - slice[i - 1].t);
      // Trapezoid on absolute contribution for one-sided regen/trac; signed for p_wheel
      const p0 = vals[i - 1];
      const p1 = vals[i];
      e += 0.5 * (p0 + p1) * dt;
    }
    energyKwh = e / 3600;
  }

  return {
    n: slice.length,
    mean: sum / vals.length,
    rms: Math.sqrt(sumSq / vals.length),
    min: Math.min(...vals),
    max: Math.max(...vals),
    dt: hi - lo,
    meanActive: active.length ? sumActive / active.length : null,
    duty: active.length / vals.length,
    nActive: active.length,
    energyKwh,
  };
}

/**
 * Causal rolling mean / RMS over the last `windowSec` seconds.
 * When the window covers the whole trip, returns a **constant** global
 * mean/RMS (matches legend « Trajet ») — not an expanding prefix average.
 */
export function withRollingOverlay(
  rows: InspectRow[],
  key: InspectSeriesId,
  windowSec: number,
  mode: RollingMode
): Array<InspectRow & { rolling: number }> {
  if (!rows.length || !(windowSec > 0)) {
    return rows.map((r) => ({ ...r, rolling: r[key] }));
  }

  const span = rows[rows.length - 1].t - rows[0].t;
  if (span > 0 && windowSec >= span - 1e-6) {
    const g = globalStat(rows, key, mode);
    const v = g ?? 0;
    return rows.map((r) => ({ ...r, rolling: v }));
  }

  const out: Array<InspectRow & { rolling: number }> = [];
  let j = 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  const add = (v: number) => {
    sum += v;
    sumSq += v * v;
    count += 1;
  };
  const rem = (v: number) => {
    sum -= v;
    sumSq -= v * v;
    count -= 1;
  };

  for (let i = 0; i < rows.length; i++) {
    const ti = rows[i].t;
    const vi = rows[i][key];
    add(vi);
    const tLo = ti - windowSec;
    while (j < i && rows[j].t < tLo - 1e-9) {
      rem(rows[j][key]);
      j += 1;
    }
    const rolling =
      count > 0
        ? mode === "rms"
          ? Math.sqrt(Math.max(0, sumSq / count))
          : sum / count
        : vi;
    out.push({ ...rows[i], rolling });
  }
  return out;
}

export function globalStat(
  rows: InspectRow[],
  key: InspectSeriesId,
  mode: RollingMode
): number | null {
  if (!rows.length) return null;
  if (mode === "rms") {
    const sumSq = rows.reduce((a, r) => a + r[key] * r[key], 0);
    return Math.sqrt(sumSq / rows.length);
  }
  return rows.reduce((a, r) => a + r[key], 0) / rows.length;
}

/** Series that are ~0 most of the time (mean diluted by idle samples). */
export function isZeroInflatedSeries(id: InspectSeriesId): boolean {
  return id === "p_regen_kw" || id === "p_trac_kw";
}

export function findKeyMoments(
  rows: InspectRow[]
): { id: string; label: string; t: number }[] {
  const moments: { id: string; label: string; t: number }[] = [];
  if (!rows.length) return moments;

  let maxRegen = -Infinity;
  let maxRegenT = NaN;
  let maxAbsA = -Infinity;
  let maxAbsAT = NaN;

  for (const r of rows) {
    if (Number.isFinite(r.p_regen_kw) && r.p_regen_kw > maxRegen) {
      maxRegen = r.p_regen_kw;
      maxRegenT = r.t;
    }
    const absA = Math.abs(r.a_lon);
    if (Number.isFinite(absA) && absA > maxAbsA) {
      maxAbsA = absA;
      maxAbsAT = r.t;
    }
  }

  if (Number.isFinite(maxRegenT) && Number.isFinite(maxRegen)) {
    moments.push({ id: "max_regen", label: "Max freinage |P|", t: maxRegenT });
  }
  if (Number.isFinite(maxAbsAT) && Number.isFinite(maxAbsA)) {
    moments.push({ id: "max_abs_a", label: "Max |a|", t: maxAbsAT });
  }

  // Longest stop: consecutive samples with v_kmh < 1.8 lasting ≥ 2s
  let bestDur = 0;
  let bestStartT = NaN;
  let runStart = -1;
  let runStartT = NaN;

  const flushRun = (endIdx: number) => {
    if (runStart < 0) return;
    const dur = rows[endIdx].t - runStartT;
    if (dur >= 2 && dur > bestDur) {
      bestDur = dur;
      bestStartT = runStartT;
    }
    runStart = -1;
    runStartT = NaN;
  };

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].v_kmh < 1.8) {
      if (runStart < 0) {
        runStart = i;
        runStartT = rows[i].t;
      }
    } else {
      if (runStart >= 0) flushRun(i - 1);
    }
  }
  if (runStart >= 0) flushRun(rows.length - 1);

  if (Number.isFinite(bestStartT) && bestDur >= 2) {
    moments.push({ id: "stop_long", label: "Stop long", t: bestStartT });
  }

  return moments
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t)
    .slice(0, 6);
}
