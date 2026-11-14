/** Parse Nominatim-style "…, City, …, Country" display names. */

export type PlaceParts = {
  city: string;
  country: string;
};

/**
 * Best-effort city / country from a free-text place label.
 * Nominatim: "Street, City, Dept, Region, Country" → city = first token, country = last.
 */
export function parsePlaceFromLabel(
  label: string | null | undefined
): PlaceParts {
  const raw = (label ?? "").trim();
  if (!raw) return { city: "—", country: "—" };
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { city: "—", country: "—" };
  if (parts.length === 1) return { city: parts[0], country: "—" };
  return {
    city: parts[0],
    country: parts[parts.length - 1],
  };
}

export function formatCoord(lat: number | null | undefined, lon: number | null | undefined): string {
  if (
    lat == null ||
    lon == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return "—";
  }
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
