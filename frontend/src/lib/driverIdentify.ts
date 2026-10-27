/** Identify / fingerprint a driver from a realized v(t) profile. */

import {
  DRIVER_PRESETS,
  completePhysics,
  type DriverPhysics,
} from "@/lib/driverPresets";
import {
  listDrivers,
  type SavedDriver,
} from "@/lib/driverLibrary";
import type { DriverProfile } from "@/lib/types";

export type DriverFingerprint = {
  duration_s: number;
  distance_m: number;
  v_mean_mps: number;
  v_max_mps: number;
  mean_abs_accel: number;
  p95_accel: number;
  p95_decel: number;
  p95_abs_accel: number;
  /** P85 traction accel (m/s²) — RS-aligned. */
  p85_accel: number;
  /** P85 braking magnitude (m/s²). */
  p85_decel: number;
  jerk_pos_p85: number;
  jerk_neg_p85: number;
  /** AR(1) lag estimate on a (s). */
  pedal_tau_est: number;
  /** AR(1) lag estimate on soft speed changes (s). */
  vdes_tau_est: number;
  /** Soft coast fraction → hold proxy. */
  descent_hold_est: number;
  rpa: number;
  stop_ratio: number;
  stops: number;
};

export type InferredDriverParams = {
  physics: DriverPhysics;
  baseProfile: DriverProfile;
  /** Lateral accel comfort (m/s²) — corridor curve envelope. */
  a_y: number;
  /** Suggested vehicle Vmax (km/h) from observed peak + margin. */
  maxSpeedKmh: number;
  fingerprint: DriverFingerprint;
};

export type DriverMatch = {
  driver: SavedDriver;
  score: number; // 0–100, higher = closer
  delta: Partial<Record<keyof DriverPhysics, number>>;
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[i];
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function emptyFingerprint(): DriverFingerprint {
  return {
    duration_s: 0,
    distance_m: 0,
    v_mean_mps: 0,
    v_max_mps: 0,
    mean_abs_accel: 0,
    p95_accel: 0,
    p95_decel: 0,
    p95_abs_accel: 0,
    p85_accel: 0,
    p85_decel: 0,
    jerk_pos_p85: 0,
    jerk_neg_p85: 0,
    pedal_tau_est: 0,
    vdes_tau_est: 0,
    descent_hold_est: 0,
    rpa: 0,
    stop_ratio: 0,
    stops: 0,
  };
}

function deriveAccel(time: number[], velocity: number[]): number[] {
  const n = Math.min(time.length, velocity.length);
  const a = Array.from({ length: n }, () => 0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(time[i] - time[i - 1], 1e-3);
    a[i] = (velocity[i] - velocity[i - 1]) / dt;
  }
  if (n > 1) a[0] = a[1];
  return a;
}

function deriveJerk(time: number[], accel: number[]): number[] {
  const n = Math.min(time.length, accel.length);
  const j = Array.from({ length: n }, () => 0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(time[i] - time[i - 1], 1e-3);
    j[i] = (accel[i] - accel[i - 1]) / dt;
  }
  if (n > 1) j[0] = j[1];
  return j;
}

/** First-order τ from lag-1 autocorrelation: ρ = e^(−dt/τ) → τ = −dt / ln(ρ). */
function estimateTauAR1(time: number[], signal: number[]): number {
  const n = Math.min(time.length, signal.length);
  if (n < 30) return 0;
  let dtSum = 0;
  let dtN = 0;
  for (let i = 1; i < n; i++) {
    const dt = time[i] - time[i - 1];
    if (dt > 1e-4 && dt < 2) {
      dtSum += dt;
      dtN += 1;
    }
  }
  const dt = dtN > 0 ? dtSum / dtN : 0.1;
  const m = mean(signal.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 1; i < n; i++) {
    const x = signal[i] - m;
    const y = signal[i - 1] - m;
    num += x * y;
    den += x * x;
  }
  if (den < 1e-12) return 0;
  const rho = num / den;
  if (rho <= 0.05 || rho >= 0.999) return 0;
  const tau = -dt / Math.log(rho);
  if (!Number.isFinite(tau)) return 0;
  return clamp(tau, 0, 10);
}

/** Build kinematic fingerprint from a speed–time series (v in m/s). */
export function fingerprintFromProfile(
  time: number[],
  velocity: number[]
): DriverFingerprint {
  const n = Math.min(time.length, velocity.length);
  if (n < 3) return emptyFingerprint();

  const t = time.slice(0, n);
  const v = velocity.slice(0, n);
  const a = deriveAccel(t, v);
  const jerk = deriveJerk(t, a);
  const duration_s = Math.max(0, t[n - 1] - t[0]);
  let distance_m = 0;
  let vSum = 0;
  let vMax = 0;
  let stopTime = 0;
  let coastTime = 0;
  let movingTime = 0;
  let stops = 0;
  let wasStopped = v[0] < 0.3;
  const accelPos: number[] = [];
  const accelNeg: number[] = [];
  const absA: number[] = [];
  const jerkPos: number[] = [];
  const jerkNeg: number[] = [];
  let rpaNum = 0;

  for (let i = 0; i < n; i++) {
    const vi = Math.max(0, v[i]);
    vSum += vi;
    if (vi > vMax) vMax = vi;
    if (i > 0) {
      const dt = Math.max(t[i] - t[i - 1], 0);
      distance_m += 0.5 * (vi + Math.max(0, v[i - 1])) * dt;
      if (vi < 0.3) stopTime += dt;
      if (vi > 3) {
        movingTime += dt;
        const ai = a[i];
        // Mild sustained decel while rolling ≈ soft hold / coast
        if (ai < -0.05 && ai > -0.6) coastTime += dt;
      }
    }
    const stopped = vi < 0.3;
    if (stopped && !wasStopped) stops += 1;
    wasStopped = stopped;
    const ai = a[i];
    absA.push(Math.abs(ai));
    if (ai > 0.05) accelPos.push(ai);
    if (ai < -0.05) accelNeg.push(-ai);
    if (ai > 0 && vi > 0.1) rpaNum += ai * vi;
    const ji = jerk[i];
    if (ji > 0.05) jerkPos.push(ji);
    if (ji < -0.05) jerkNeg.push(-ji);
  }

  accelPos.sort((x, y) => x - y);
  accelNeg.sort((x, y) => x - y);
  absA.sort((x, y) => x - y);
  jerkPos.sort((x, y) => x - y);
  jerkNeg.sort((x, y) => x - y);

  const pedal_tau_est = round2(estimateTauAR1(t, a));
  // Soft speed residual: high-pass-ish via local a near cruise (|a| small)
  const softA = a.map((x) => (Math.abs(x) < 0.8 ? x : 0));
  const vdes_tau_est = round2(
    Math.max(pedal_tau_est * 0.85, estimateTauAR1(t, softA))
  );
  const coastRatio = movingTime > 1 ? coastTime / movingTime : 0;
  const descent_hold_est = round2(clamp(coastRatio * 4, 0, 10));

  return {
    duration_s,
    distance_m,
    v_mean_mps: vSum / n,
    v_max_mps: vMax,
    mean_abs_accel: mean(absA),
    p95_accel: percentile(accelPos, 95) || percentile(absA, 90),
    p95_decel: percentile(accelNeg, 95) || percentile(absA, 90),
    p95_abs_accel: percentile(absA, 95),
    p85_accel: percentile(accelPos, 85) || percentile(accelPos, 95),
    p85_decel: percentile(accelNeg, 85) || percentile(accelNeg, 95),
    jerk_pos_p85: percentile(jerkPos, 85) || 1.5,
    jerk_neg_p85: percentile(jerkNeg, 85) || 1.5,
    pedal_tau_est,
    vdes_tau_est,
    descent_hold_est,
    rpa: distance_m > 1 ? rpaNum / distance_m : 0,
    stop_ratio: duration_s > 0 ? stopTime / duration_s : 0,
    stops,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Map observed kinematics → full IDM physics + nearest base profile. */
export function inferDriverParams(
  fp: DriverFingerprint
): InferredDriverParams {
  const a_src = fp.p85_accel || fp.p95_accel || fp.p95_abs_accel * 0.9;
  const a_max = round2(clamp(a_src, 0.6, 7.5));
  const b_src = fp.p85_decel || fp.p95_decel || fp.p95_abs_accel;
  const b_comf = round2(clamp(b_src, 0.8, 9));

  const jerk_max = round2(clamp(fp.jerk_pos_p85 || 1.5, 0.3, 8));
  const jerk_brake_max = round2(
    clamp(fp.jerk_neg_p85 || jerk_max, 0.3, 10)
  );

  const vMeanKmh = fp.v_mean_mps * 3.6;
  let speed_factor = 0.94;
  if (vMeanKmh < 30) speed_factor = 0.88;
  else if (vMeanKmh < 45) speed_factor = 0.92;
  else if (vMeanKmh < 65) speed_factor = 0.96;
  else if (vMeanKmh < 90) speed_factor = 1.05;
  else speed_factor = 1.12;
  if (fp.rpa > 0.35 || a_max >= 3.5) speed_factor = Math.max(speed_factor, 1.08);
  if (a_max <= 1.8 && fp.rpa < 0.2) speed_factor = Math.min(speed_factor, 0.95);
  speed_factor = round2(clamp(speed_factor, 0.7, 1.35));

  // Headway heuristic from aggressiveness (aligned with rs_fingerprint.suggest_physics)
  let T: number;
  let T_h: number;
  let s0: number;
  if (a_max >= 2.2) {
    T = 1.2;
    T_h = 3.0;
    s0 = 1.8;
  } else if (a_max <= 1.4) {
    T = 1.8;
    T_h = 4.5;
    s0 = 2.8;
  } else {
    T = 1.5;
    T_h = 3.5;
    s0 = 2.0;
  }

  const physics: DriverPhysics = completePhysics({
    a_max,
    b_comf,
    speed_factor,
    jerk_max,
    jerk_brake_max,
    T,
    T_h,
    s0,
    pedal_tau_s: round2(clamp(fp.pedal_tau_est, 0, 10)),
    vdes_tau_s: round2(clamp(fp.vdes_tau_est, 0, 10)),
    descent_hold_gain: round2(clamp(fp.descent_hold_est, 0, 10)),
  });
  const baseProfile = nearestBaseProfile(physics);
  const presetAy =
    DRIVER_PRESETS.find((p) => p.id === baseProfile)?.a_y ?? 3.5;
  // Nudge a_y with aggressiveness (RPA / a_max)
  let a_y = presetAy;
  if (a_max >= 3.2 || fp.rpa > 0.4) a_y = Math.max(a_y, 4.5);
  else if (a_max <= 1.4) a_y = Math.min(a_y, 2.5);
  a_y = round2(clamp(a_y, 0.5, 8));

  const vPeakKmh = fp.v_max_mps * 3.6;
  const maxSpeedKmh = Math.round(
    clamp(Math.ceil((vPeakKmh + 10) / 5) * 5, 20, 250)
  );

  return { physics, baseProfile, a_y, maxSpeedKmh, fingerprint: fp };
}

export function nearestBaseProfile(physics: DriverPhysics): DriverProfile {
  let best: DriverProfile = "Normal";
  let bestD = Infinity;
  for (const p of DRIVER_PRESETS) {
    const d = physicsDistance(physics, p.physics);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

function physicsDistance(a: DriverPhysics, b: DriverPhysics): number {
  return (
    Math.abs(a.a_max - b.a_max) / 4 +
    Math.abs(a.b_comf - b.b_comf) / 6 +
    Math.abs(a.speed_factor - b.speed_factor) / 0.25 +
    Math.abs(a.jerk_max - b.jerk_max) / 4 +
    Math.abs(a.jerk_brake_max - b.jerk_brake_max) / 5 +
    Math.abs(a.T - b.T) / 2 +
    Math.abs(a.T_h - b.T_h) / 4 +
    Math.abs(a.s0 - b.s0) / 3 +
    Math.abs((a.pedal_tau_s ?? 0) - (b.pedal_tau_s ?? 0)) / 2 +
    Math.abs((a.vdes_tau_s ?? 0) - (b.vdes_tau_s ?? 0)) / 2 +
    Math.abs((a.descent_hold_gain ?? 0) - (b.descent_hold_gain ?? 0)) / 2
  );
}

const DELTA_KEYS: (keyof DriverPhysics)[] = [
  "a_max",
  "b_comf",
  "speed_factor",
  "jerk_max",
  "jerk_brake_max",
  "T",
  "T_h",
  "s0",
  "pedal_tau_s",
  "vdes_tau_s",
  "descent_hold_gain",
];

/** Rank library drivers by closeness to inferred physics (0–100 score). */
export function matchDriversToPhysics(
  physics: DriverPhysics,
  drivers?: SavedDriver[]
): DriverMatch[] {
  const list = drivers ?? listDrivers();
  return list
    .map((driver) => {
      const dist = physicsDistance(physics, driver.physics);
      const score = Math.max(0, Math.round(100 * (1 - dist / 4)));
      const delta: DriverMatch["delta"] = {};
      for (const k of DELTA_KEYS) {
        delta[k] = round2((physics[k] ?? 0) - (driver.physics[k] ?? 0));
      }
      return { driver, score, delta };
    })
    .sort((a, b) => b.score - a.score);
}

export function identifyDriverFromProfile(
  time: number[],
  velocity: number[]
): {
  inferred: InferredDriverParams;
  matches: DriverMatch[];
} {
  const fingerprint = fingerprintFromProfile(time, velocity);
  const inferred = inferDriverParams(fingerprint);
  const matches = matchDriversToPhysics(inferred.physics);
  return { inferred, matches };
}

/** Compact labels for identify / match UI (physics + corridor caps). */
export const DRIVER_PHYSICS_UI_KEYS: Array<{
  key: keyof DriverPhysics;
  label: string;
  unit: string;
  digits?: number;
  step?: number;
}> = [
  { key: "a_max", label: "a_max", unit: "m/s²", step: 0.01 },
  { key: "b_comf", label: "b_comf", unit: "m/s²", step: 0.01 },
  { key: "speed_factor", label: "sf", unit: "×", digits: 2, step: 0.01 },
  { key: "jerk_max", label: "jerk+", unit: "m/s³", step: 0.05 },
  { key: "jerk_brake_max", label: "jerk−", unit: "m/s³", step: 0.05 },
  { key: "T", label: "T", unit: "s", step: 0.1 },
  { key: "T_h", label: "T_h", unit: "s", step: 0.1 },
  { key: "s0", label: "s₀", unit: "m", step: 0.1 },
  { key: "pedal_tau_s", label: "pedal_τ", unit: "s", step: 0.1 },
  { key: "vdes_tau_s", label: "vdes_τ", unit: "s", step: 0.1 },
  { key: "descent_hold_gain", label: "hold", unit: "", step: 0.1 },
];

export const DRIVER_IDENTIFY_EXTRA_KEYS: Array<{
  key: "a_y" | "maxSpeedKmh";
  label: string;
  unit: string;
  step: number;
  digits?: number;
}> = [
  { key: "a_y", label: "a_y", unit: "m/s²", step: 0.1 },
  { key: "maxSpeedKmh", label: "Vmax", unit: "km/h", step: 5, digits: 0 },
];
