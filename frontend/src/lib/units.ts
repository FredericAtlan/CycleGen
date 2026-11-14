/** Slope display units — storage remains radians in the API. */
export type SlopeUnit = "percent" | "deg" | "rad";

export const SLOPE_UNITS: { id: SlopeUnit; label: string; hint: string }[] = [
  { id: "percent", label: "%", hint: "Grade (rise/run × 100)" },
  { id: "deg", label: "°", hint: "Angle in degrees" },
  { id: "rad", label: "rad", hint: "Angle in radians (solver native)" },
];

/** Convert slope from radians (API) to the selected display unit. */
export function slopeFromRad(alphaRad: number, unit: SlopeUnit): number {
  if (unit === "rad") return alphaRad;
  if (unit === "deg") return (alphaRad * 180) / Math.PI;
  // percent grade = tan(α) × 100
  return Math.tan(alphaRad) * 100;
}

export function slopeUnitLabel(unit: SlopeUnit): string {
  if (unit === "percent") return "%";
  if (unit === "deg") return "°";
  return "rad";
}

export function formatSlope(alphaRad: number, unit: SlopeUnit, digits?: number): string {
  const v = slopeFromRad(alphaRad, unit);
  const d = digits ?? (unit === "percent" ? 1 : unit === "deg" ? 2 : 4);
  return v.toFixed(d);
}

/** Min / max of a slope series stored in radians, in the chosen display unit. */
export function slopeExtremes(
  alphaRad: readonly number[] | null | undefined,
  unit: SlopeUnit
): { min: number; max: number } | null {
  if (!alphaRad?.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const a of alphaRad) {
    if (!Number.isFinite(a)) continue;
    const v = slopeFromRad(a, unit);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

export function formatSlopeExtremes(
  alphaRad: readonly number[] | null | undefined,
  unit: SlopeUnit
): string | null {
  const ext = slopeExtremes(alphaRad, unit);
  if (!ext) return null;
  const digits = unit === "percent" ? 1 : unit === "deg" ? 2 : 4;
  const u = slopeUnitLabel(unit);
  return `min ${ext.min.toFixed(digits)} ${u} · max ${ext.max.toFixed(digits)} ${u}`;
}
