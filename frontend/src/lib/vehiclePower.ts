/** Mechanical traction / braking power from road load + inertia + grade. */

import type { VehicleCard } from "./vehicleLibrary";

export type PowerSample = {
  /** Road-load force F0+F1·v+F2·v² (N), v in km/h. */
  f_road_n: number;
  /** Grade force m·g·sin(α) (N). */
  f_grade_n: number;
  /** Inertial force m·a (N). */
  f_inertia_n: number;
  /** Total longitudinal force at wheels (N). */
  f_trac_n: number;
  /** Mechanical power at wheels (W); >0 traction, <0 braking demand. */
  p_mech_w: number;
  p_trac_kw: number;
  /**
   * |P| when P&lt;0 at wheels (kW). Total braking power demand —
   * hydraulic + electric regen are not separated by this road-load model.
   */
  p_regen_kw: number;
};

const G = 9.80665;

/** Treat as stopped wheel (EP-SIM: apply max brake torque). */
const V_WHEEL_STOP_MPS = 0.05; // ≈ 0.18 km/h

/** WLTP-style road load: F = F0 + F1·v_kmh + F2·v_kmh² (N). */
export function roadLoadForceN(
  v_mps: number,
  vehicle: Pick<VehicleCard, "f0_n" | "f1_n_per_kph" | "f2_n_per_kph2">
): number {
  const vKmh = Math.max(0, v_mps) * 3.6;
  return (
    vehicle.f0_n +
    vehicle.f1_n_per_kph * vKmh +
    vehicle.f2_n_per_kph2 * vKmh * vKmh
  );
}

/**
 * Wheel force / power.
 * F_trac = F_road + m·g·sin(α) + m·a_lon
 * P = F_trac · v
 * τ = F_trac · r_dyn
 * ω_rpm = v / r_dyn · 60/(2π)
 *
 * Standstill rule (Grossglockner EP-SIM Space): if wheel speed ≈ 0 and
 * τ_brake_max is set, τ_wheel = −τ_brake_max (P stays 0).
 */
export function mechanicalPowerSample(args: {
  v_mps: number;
  a_lon_mps2: number;
  alpha_rad?: number | null;
  vehicle: Pick<
    VehicleCard,
    | "mass_kg"
    | "f0_n"
    | "f1_n_per_kph"
    | "f2_n_per_kph2"
    | "r_dyn_m"
    | "tau_brake_max_nm"
  >;
}): PowerSample & { wheel_torque_nm: number; wheel_rpm: number } {
  const v = Number.isFinite(args.v_mps) ? args.v_mps : 0;
  const a = Number.isFinite(args.a_lon_mps2) ? args.a_lon_mps2 : 0;
  const alpha =
    args.alpha_rad != null && Number.isFinite(args.alpha_rad)
      ? args.alpha_rad
      : 0;
  const m = Math.max(1, args.vehicle.mass_kg);
  const rDyn =
    args.vehicle.r_dyn_m > 0.05 ? args.vehicle.r_dyn_m : 0.32;
  const f_road_n = roadLoadForceN(v, args.vehicle);
  const f_grade_n = m * G * Math.sin(alpha);
  const f_inertia_n = m * a;
  const f_trac_n = f_road_n + f_grade_n + f_inertia_n;
  const vMotion = Math.max(0, v);
  const p_mech_w = f_trac_n * vMotion;
  const wheel_rpm = (vMotion / rDyn) * (60 / (2 * Math.PI));

  const tauMax = args.vehicle.tau_brake_max_nm;
  const stopped =
    !(vMotion > V_WHEEL_STOP_MPS) &&
    tauMax != null &&
    Number.isFinite(tauMax) &&
    tauMax > 0;
  const wheel_torque_nm = stopped ? -Math.abs(tauMax!) : f_trac_n * rDyn;

  return {
    f_road_n,
    f_grade_n,
    f_inertia_n,
    f_trac_n,
    p_mech_w,
    p_trac_kw: p_mech_w > 0 ? p_mech_w / 1000 : 0,
    p_regen_kw: p_mech_w < 0 ? -p_mech_w / 1000 : 0,
    wheel_torque_nm,
    wheel_rpm,
  };
}

export function lateralAccelApprox(
  v_mps: number,
  vCurve_mps: number | null | undefined,
  aY: number
): number {
  if (!(aY > 0) || vCurve_mps == null || !(vCurve_mps > 0.5)) return 0;
  // Straights use NON_BINDING_V_MPS (~1e6) — treat as no lateral constraint.
  if (vCurve_mps > 160 / 3.6) return 0;
  const v = Math.max(0, v_mps);
  return (v * v * aY) / (vCurve_mps * vCurve_mps);
}
