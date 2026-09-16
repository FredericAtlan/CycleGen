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
  rpa: number;
  stop_ratio: number;
  stops: number;
};

export type InferredDriverParams = {
  physics: DriverPhysics;
  baseProfile: DriverProfile;
  fingerprint: DriverFingerprint;
};

export type DriverMatch = {
  driver: SavedDriver;
  score: number; // 0–100, higher = closer
  delta: {
    a_max: number;
    b_comf: number;
    speed_factor: number;
  };
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[i];
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

/** Build kinematic fingerprint from a speed–time series (v in m/s). */
export function fingerprintFromProfile(
  time: number[],
  velocity: number[]
): DriverFingerprint {
  const n = Math.min(time.length, velocity.length);
  if (n < 3) {
    return {
      duration_s: 0,
      distance_m: 0,
      v_mean_mps: 0,
      v_max_mps: 0,
      mean_abs_accel: 0,
      p95_accel: 0,
      p95_decel: 0,
      p95_abs_accel: 0,
      rpa: 0,
      stop_ratio: 0,
      stops: 0,
    };
  }
  const t = time.slice(0, n);
  const v = velocity.slice(0, n);
  const a = deriveAccel(t, v);
  const duration_s = Math.max(0, t[n - 1] - t[0]);
  let distance_m = 0;
  let vSum = 0;
  let vMax = 0;
  let stopTime = 0;
  let stops = 0;
  let wasStopped = v[0] < 0.3;
  const accelPos: number[] = [];
  const accelNeg: number[] = [];
  const absA: number[] = [];
  let rpaNum = 0;

  for (let i = 0; i < n; i++) {
    const vi = Math.max(0, v[i]);
    vSum += vi;
    if (vi > vMax) vMax = vi;
    if (i > 0) {
      const dt = Math.max(t[i] - t[i - 1], 0);
      distance_m += 0.5 * (vi + Math.max(0, v[i - 1])) * dt;
      if (vi < 0.3) stopTime += dt;
    }
    const stopped = vi < 0.3;
    if (stopped && !wasStopped) stops += 1;
    wasStopped = stopped;
    const ai = a[i];
    absA.push(Math.abs(ai));
    if (ai > 0.05) accelPos.push(ai);
    if (ai < -0.05) accelNeg.push(-ai);
    if (ai > 0 && vi > 0.1) rpaNum += ai * vi;
  }

  accelPos.sort((x, y) => x - y);
  accelNeg.sort((x, y) => x - y);
  absA.sort((x, y) => x - y);

  return {
    duration_s,
    distance_m,
    v_mean_mps: vSum / n,
    v_max_mps: vMax,
    mean_abs_accel: absA.reduce((s, x) => s + x, 0) / Math.max(absA.length, 1),
    p95_accel: percentile(accelPos, 95) || percentile(absA, 90),
    p95_decel: percentile(accelNeg, 95) || percentile(absA, 90),
    p95_abs_accel: percentile(absA, 95),
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

/** Map observed kinematics → IDM-ish physics + nearest base profile. */
export function inferDriverParams(
  fp: DriverFingerprint
): InferredDriverParams {
  const a_max = round2(clamp(fp.p95_accel || fp.p95_abs_accel * 0.9, 0.8, 7.5));
  const b_comf = round2(clamp(fp.p95_decel || fp.p95_abs_accel, 1.2, 9));
  const vMeanKmh = fp.v_mean_mps * 3.6;
  // Heuristic speed factor from mean pace (urban → highway)
  let speed_factor = 0.94;
  if (vMeanKmh < 30) speed_factor = 0.88;
  else if (vMeanKmh < 45) speed_factor = 0.92;
  else if (vMeanKmh < 65) speed_factor = 0.96;
  else if (vMeanKmh < 90) speed_factor = 1.05;
  else speed_factor = 1.12;
  // Aggressiveness nudge from RPA / p95 accel
  if (fp.rpa > 0.35 || a_max >= 3.5) speed_factor = Math.max(speed_factor, 1.08);
  if (a_max <= 1.8 && fp.rpa < 0.2) speed_factor = Math.min(speed_factor, 0.95);
  speed_factor = round2(clamp(speed_factor, 0.7, 1.35));

  const physics: DriverPhysics = completePhysics({
    a_max,
    b_comf,
    speed_factor,
  });
  const baseProfile = nearestBaseProfile(physics);
  return { physics, baseProfile, fingerprint: fp };
}

export function nearestBaseProfile(physics: DriverPhysics): DriverProfile {
  let best: DriverProfile = "Normal";
  let bestD = Infinity;
  for (const p of DRIVER_PRESETS) {
    const d =
      Math.abs(p.physics.a_max - physics.a_max) / 4 +
      Math.abs(p.physics.b_comf - physics.b_comf) / 6 +
      Math.abs(p.physics.speed_factor - physics.speed_factor) / 0.3;
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
    Math.abs(a.speed_factor - b.speed_factor) / 0.25
  );
}

/** Rank library drivers by closeness to inferred physics (0–100 score). */
export function matchDriversToPhysics(
  physics: DriverPhysics,
  drivers?: SavedDriver[]
): DriverMatch[] {
  const list = drivers ?? listDrivers();
  return list
    .map((driver) => {
      const dist = physicsDistance(physics, driver.physics);
      const score = Math.max(0, Math.round(100 * (1 - dist / 2.5)));
      return {
        driver,
        score,
        delta: {
          a_max: round2(physics.a_max - driver.physics.a_max),
          b_comf: round2(physics.b_comf - driver.physics.b_comf),
          speed_factor: round2(physics.speed_factor - driver.physics.speed_factor),
        },
      };
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
