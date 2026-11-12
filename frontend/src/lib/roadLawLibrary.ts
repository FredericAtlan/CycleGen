/**
 * Named road laws (legal filter presets) — async Dexie bank + sync helpers.
 */

import Dexie, { type Table } from "dexie";
import {
  DEFAULT_LEGAL_FILTER,
  normalizeLegalFilter,
  type LegalFilterOptions,
  type LegalSmoothMode,
} from "@/lib/legalFilter";

export type RoadLaw = {
  id: string;
  name: string;
  /** Region / tag (Alpine AT, FR default, …). */
  region: string;
  filter: LegalFilterOptions;
  /** Optional hard V_max cap km/h (null = none). */
  vMaxCapKmh: number | null;
  notes?: string;
  seed?: boolean;
  updatedAt: string;
};

const SEED: RoadLaw[] = [
  {
    id: "law-fr-default",
    name: "France défaut",
    region: "FR",
    filter: { ...DEFAULT_LEGAL_FILTER },
    vMaxCapKmh: 130,
    notes: "Majorité 250 m · minRun 120 m · cap 130.",
    seed: true,
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "law-alpine-at",
    name: "Alpine AT",
    region: "AT",
    filter: { mode: "majority" as LegalSmoothMode, windowM: 150, minRunM: 80 },
    vMaxCapKmh: 100,
    notes: "Col / Alpes Autriche — fenêtre plus courte, cap 100.",
    seed: true,
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "law-raw",
    name: "Brut (aucun filtre)",
    region: "ANY",
    filter: { mode: "none", windowM: 0, minRunM: 0 },
    vMaxCapKmh: null,
    notes: "V_legal brut — debug.",
    seed: true,
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
];

class RoadLawDB extends Dexie {
  roadLaws!: Table<RoadLaw, string>;

  constructor() {
    super("cyclegen_road_laws_v1");
    this.version(1).stores({
      roadLaws: "id, region, name, updatedAt",
    });
  }
}

let db: RoadLawDB | null = null;
let seedPromise: Promise<void> | null = null;

function getDb(): RoadLawDB | null {
  if (typeof window === "undefined") return null;
  if (!db) db = new RoadLawDB();
  return db;
}

async function ensureSeeded(): Promise<void> {
  const d = getDb();
  if (!d) return;
  if (!seedPromise) {
    seedPromise = (async () => {
      const n = await d.roadLaws.count();
      if (n === 0) {
        await d.roadLaws.bulkPut(SEED);
        return;
      }
      // Upsert seeds by id without clobbering user edits of same id.
      for (const s of SEED) {
        const existing = await d.roadLaws.get(s.id);
        if (!existing) await d.roadLaws.put(s);
      }
    })();
  }
  await seedPromise;
}

export async function listRoadLawsAsync(): Promise<RoadLaw[]> {
  await ensureSeeded();
  const d = getDb();
  if (!d) return [...SEED];
  return d.roadLaws.orderBy("name").toArray();
}

/** Sync snapshot for explorateur (may be stale until hydrate). */
export function listRoadLawsSync(): RoadLaw[] {
  return [...SEED];
}

export async function getRoadLawAsync(id: string): Promise<RoadLaw | null> {
  await ensureSeeded();
  const d = getDb();
  if (!d) return SEED.find((x) => x.id === id) ?? null;
  return (await d.roadLaws.get(id)) ?? null;
}

export function getRoadLawSync(id: string): RoadLaw | null {
  return SEED.find((x) => x.id === id) ?? null;
}

export async function saveRoadLawAsync(
  input: Omit<RoadLaw, "updatedAt" | "seed"> & { seed?: boolean }
): Promise<RoadLaw> {
  await ensureSeeded();
  const d = getDb();
  const now = new Date().toISOString();
  const law: RoadLaw = {
    ...input,
    filter: normalizeLegalFilter(input.filter),
    seed: input.seed === true,
    updatedAt: now,
  };
  if (d) await d.roadLaws.put(law);
  return law;
}

export async function deleteRoadLawAsync(id: string): Promise<boolean> {
  await ensureSeeded();
  const d = getDb();
  if (!d) return false;
  const row = await d.roadLaws.get(id);
  if (!row || row.seed) return false;
  await d.roadLaws.delete(id);
  return true;
}

export function roadLawToLegalFilter(law: RoadLaw): LegalFilterOptions {
  return normalizeLegalFilter(law.filter);
}
