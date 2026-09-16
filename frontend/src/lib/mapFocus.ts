/** Map camera focus requests shared between charts and Leaflet. */
export type MapFocusRequest =
  | { kind: "route"; nonce: number }
  | { kind: "A"; nonce: number }
  | { kind: "B"; nonce: number }
  /** Fit departure / arrival / stops (before Analyze). */
  | { kind: "points"; nonce: number }
  /** Fit injected corpus / reference GPS polyline. */
  | { kind: "reference"; nonce: number }
  /** Explicit lat/lon list (avoids stale state races). */
  | { kind: "bounds"; points: { lat: number; lon: number }[]; nonce: number }
  | { kind: "range"; s0: number; s1: number; nonce: number }
  | { kind: "cursor"; s: number; nonce: number };

export type MapFocusInput =
  | { kind: "route" }
  | { kind: "A" }
  | { kind: "B" }
  | { kind: "points" }
  | { kind: "reference" }
  | { kind: "bounds"; points: { lat: number; lon: number }[] }
  | { kind: "range"; s0: number; s1: number }
  | { kind: "cursor"; s: number };

export function nextFocus(partial: MapFocusInput, nonce: number): MapFocusRequest {
  return { ...partial, nonce } as MapFocusRequest;
}

/** Slice corridor geometry between two curvilinear abscissae (meters). */
export function geometrySliceByS(
  S: number[],
  geometry: { lat: number; lon: number }[],
  s0: number,
  s1: number
): { lat: number; lon: number }[] {
  if (!S.length || !geometry.length) return [];
  const lo = Math.min(s0, s1);
  const hi = Math.max(s0, s1);
  const n = Math.min(S.length, geometry.length);
  const out: { lat: number; lon: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (S[i] >= lo && S[i] <= hi) out.push(geometry[i]);
  }
  // Ensure at least endpoints if empty
  if (out.length < 2) {
    let i0 = 0;
    let i1 = n - 1;
    for (let i = 0; i < n; i++) {
      if (S[i] <= lo) i0 = i;
      if (S[i] >= hi) {
        i1 = i;
        break;
      }
    }
    return [geometry[i0], geometry[i1]].filter(Boolean);
  }
  return out;
}
