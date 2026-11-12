/** Client-side preview: apply driver filters to a source v(t) for live compare. */

import type { DriverPhysics } from "@/lib/driverPresets";

export type PreviewSeries = {
  time: number[];
  /** Source realized speed [m/s]. */
  v_src_mps: number[];
  /** Preview after physics filters [m/s]. */
  v_prev_mps: number[];
  a_src: number[];
  a_prev: number[];
};

export type PreviewStats = {
  /** RMSE(v_prev − v_src) in km/h */
  rmse_kmh: number;
  /** max |Δv| in km/h */
  max_abs_kmh: number;
  /** mean(v_prev − v_src) in km/h */
  bias_kmh: number;
};

function firstOrderLag(
  target: number,
  prev: number,
  tau_s: number,
  dt: number
): number {
  if (tau_s <= 1e-6 || dt <= 0) return target;
  const alpha = 1 - Math.exp(-dt / tau_s);
  return prev + alpha * (target - prev);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Reconstruct a filtered velocity profile from a source realized v(t).
 *
 * Pipeline (intentionally sensitive to UI sliders):
 *  1. v_des = source · sf, then vdes_τ low-pass
 *  2. a_cmd toward v_des with gain 1/T, clipped to [−b_comf, a_max]
 *  3. hold soft-brake when overshooting
 *  4. jerk± limit, then pedal_τ on a
 *  5. integrate → v_prev
 */
export function previewDriverOnSource(
  time: number[],
  velocity_mps: number[],
  physics: DriverPhysics
): PreviewSeries {
  const n = Math.min(time.length, velocity_mps.length);
  if (n < 3) {
    return {
      time: [],
      v_src_mps: [],
      v_prev_mps: [],
      a_src: [],
      a_prev: [],
    };
  }

  const t = time.slice(0, n);
  const vSrc = velocity_mps.slice(0, n).map((v) => Math.max(0, v));
  const aSrc = Array.from({ length: n }, () => 0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(t[i] - t[i - 1], 1e-3);
    aSrc[i] = (vSrc[i] - vSrc[i - 1]) / dt;
  }
  aSrc[0] = aSrc[1];

  const aMax = Math.max(0.05, physics.a_max);
  const bComf = Math.max(0.05, physics.b_comf);
  const jPlus = Math.max(0, physics.jerk_max);
  const jMinus = Math.max(0, physics.jerk_brake_max || physics.jerk_max);
  const sf = clamp(physics.speed_factor, 0.4, 1.5);
  const pedalTau = Math.max(0, physics.pedal_tau_s ?? 0);
  const vdesTau = Math.max(0, physics.vdes_tau_s ?? 0);
  const hold = Math.max(0, physics.descent_hold_gain ?? 0);
  const T = Math.max(0.25, physics.T || 1.5);
  // Slightly snappier than raw T so a_max / τ clip visibly vs source
  const Ttrack = Math.max(0.35, T * 0.65);

  const vPrev = Array.from({ length: n }, () => 0);
  const aPrev = Array.from({ length: n }, () => 0);
  vPrev[0] = vSrc[0];
  let vDesFilt = vSrc[0] * sf;
  let aFilt = 0;
  let aPrevStep = 0;

  for (let i = 1; i < n; i++) {
    const dt = Math.max(t[i] - t[i - 1], 1e-3);
    const vDesRaw = Math.max(0, vSrc[i] * sf);
    vDesFilt = firstOrderLag(vDesRaw, vDesFilt, vdesTau, dt);

    const v = vPrev[i - 1];
    const dv = vDesFilt - v;
    // Stronger tracking so a_max / τ visibly shape the curve
    let aCmd = clamp(dv / Ttrack, -bComf, aMax);

    if (hold > 0 && v > vDesFilt + 0.15) {
      aCmd = Math.min(aCmd, -hold * (v - vDesFilt));
    }

    let aJerk = aCmd;
    if (jPlus > 0 || jMinus > 0) {
      const jLim = aCmd >= aPrevStep ? jPlus : jMinus;
      if (jLim > 0) {
        const daMax = jLim * dt;
        aJerk = clamp(aCmd, aPrevStep - daMax, aPrevStep + daMax);
      }
    }

    aFilt = firstOrderLag(aJerk, aFilt, pedalTau, dt);
    aPrevStep = aFilt;
    aPrev[i] = aFilt;
    vPrev[i] = Math.max(0, v + aFilt * dt);
  }
  aPrev[0] = aPrev[1] ?? 0;

  return {
    time: t,
    v_src_mps: vSrc,
    v_prev_mps: vPrev,
    a_src: aSrc,
    a_prev: aPrev,
  };
}

export function previewStats(series: PreviewSeries): PreviewStats {
  const n = Math.min(series.v_src_mps.length, series.v_prev_mps.length);
  if (n < 1) return { rmse_kmh: 0, max_abs_kmh: 0, bias_kmh: 0 };
  let sse = 0;
  let sum = 0;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const dKmh = (series.v_prev_mps[i] - series.v_src_mps[i]) * 3.6;
    sse += dKmh * dKmh;
    sum += dKmh;
    maxAbs = Math.max(maxAbs, Math.abs(dKmh));
  }
  return {
    rmse_kmh: Math.sqrt(sse / n),
    max_abs_kmh: maxAbs,
    bias_kmh: sum / n,
  };
}

/** Stable string for remounting charts when any IDM param changes. */
export function physicsRevision(p: DriverPhysics): string {
  return [
    p.a_max,
    p.b_comf,
    p.speed_factor,
    p.T,
    p.T_h,
    p.s0,
    p.jerk_max,
    p.jerk_brake_max,
    p.pedal_tau_s ?? 0,
    p.vdes_tau_s ?? 0,
    p.descent_hold_gain ?? 0,
  ]
    .map((x) => Number(x).toFixed(4))
    .join("|");
}

/** Downsample for charting (keep ≤ maxPts). */
export function downsamplePreview(
  series: PreviewSeries,
  maxPts = 800
): PreviewSeries {
  const n = series.time.length;
  if (n <= maxPts) return series;
  const step = Math.max(1, Math.floor(n / maxPts));
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return {
    time: idx.map((i) => series.time[i]),
    v_src_mps: idx.map((i) => series.v_src_mps[i]),
    v_prev_mps: idx.map((i) => series.v_prev_mps[i]),
    a_src: idx.map((i) => series.a_src[i]),
    a_prev: idx.map((i) => series.a_prev[i]),
  };
}
