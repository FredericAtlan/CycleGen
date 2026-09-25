import type { DetectedEvent, FeuMeta, SpatialCorridor } from "@/lib/types";

const FEUX_META_MATCH_M = 15;

/** Snapshot of TLS abscissae + meta so « sans feux » can be undone. */
export type FeuxBackup = {
  S_feux: number[];
  feux_meta: FeuMeta[];
};

export function snapshotFeux(corridor: SpatialCorridor): FeuxBackup | null {
  const S_feux = corridor.S_feux ?? [];
  if (!S_feux.length) return null;
  return {
    S_feux: [...S_feux],
    feux_meta: (corridor.feux_meta ?? []).map((m) => ({ ...m })),
  };
}

export function restoreFeux(
  corridor: SpatialCorridor,
  backup: FeuxBackup
): SpatialCorridor {
  return withUpdatedFeux(
    { ...corridor, feux_meta: backup.feux_meta },
    backup.S_feux
  );
}

/** Rebuild corridor after editing traffic-light abscissae (meters). */
export function withUpdatedFeux(
  corridor: SpatialCorridor,
  S_feux: number[]
): SpatialCorridor {
  const sEnd = corridor.S.length ? corridor.S[corridor.S.length - 1] : 0;
  const sorted = [...S_feux]
    .map((s) => Math.max(0, Math.min(sEnd, Number(s))))
    .filter((s) => Number.isFinite(s))
    .sort((a, b) => a - b);

  // Dedup within 5 m
  const deduped: number[] = [];
  for (const s of sorted) {
    if (deduped.length === 0 || Math.abs(s - deduped[deduped.length - 1]) >= 5) {
      deduped.push(s);
    }
  }

  const otherEvents = corridor.events.filter((e) => e.kind !== "traffic_signal");
  const feuxEvents: DetectedEvent[] = deduped.map((s_m) => ({
    s_m,
    kind: "traffic_signal",
    label: "traffic_signal",
    value: null,
  }));

  const oldMeta = corridor.feux_meta ?? [];
  const feux_meta: FeuMeta[] = deduped.map((s_m) => {
    let best: FeuMeta | null = null;
    let bestD = Infinity;
    for (const m of oldMeta) {
      const d = Math.abs((m.s_m ?? 0) - s_m);
      if (d < bestD && d <= FEUX_META_MATCH_M) {
        bestD = d;
        best = m;
      }
    }
    if (best) {
      return {
        s_m,
        highway: best.highway ?? null,
        tls_mode: best.tls_mode ?? "stochastic",
      };
    }
    return { s_m, highway: null, tls_mode: "stochastic" as const };
  });

  return {
    ...corridor,
    S_feux: deduped,
    feux_meta,
    events: [...otherEvents, ...feuxEvents].sort((a, b) => a.s_m - b.s_m),
  };
}

/** Update tls_mode for a single light index; syncs feux_meta length to S_feux. */
export function withUpdatedFeuMode(
  corridor: SpatialCorridor,
  index: number,
  mode: "green_wave" | "stochastic"
): SpatialCorridor {
  const feux = corridor.S_feux ?? [];
  if (index < 0 || index >= feux.length) return corridor;

  const meta: FeuMeta[] = (corridor.feux_meta ?? []).map((m) => ({ ...m }));
  while (meta.length < feux.length) {
    meta.push({
      s_m: feux[meta.length],
      highway: null,
      tls_mode: "stochastic",
    });
  }
  meta[index] = {
    ...meta[index],
    s_m: feux[index],
    tls_mode: mode,
  };
  return { ...corridor, feux_meta: meta.slice(0, feux.length) };
}

/** Nearest sample index for time t in a consolidated profile. */
export function nearestTimeIndex(time: number[], t: number): number {
  if (time.length === 0) return 0;
  let best = 0;
  let bestD = Math.abs(time[0] - t);
  for (let i = 1; i < time.length; i++) {
    const d = Math.abs(time[i] - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Which speed sources enter V_envelope = min(...). */
export type EnvelopeMask = {
  legal: boolean;
  traffic: boolean;
  curve: boolean;
};

export const DEFAULT_ENVELOPE_MASK: EnvelopeMask = {
  legal: true,
  traffic: false,
  curve: true,
};

/**
 * Reference lateral acceleration (m/s²) used to compute the stored V_curve
 * in the corridor. The client-side scaling below assumes V_curve = √(a_y · R)
 * so V_curve_eff = V_curve_ref · √(a_y / a_y_ref). Keep in sync with the
 * default `a_y_mps2` used in `build_spatial_corridor` (3.5).
 */
export const A_Y_REF_MPS2 = 3.5;

function positiveMps(v: number | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  // Match backend: curve non-binding sentinel (~1e6 m/s) must not win the min
  if (v > 160 / 3.6) return null;
  return v;
}

/**
 * Rebuild V_envelope / V_limite from stored components according to mask.
 * Keeps V_limite_legal / V_traffic / V_curve intact for the chart decomposition.
 *
 * CRITICAL: after the elementwise min, apply a braking-feasible backward fill
 * (same as backend). Without it, mask toggles restore envelope "walls" and
 * the IDM look-ahead panics every few hundred metres (AVL vs CycleGen pump).
 */
export type EnvelopeMaskOpts = {
  /** Hard vehicle speed cap (km/h) — always applied when set. */
  globalMaxKmh?: number | null;
  /** Lateral comfort (m/s²) — scales V_curve via √(aY / A_Y_REF). */
  aY?: number | null;
  /** Optional user floor on V_envelope (km/h). */
  speedMinKmh?: number | null;
  /** Optional user ceiling on V_envelope (km/h). Distinct from Vmax vehicle. */
  speedMaxKmh?: number | null;
};

export function applyEnvelopeMask(
  corridor: SpatialCorridor,
  mask: EnvelopeMask,
  opts?: EnvelopeMaskOpts
): SpatialCorridor {
  const n = corridor.S.length;
  if (n === 0) return corridor;

  const legal = corridor.V_limite_legal ?? [];
  const traffic = corridor.V_traffic ?? [];
  const curve = corridor.V_curve ?? [];
  const prev =
    corridor.V_envelope?.length === n
      ? corridor.V_envelope
      : corridor.V_limite;

  const vCapMps =
    opts?.globalMaxKmh != null &&
    Number.isFinite(opts.globalMaxKmh) &&
    opts.globalMaxKmh >= 30
      ? opts.globalMaxKmh / 3.6
      : null;

  // a_y scaling factor (V_curve ∝ √a_y). Only downscale when < ref: upscaling
  // above the reference would violate the physics used at corridor build time.
  const aYRatio =
    opts?.aY != null &&
    Number.isFinite(opts.aY) &&
    opts.aY > 0
      ? Math.sqrt(opts.aY / A_Y_REF_MPS2)
      : 1.0;

  const vMinMps =
    opts?.speedMinKmh != null &&
    Number.isFinite(opts.speedMinKmh) &&
    opts.speedMinKmh > 0
      ? opts.speedMinKmh / 3.6
      : null;
  const vMaxMps =
    opts?.speedMaxKmh != null &&
    Number.isFinite(opts.speedMaxKmh) &&
    opts.speedMaxKmh > 0
      ? opts.speedMaxKmh / 3.6
      : null;

  const raw: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const parts: number[] = [];
    if (mask.legal) {
      const v = positiveMps(legal[i]);
      if (v != null) parts.push(v);
    }
    if (mask.traffic) {
      const v = positiveMps(traffic[i]);
      if (v != null) parts.push(v);
    }
    if (mask.curve) {
      const v = positiveMps(curve[i]);
      if (v != null) parts.push(v * aYRatio);
    }
    if (vCapMps != null) parts.push(vCapMps);
    if (vMaxMps != null) parts.push(vMaxMps);
    if (parts.length > 0) {
      raw[i] = Math.min(...parts);
    } else {
      raw[i] = positiveMps(prev[i]) ?? 0;
    }
  }

  // Mirror backend: braking-feasible fill then spatial MA (~C⁰).
  const feasible = brakingFeasibleSpeed(corridor.S, raw, 1.71);
  let V_envelope = smoothEnvelopeSpatial(corridor.S, feasible, 50);

  if (vMinMps != null) {
    V_envelope = V_envelope.map((v) => Math.max(v, vMinMps));
  }
  if (vMaxMps != null) {
    V_envelope = V_envelope.map((v) => Math.min(v, vMaxMps));
  }

  return {
    ...corridor,
    V_envelope,
    V_limite: V_envelope,
  };
}

/** Backward fill: v[i] ≤ speed that can still brake to v[i+1] at b_plan. */
export function brakingFeasibleSpeed(
  S: number[],
  V: number[],
  bPlanMps2 = 2.0
): number[] {
  const n = Math.min(S.length, V.length);
  if (n === 0) return [];
  const b = Math.max(0.3, bPlanMps2);
  const out = V.slice(0, n).map((v) => (Number.isFinite(v) ? v : 0));
  for (let i = n - 2; i >= 0; i--) {
    const ds = Math.max(S[i + 1] - S[i], 1e-3);
    const vNext = Math.max(0, out[i + 1]);
    const vCap = Math.sqrt(Math.max(0, vNext * vNext + 2 * b * ds));
    out[i] = Math.min(out[i], vCap);
  }
  return out;
}

/** Spatial moving average on envelope (approximate C⁰). */
export function smoothEnvelopeSpatial(
  S: number[],
  V: number[],
  windowM = 50
): number[] {
  const n = Math.min(S.length, V.length);
  if (n === 0) return [];
  if (n === 1 || windowM <= 0) return V.slice(0, n);
  const half = windowM * 0.5;
  const out: number[] = [];
  let j0 = 0;
  let j1 = 0;
  for (let i = 0; i < n; i++) {
    const si = S[i];
    while (j0 < n && S[j0] < si - half) j0 += 1;
    if (j1 < j0) j1 = j0;
    while (j1 < n && S[j1] <= si + half) j1 += 1;
    let sum = 0;
    let count = 0;
    for (let j = j0; j < j1; j++) {
      if (Number.isFinite(V[j]) && V[j] > 0) {
        sum += V[j];
        count += 1;
      }
    }
    out.push(count > 0 ? sum / count : V[i]);
  }
  return out;
}

export function envelopeMaskActiveCount(mask: EnvelopeMask): number {
  return (
    (mask.legal ? 1 : 0) + (mask.traffic ? 1 : 0) + (mask.curve ? 1 : 0)
  );
}

