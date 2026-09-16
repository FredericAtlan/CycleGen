import type { LatLon, SpatialCorridor } from "@/lib/types";

/** Haversine distance in meters. */
function haversineM(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Linear interpolate along corridor geometry by curvilinear abscissa s (m).
 * Prefers corridor.S samples when aligned with geometry; else cumulative lengths.
 */
export function interpolateAlongS(
  corridor: Pick<SpatialCorridor, "S" | "geometry"> | null,
  s_m: number,
  fallbackGeometry?: LatLon[]
): LatLon | null {
  const geometry = corridor?.geometry?.length
    ? corridor.geometry
    : fallbackGeometry ?? [];
  if (geometry.length === 0) return null;
  if (geometry.length === 1) return geometry[0];

  const S =
    corridor &&
    corridor.S.length === geometry.length &&
    corridor.S.length >= 2
      ? corridor.S
      : buildCumulativeS(geometry);

  const sMax = S[S.length - 1];
  const s = Math.max(0, Math.min(s_m, sMax));

  let i = 0;
  while (i < S.length - 2 && S[i + 1] < s) i++;

  const s0 = S[i];
  const s1 = S[i + 1];
  const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
  const a = geometry[i];
  const b = geometry[i + 1];
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}

function buildCumulativeS(geometry: LatLon[]): number[] {
  const S = [0];
  for (let i = 1; i < geometry.length; i++) {
    S.push(S[i - 1] + haversineM(geometry[i - 1], geometry[i]));
  }
  return S;
}
