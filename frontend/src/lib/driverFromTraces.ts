/** Shared: identify & save drivers from trace files (CSV/XLS/XLSX). */

import {
  aggregateDriverFingerprints,
  fingerprintDriverFile,
  previewDriverFile,
  type DriverColumnMapping,
  type DriverFingerprintResponse,
  type DriverPreviewResponse,
} from "@/lib/api";
import { completePhysics, type DriverPhysics } from "@/lib/driverPresets";
import { saveDriver, type SavedDriver } from "@/lib/driverLibrary";
import type { DriverProfile } from "@/lib/types";

export const MAX_TRACE_FILES = 8;

export type TracePending = {
  fileName: string;
  result: DriverFingerprintResponse;
  style: string;
  mapping?: DriverColumnMapping;
};

/** File awaiting Temps / Vitesse column confirmation. */
export type TraceDraft = {
  file: File;
  preview: DriverPreviewResponse;
  col_t: number;
  col_v: number;
  v_unit: "mps" | "kmh";
};

export function asDriverProfile(s: string): DriverProfile {
  if (
    s === "Eco" ||
    s === "Normal" ||
    s === "Agressif" ||
    s === "Sportif" ||
    s === "Prudent" ||
    s === "Dynamique"
  ) {
    return s;
  }
  const lower = s.toLowerCase();
  if (lower.includes("prudent") || lower.includes("eco")) return "Prudent";
  if (lower.includes("dynam") || lower.includes("sport")) return "Dynamique";
  return "Normal";
}

export function guessTraceStyle(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("prudent") || n.includes("eco")) return "prudent";
  if (n.includes("dynam") || n.includes("sport")) return "dynamique";
  if (n.includes("prea") || n.includes("pre-a") || n.includes("pre_a"))
    return "prea";
  return "custom";
}

export function isTabularTrace(fileName: string): boolean {
  return /\.(csv|xls|xlsx)$/i.test(fileName);
}

function unitFromSuggested(u: string | null | undefined): "mps" | "kmh" {
  return u === "mps" ? "mps" : "kmh";
}

/** Preview a tabular file and seed column mapping from server suggestions. */
export async function previewTraceFile(file: File): Promise<TraceDraft> {
  const preview = await previewDriverFile(file);
  const sug = preview.suggested;
  const col_t =
    typeof sug.col_t === "number" && sug.col_t >= 0
      ? sug.col_t
      : 0;
  let col_v =
    typeof sug.col_v === "number" && sug.col_v >= 0
      ? sug.col_v
      : Math.min(1, Math.max(0, preview.headers.length - 1));
  if (col_v === col_t && preview.headers.length > 1) {
    col_v = col_t === 0 ? 1 : 0;
  }
  return {
    file,
    preview,
    col_t,
    col_v,
    v_unit: unitFromSuggested(sug.v_unit),
  };
}

export async function analyzeTraceFile(
  file: File,
  mapping?: Partial<DriverColumnMapping> | null
): Promise<TracePending> {
  const result = await fingerprintDriverFile(file, mapping);
  return {
    fileName: file.name,
    result,
    style: guessTraceStyle(file.name),
    mapping:
      mapping?.col_t != null && mapping?.col_v != null
        ? {
            col_t: mapping.col_t,
            col_v: mapping.col_v,
            v_unit: mapping.v_unit === "mps" ? "mps" : "kmh",
          }
        : undefined,
  };
}

/** Confirm draft mapping → fingerprint. */
export async function analyzeTraceDraft(draft: TraceDraft): Promise<TracePending> {
  return analyzeTraceFile(draft.file, {
    col_t: draft.col_t,
    col_v: draft.col_v,
    v_unit: draft.v_unit,
  });
}

export function saveDriverFromTrace(
  p: TracePending,
  overrides?: {
    name?: string;
    baseProfile?: DriverProfile;
    physics?: DriverPhysics;
    a_y?: number | null;
  }
): SavedDriver {
  const phys = completePhysics(
    overrides?.physics ?? {
      ...p.result.physics,
      pedal_tau_s: p.result.physics.pedal_tau_s ?? 0,
      vdes_tau_s: p.result.physics.vdes_tau_s ?? 0,
      descent_hold_gain: p.result.physics.descent_hold_gain ?? 0,
    }
  );
  const sp = p.result.source_profile;
  const sourceProfile =
    sp && Array.isArray(sp.time) && Array.isArray(sp.velocity_mps)
      ? {
          filename: p.fileName,
          fingerprint: { ...p.result.fingerprint },
          time: sp.time,
          velocity_mps: sp.velocity_mps,
          n_raw: sp.n_raw ?? p.result.n_points,
        }
      : {
          filename: p.fileName,
          fingerprint: { ...p.result.fingerprint },
          time: [] as number[],
          velocity_mps: [] as number[],
          n_raw: p.result.n_points,
        };
  return saveDriver({
    name:
      overrides?.name ??
      p.fileName.replace(/\.(xls|xlsx|csv|json)$/i, ""),
    baseProfile:
      overrides?.baseProfile ??
      asDriverProfile(p.result.physics.base_profile),
    physics: phys,
    a_y: overrides?.a_y !== undefined ? overrides.a_y : p.result.physics.a_y ?? null,
    notes: `importé depuis ${p.fileName}`,
    tags: ["RS", p.style].filter(Boolean),
    sourceSha256: p.result.source_sha256,
    sourceProfile,
  });
}

export async function aggregateAndSaveDrivers(
  pending: TracePending[]
): Promise<SavedDriver[]> {
  if (pending.length < 2) {
    throw new Error("Il faut au moins 2 fichiers pour fusionner");
  }
  const pack = await aggregateDriverFingerprints(
    pending.map((p) => ({
      style: p.style,
      fingerprint: p.result.fingerprint,
    }))
  );
  const styles = ["prudent", "dynamique", "prea"] as const;
  const saved: SavedDriver[] = [];
  for (const st of styles) {
    const block = pack[st] as
      | { n?: number; physics?: Record<string, number> }
      | undefined;
    if (!block?.physics || !block.n) continue;
    const phys = completePhysics({
      a_max: Number(block.physics.a_max),
      b_comf: Number(block.physics.b_comf),
      speed_factor: Number(block.physics.speed_factor),
      T: Number(block.physics.T),
      T_h: Number(block.physics.T_h),
      s0: Number(block.physics.s0),
      jerk_max: Number(block.physics.jerk_max),
      jerk_brake_max: Number(block.physics.jerk_brake_max),
      pedal_tau_s: Number(block.physics.pedal_tau_s) || 0,
      vdes_tau_s: Number(block.physics.vdes_tau_s) || 0,
      descent_hold_gain: Number(block.physics.descent_hold_gain) || 0,
    });
    saved.push(
      saveDriver({
        name: `RS Aggregated ${st}`,
        baseProfile: asDriverProfile(String(block.physics.base_profile ?? st)),
        physics: phys,
        a_y: typeof block.physics.a_y === "number" ? block.physics.a_y : null,
        notes: `aggregate n=${block.n}`,
        tags: ["RS", "aggregate", st],
      })
    );
  }
  return saved;
}
