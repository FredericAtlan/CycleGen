/** Shared helpers for time-based Recharts axes (linear seconds, not categorical). */

export function formatTimeTick(t: number): string {
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round(t));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function formatTimeLabel(t: number): string {
  if (!Number.isFinite(t)) return "";
  return `t = ${Number(t).toFixed(1)} s`;
}

/** Distance axis tick (m → compact km when large). */
export function formatDistanceTick(s_m: number): string {
  if (!Number.isFinite(s_m)) return "";
  const s = Number(s_m);
  if (Math.abs(s) >= 1000) return `${(s / 1000).toFixed(1)} km`;
  return `${Math.round(s)} m`;
}

export function formatDistanceLabel(s_m: number): string {
  if (!Number.isFinite(s_m)) return "";
  const s = Number(s_m);
  if (Math.abs(s) >= 1000) return `s = ${(s / 1000).toFixed(2)} km`;
  return `s = ${s.toFixed(0)} m`;
}

/**
 * Resample a time series onto a uniform grid so the X axis is true time
 * (avoids Recharts categorical spacing ≈ sample index).
 */
export function resampleUniform<T extends Record<string, number>>(
  rows: T[],
  timeKey: keyof T & string,
  opts?: { maxPoints?: number; dtPrefer?: number }
): T[] {
  if (rows.length < 2) return rows;
  const maxPoints = opts?.maxPoints ?? 800;
  const dtPrefer = opts?.dtPrefer ?? 1;
  const t0 = Number(rows[0][timeKey]);
  const t1 = Number(rows[rows.length - 1][timeKey]);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return rows;

  const duration = t1 - t0;
  const dt =
    duration / dtPrefer + 1 > maxPoints
      ? duration / Math.max(maxPoints - 1, 1)
      : dtPrefer;
  const out: T[] = [];
  let j = 0;
  for (let t = t0; t <= t1 + 1e-9; t += dt) {
    while (j + 1 < rows.length && Number(rows[j + 1][timeKey]) < t) j += 1;
    const a = rows[j];
    const b = rows[Math.min(j + 1, rows.length - 1)];
    const ta = Number(a[timeKey]);
    const tb = Number(b[timeKey]);
    const u = tb > ta ? (t - ta) / (tb - ta) : 0;
    const row = { ...a } as T;
    (row as Record<string, number>)[timeKey] = t;
    for (const key of Object.keys(a) as (keyof T & string)[]) {
      if (key === timeKey) continue;
      const va = Number(a[key]);
      const vb = Number(b[key]);
      if (Number.isFinite(va) && Number.isFinite(vb)) {
        (row as Record<string, number>)[key] = va + u * (vb - va);
      }
    }
    out.push(row);
  }
  // Always include exact endpoint
  const last = rows[rows.length - 1];
  if (
    !out.length ||
    Math.abs(Number(out[out.length - 1][timeKey]) - Number(last[timeKey])) > 1e-6
  ) {
    out.push({ ...last });
  }
  return out;
}

/**
 * Recharts XAxis props for regular time in seconds.
 * Use dataMin/dataMax (not a fixed 0) so Brush can zoom the chart.
 */
export const TIME_X_AXIS_PROPS = {
  type: "number" as const,
  scale: "linear" as const,
  domain: ["dataMin", "dataMax"] as ["dataMin", "dataMax"],
  allowDecimals: false,
  tickFormatter: formatTimeTick,
};
