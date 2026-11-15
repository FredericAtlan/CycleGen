/**
 * Amorçage de la bibliothèque à partir du corpus public servi par l'API
 * (`/api/benchmark/sources`) : descentes alpines (Bikemap / VisuGPX / PJAMM),
 * cycle réglementaire WLTC et trajet GPS de démo.
 *
 * Exécuté une seule fois par navigateur (drapeau localStorage) pour ne pas
 * recréer des cycles que l'utilisateur aurait supprimés ; `force` relance.
 */
import { getBenchmarkSource, isApiConfigured, listBenchmarkSources } from "./api";
import { getSavedCycle, listSavedCycles, saveCycle } from "./cycleLibrary";
import { computeCycleStats, enrichSeriesFromGps } from "./cycleMetrics";
import type { BenchmarkSourceMeta, LatLon } from "./types";
import { DEFAULT_VEHICLE_ID } from "./vehicleLibrary";

/** Sources publiques chargées, dans l'ordre d'affichage voulu. */
export const PUBLIC_SEED_SOURCE_IDS = [
  "grossglockner_descent",
  "stelvio_north_descent",
  "iseran_descent",
  "wltc_class3",
  "demo_gps_richebourg_houdan",
] as const;

const SEED_FLAG = "cyclegen.publicCorpusSeed.v1";

export type PublicSeedResult = {
  imported: number;
  total: number;
  skipped: boolean;
  error?: string;
};

export function seedCycleId(sourceId: string): string {
  return `corpus_${sourceId}`;
}

function geometryFrom(lat?: number[] | null, lon?: number[] | null): LatLon[] {
  if (!lat?.length || !lon?.length || lat.length !== lon.length) return [];
  const out: LatLon[] = [];
  for (let i = 0; i < lat.length; i++) {
    if (Number.isFinite(lat[i]) && Number.isFinite(lon[i])) {
      out.push({ lat: lat[i], lon: lon[i] });
    }
  }
  return out;
}

async function saveFromCorpus(meta: BenchmarkSourceMeta): Promise<void> {
  const series = await getBenchmarkSource(meta.id);
  const enriched = enrichSeriesFromGps({
    time: series.time,
    velocity: series.velocity,
    acceleration: series.acceleration,
    a_lat: series.a_lat,
    slope: series.slope,
    position: series.position,
    lat: series.lat,
    lon: series.lon,
  });
  const stats = computeCycleStats({
    time: series.time,
    velocity: series.velocity,
    acceleration: enriched.acceleration,
    slope: enriched.slope,
    position: enriched.position,
    a_lat: enriched.a_lat,
  });
  saveCycle({
    id: seedCycleId(meta.id),
    name: meta.name,
    source: meta.source || meta.family || "corpus",
    sourceUrl: meta.url ?? null,
    origin: "corpus",
    corpusId: meta.id,
    stats,
    time: series.time,
    velocity: series.velocity,
    acceleration: enriched.acceleration,
    slope: enriched.slope,
    a_lat: enriched.a_lat,
    position: enriched.position,
    geometry: geometryFrom(series.lat, series.lon),
    meta: { vehicleId: DEFAULT_VEHICLE_ID, trafficSource: "profil_import" },
  });
}

function readFlag(): boolean {
  try {
    return localStorage.getItem(SEED_FLAG) === "1";
  } catch {
    return false;
  }
}

function writeFlag(): void {
  try {
    localStorage.setItem(SEED_FLAG, "1");
  } catch {
    /* stockage indisponible : on retentera au prochain chargement */
  }
}

/** Chargement en cours : partagé entre les appelants simultanés (accueil + bannière). */
let inFlight: Promise<PublicSeedResult> | null = null;

export function seedLibraryFromPublicCorpus(opts?: {
  force?: boolean;
}): Promise<PublicSeedResult> {
  if (!inFlight) {
    inFlight = runSeed(opts).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function runSeed(opts?: { force?: boolean }): Promise<PublicSeedResult> {
  if (typeof window === "undefined") {
    return { imported: 0, total: 0, skipped: true };
  }
  const total = () => listSavedCycles().length;
  if (!isApiConfigured()) {
    return {
      imported: 0,
      total: total(),
      skipped: true,
      error: "API non configurée : corpus public indisponible.",
    };
  }
  if (!opts?.force && readFlag()) {
    return { imported: 0, total: total(), skipped: true };
  }

  const wanted = new Set<string>(PUBLIC_SEED_SOURCE_IDS);
  let metas: BenchmarkSourceMeta[];
  try {
    metas = (await listBenchmarkSources()).filter((m) => wanted.has(m.id));
  } catch (e) {
    return {
      imported: 0,
      total: total(),
      skipped: false,
      error: e instanceof Error ? e.message : "Corpus public injoignable.",
    };
  }
  metas.sort(
    (a, b) =>
      PUBLIC_SEED_SOURCE_IDS.indexOf(a.id as (typeof PUBLIC_SEED_SOURCE_IDS)[number]) -
      PUBLIC_SEED_SOURCE_IDS.indexOf(b.id as (typeof PUBLIC_SEED_SOURCE_IDS)[number])
  );

  let imported = 0;
  const errors: string[] = [];
  // Ordre inverse : saveCycle insère en tête, la première source finit en haut.
  for (const meta of [...metas].reverse()) {
    if (getSavedCycle(seedCycleId(meta.id))) continue;
    try {
      await saveFromCorpus(meta);
      imported += 1;
    } catch (e) {
      errors.push(`${meta.id}: ${e instanceof Error ? e.message : "échec"}`);
    }
  }
  if (errors.length === 0) writeFlag();
  return {
    imported,
    total: total(),
    skipped: false,
    ...(errors.length ? { error: `Chargement partiel — ${errors.join(" ; ")}` } : {}),
  };
}
