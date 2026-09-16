/** Distance-based driver parameter zones (CycleGen). */

import { completePhysics, type DriverPhysics } from "./driverPresets";

export type DriverZone = {
  id: string;
  label: string;
  /** Inclusive start abscissa (m). */
  s0_m: number;
  /** Exclusive end abscissa (m); null = corridor end. */
  s1_m: number | null;
  physics: DriverPhysics;
  /** Optional lateral comfort override for this zone (m/s²). */
  a_y?: number | null;
};

/** Renault Grossglockner Route Planner — Test limits (Summery sheet). */
export const RENAULT_GROSSGLOCKNER_ZONES: DriverZone[] = [
  {
    id: "z1",
    label: "1st Part",
    s0_m: 0,
    s1_m: 1116,
    physics: completePhysics({ a_max: 2.5, b_comf: 3.6, speed_factor: 1.0 }),
    a_y: 3.15,
  },
  {
    id: "z2",
    label: "2nd Part",
    s0_m: 1116,
    s1_m: null,
    physics: completePhysics({ a_max: 4.715, b_comf: 5.0, speed_factor: 1.0 }),
    a_y: 6.17,
  },
];

export const RENAULT_GROSSGLOCKNER_ZONE2_S0_M = 1116;

export function zoneAtS(zones: DriverZone[], s_m: number): DriverZone | null {
  if (!zones.length) return null;
  const sorted = [...zones].sort((a, b) => a.s0_m - b.s0_m);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const z = sorted[i];
    if (s_m + 1e-6 < z.s0_m) continue;
    if (z.s1_m != null && s_m >= z.s1_m) continue;
    return z;
  }
  return sorted[0] ?? null;
}

export function normalizeZones(zones: DriverZone[]): DriverZone[] {
  return [...zones]
    .map((z, i) => ({
      ...z,
      id: z.id || `z${i + 1}`,
      s0_m: Math.max(0, Number(z.s0_m) || 0),
      s1_m:
        z.s1_m == null || !Number.isFinite(Number(z.s1_m))
          ? null
          : Math.max(0, Number(z.s1_m)),
    }))
    .sort((a, b) => a.s0_m - b.s0_m);
}
