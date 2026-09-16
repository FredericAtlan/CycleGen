/** Map slope coloring shared by studio map and Excel vignettes. */

/** Map slope α (rad) → color: green downhill → amber flat → red uphill. */
export function alphaToColor(alphaRad: number): string {
  const pct = Math.tan(alphaRad) * 100;
  // Clamp grade contribution to ±8 % for color mapping; quantize for polyline batching
  const t = Math.max(-1, Math.min(1, pct / 8));
  const qt = Math.round(t * 8) / 8;
  if (qt <= 0) {
    const u = qt + 1; // 0..1
    return lerpHex("#16a34a", "#f59e0b", u);
  }
  return lerpHex("#f59e0b", "#dc2626", qt);
}

function lerpHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * t);
  const g = Math.round(pa.g + (pb.g - pa.g) * t);
  const bl = Math.round(pa.b + (pb.b - pa.b) * t);
  return `rgb(${r},${g},${bl})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
