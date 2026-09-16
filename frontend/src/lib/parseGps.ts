import type { LatLon } from "@/lib/types";

/**
 * Parse free-text GPS positions into WGS84 lat/lon.
 * Accepts common paste formats from maps / GNSS:
 *   48.822, 1.617
 *   48.822;1.617
 *   48.822 1.617
 *   48,822 1,617   (comma decimals — rare; only if two groups)
 *   N 48.822 E 1.617
 *   48.822° N, 1.617° E
 */
export function parseGpsCoords(raw: string): LatLon | null {
  const q = raw.trim();
  if (!q) return null;

  // Degree / hemisphere style: 48.822 N 1.617 E
  const hemi = q.match(
    /^([NS])?\s*([+-]?\d+(?:[.,]\d+)?)\s*°?\s*([NS])?\s*[,;\s]+\s*([EW])?\s*([+-]?\d+(?:[.,]\d+)?)\s*°?\s*([EW])?$/i
  );
  if (hemi) {
    let lat = parseFloat(hemi[2].replace(",", "."));
    let lon = parseFloat(hemi[5].replace(",", "."));
    const ns = (hemi[1] || hemi[3] || "").toUpperCase();
    const ew = (hemi[4] || hemi[6] || "").toUpperCase();
    if (ns === "S") lat = -Math.abs(lat);
    if (ns === "N") lat = Math.abs(lat);
    if (ew === "W") lon = -Math.abs(lon);
    if (ew === "E") lon = Math.abs(lon);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  // Plain pair: lat, lon (comma / semicolon / whitespace)
  const pair = q.match(
    /^([+-]?\d+(?:[.,]\d+)?)\s*[,;\s]\s*([+-]?\d+(?:[.,]\d+)?)$/
  );
  if (pair) {
    const lat = parseFloat(pair[1].replace(",", "."));
    const lon = parseFloat(pair[2].replace(",", "."));
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }

  return null;
}

function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

/** Pretty label for a GPS fix (5 decimals ≈ 1 m). */
export function formatGpsLabel(p: LatLon): string {
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

export function isGpsQuery(raw: string): boolean {
  return parseGpsCoords(raw) != null;
}
