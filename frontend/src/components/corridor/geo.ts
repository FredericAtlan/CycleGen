import type { LatLon, SpatialCorridor } from "@/lib/types";

/** Nearest index in S for a given curvilinear abscissa (meters). */
export function nearestSIndex(S: number[], s_m: number): number {
  if (S.length === 0) return 0;
  let best = 0;
  let bestDist = Math.abs(S[0] - s_m);
  for (let i = 1; i < S.length; i++) {
    const d = Math.abs(S[i] - s_m);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Project an S abscissa onto corridor geometry via nearest S sample. */
export function projectSToLatLon(
  corridor: Pick<SpatialCorridor, "S" | "geometry">,
  s_m: number
): LatLon | null {
  const { S, geometry } = corridor;
  if (S.length === 0 || geometry.length === 0) return null;
  const idx = nearestSIndex(S, s_m);
  const geoIdx = Math.min(idx, geometry.length - 1);
  return geometry[geoIdx] ?? null;
}

/** Format KM label from meters: "KM 1.2". */
export function formatKm(s_m: number): string {
  return `KM ${(s_m / 1000).toFixed(1)}`;
}
