/** Local named driver library (IDM physics + base profile). */

import {
  BCB_DRIVER_A_Y,
  BCB_DRIVER_PHYSICS,
  DRIVER_PRESETS,
  completePhysics,
  physicsEqual,
  type DriverPhysics,
} from "@/lib/driverPresets";
import { migrateLegacyLibraries } from "@/lib/localStorageMigrate";
import type { DriverProfile } from "@/lib/types";

const STORAGE_KEY = "cyclegen.drivers.v3";
const MAX_DRIVERS = 40;

export type SavedDriver = {
  id: string;
  name: string;
  /** Closest / base Eco|Normal|Agressif|Sportif for Markov TPM. */
  baseProfile: DriverProfile;
  physics: DriverPhysics;
  a_y?: number | null;
  notes?: string;
  /** Built-in seed — cannot delete. */
  seed?: boolean;
  createdAt: string;
  updatedAt: string;
};

const nowSeed = "2024-01-01T00:00:00.000Z";

const SEED: SavedDriver[] = [
  ...DRIVER_PRESETS.map((p) => ({
    id: `seed-${p.presetId}`,
    name: p.label,
    baseProfile: p.id,
    physics: { ...p.physics },
    a_y: p.a_y,
    notes: p.blurb,
    seed: true,
    createdAt: nowSeed,
    updatedAt: nowSeed,
  })),
  {
    id: "seed-bcb",
    name: "Standard AVL (BCB)",
    baseProfile: "Normal" as DriverProfile,
    physics: { ...BCB_DRIVER_PHYSICS },
    a_y: BCB_DRIVER_A_Y,
    notes:
      "AVL CRUISE BCB — signature asymétrique a≤2,58 · b≤1,71 · jerk+≤0,96 · jerk−≤2,93 · T=1,4 s · T_h=4 s.",
    seed: true,
    createdAt: nowSeed,
    updatedAt: nowSeed,
  },
];

export const DEFAULT_DRIVER_ID = "seed-bcb";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asOptNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normalizePhysics(raw: unknown): DriverPhysics {
  if (!isRecord(raw)) {
    return completePhysics(null);
  }
  return completePhysics({
    a_max: asNum(raw.a_max, BCB_DRIVER_PHYSICS.a_max),
    b_comf: asNum(raw.b_comf, BCB_DRIVER_PHYSICS.b_comf),
    speed_factor: asNum(raw.speed_factor, BCB_DRIVER_PHYSICS.speed_factor),
    T: asOptNum(raw.T),
    T_h: asOptNum(raw.T_h),
    s0: asOptNum(raw.s0),
    jerk_max: asOptNum(raw.jerk_max),
    jerk_brake_max: asOptNum(raw.jerk_brake_max),
  });
}

function normalize(raw: unknown): SavedDriver | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;
  const bp = raw.baseProfile;
  const baseProfile: DriverProfile =
    bp === "Eco" ||
    bp === "Normal" ||
    bp === "Agressif" ||
    bp === "Sportif" ||
    bp === "Prudent" ||
    bp === "Dynamique"
      ? bp
      : "Normal";
  const createdAt =
    typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const updatedAt =
    typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  return {
    id,
    name,
    baseProfile,
    physics: normalizePhysics(raw.physics),
    a_y:
      typeof raw.a_y === "number" && Number.isFinite(raw.a_y) ? raw.a_y : null,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    seed: raw.seed === true || id.startsWith("seed-"),
    createdAt,
    updatedAt,
  };
}

function writeAll(list: SavedDriver[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota */
  }
}

function mergeSeeds(stored: SavedDriver[]): SavedDriver[] {
  const seedIds = new Set(SEED.map((s) => s.id));
  return [...SEED, ...stored.filter((d) => !seedIds.has(d.id))];
}

function readAll(): SavedDriver[] {
  if (typeof window === "undefined") return [...SEED];
  migrateLegacyLibraries();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      writeAll(SEED);
      return [...SEED];
    }
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) {
      writeAll(SEED);
      return [...SEED];
    }
    const parsed = data.map(normalize).filter((d): d is SavedDriver => !!d);
    const merged = mergeSeeds(parsed);
    writeAll(merged);
    return merged;
  } catch {
    return [...SEED];
  }
}

export function listDrivers(): SavedDriver[] {
  return readAll();
}

export function getDriver(id: string | null | undefined): SavedDriver | null {
  if (!id) return null;
  return readAll().find((d) => d.id === id) ?? null;
}

export function saveDriver(
  input: Omit<SavedDriver, "id" | "createdAt" | "updatedAt" | "seed"> & {
    id?: string;
  }
): SavedDriver {
  const list = readAll();
  const now = new Date().toISOString();
  const existing = input.id ? list.find((d) => d.id === input.id) : null;

  // Never mutate built-in seeds — always create a user copy
  if (existing?.seed || (!existing && input.id?.startsWith("seed-"))) {
    const clone: SavedDriver = {
      id: `drv-${Date.now().toString(36)}`,
      name: input.name.trim(),
      baseProfile: input.baseProfile,
      physics: completePhysics(input.physics),
      a_y: input.a_y ?? null,
      notes: input.notes,
      seed: false,
      createdAt: now,
      updatedAt: now,
    };
    const users = [clone, ...list.filter((d) => !d.seed)].slice(0, MAX_DRIVERS);
    writeAll(mergeSeeds(users));
    return clone;
  }

  if (existing) {
    const updated: SavedDriver = {
      ...existing,
      name: input.name.trim(),
      baseProfile: input.baseProfile,
      physics: completePhysics(input.physics),
      a_y: input.a_y ?? null,
      notes: input.notes,
      updatedAt: now,
      seed: false,
    };
    const without = list.filter((d) => d.id !== updated.id && !d.seed);
    writeAll(mergeSeeds([updated, ...without]));
    return updated;
  }

  const created: SavedDriver = {
    id: `drv-${Date.now().toString(36)}`,
    name: input.name.trim(),
    baseProfile: input.baseProfile,
    physics: completePhysics(input.physics),
    a_y: input.a_y ?? null,
    notes: input.notes,
    seed: false,
    createdAt: now,
    updatedAt: now,
  };
  const users = [created, ...list.filter((d) => !d.seed)].slice(0, MAX_DRIVERS);
  writeAll(mergeSeeds(users));
  return created;
}

export function deleteDriver(id: string): boolean {
  if (id.startsWith("seed-")) return false;
  const list = readAll();
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return false;
  writeAll(mergeSeeds(next.filter((d) => !d.seed)));
  return true;
}

export function driverLabel(d: SavedDriver | null | undefined): string {
  if (!d) return "Personnalisé";
  return d.name;
}

export function findSeedMatching(
  baseProfile: DriverProfile,
  physics: DriverPhysics
): SavedDriver | undefined {
  return listDrivers().find(
    (d) =>
      d.seed &&
      d.baseProfile === baseProfile &&
      physicsEqual(d.physics, physics)
  );
}

/**
 * Merge drivers from a Route Studio fit pack (or similar JSON).
 * Upserts by id; marks as seed when pack says so.
 */
export function upsertDriversFromPack(raw: unknown): number {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { drivers?: unknown }).drivers)
  ) {
    list = (raw as { drivers: unknown[] }).drivers;
  } else {
    return 0;
  }
  const incoming = list
    .map(normalize)
    .filter((d): d is SavedDriver => !!d);
  if (!incoming.length) return 0;
  const now = new Date().toISOString();
  const byId = new Map(readAll().map((d) => [d.id, d]));
  let n = 0;
  for (const d of incoming) {
    const prev = byId.get(d.id);
    byId.set(d.id, {
      ...d,
      createdAt: prev?.createdAt ?? d.createdAt ?? now,
      updatedAt: now,
      seed: d.seed === true || d.id.startsWith("route-studio-"),
    });
    n += 1;
  }
  const seeds = SEED.map((s) => s.id);
  const merged = [
    ...SEED,
    ...[...byId.values()].filter((d) => !seeds.includes(d.id)),
  ].slice(0, MAX_DRIVERS + SEED.length);
  writeAll(merged);
  return n;
}

export { physicsEqual };
