/** Local library of saved driving cycles (profiles + traceability metadata). */

import type { EnvelopeMask } from "./corridorEdit";
import { DEFAULT_ENVELOPE_MASK } from "./corridorEdit";
import type { DriverPhysics } from "./driverPresets";
import { DEFAULT_A_Y, presetFor } from "./driverPresets";
import type { DriverZone } from "./driverZones";
import { RENAULT_GROSSGLOCKNER_ZONES } from "./driverZones";
import type { SlopeAlgoOptions } from "./slopeAlgo";
import { DEFAULT_SLOPE_ALGO, normalizeSlopeAlgo } from "./slopeAlgo";
import type { LegalFilterOptions } from "./legalFilter";
import { normalizeLegalFilter } from "./legalFilter";
import type {
  ConsolidatedProfile,
  DriverProfile,
  LatLon,
  RouteAnalyzeResponse,
  RoutingProfile,
  SimEngine,
  SpatialCorridor,
  WaypointDraft,
} from "./types";
import {
  computeCycleStats,
  downsampleGeometry,
  downsampleSeries,
  type CycleStats,
} from "./cycleMetrics";
import {
  saveStudioSession,
  type StudioSessionSnapshot,
} from "./studioSession";
import { DEFAULT_VEHICLE_ID } from "./vehicleLibrary";

const STORAGE_KEY = "cyclegen.savedCycles.v1";
const MAX_CYCLES = 30;

export type CycleOrigin = "cyclegen" | "corpus" | "import";

export type CycleLimitOverlay = {
  legal_kmh: number[];
  traffic_kmh: number[];
  curve_kmh: number[];
};

/** Studio snapshot persisted with a CycleGen-generated save. */
export type SavedCycleStudioMeta = {
  driverProfile?: string;
  /** Named driver from local library. */
  driverId?: string | null;
  driverName?: string | null;
  trafficSource?: string;
  routeLabel?: string;
  /** Titre saisi à la sauvegarde (sinon nom = GPS A → GPS B). */
  saveTitle?: string;
  /** GPS départ format « lat, lon ». */
  gpsOrigin?: string;
  origin_lat?: number | null;
  origin_lon?: number | null;
  /** GPS arrivée format « lat, lon ». */
  gpsDestination?: string;
  destination_lat?: number | null;
  destination_lon?: number | null;
  notes?: string;
  citation?: string;
  license?: string;
  sourceUrl?: string;
  routingProfile?: string;
  departAt?: string;
  aY?: number;
  physics?: DriverPhysics;
  maxSpeedKmh?: number | null;
  vehicleId?: string | null;
  preferredEngine?: string;
  envelopeMask?: EnvelopeMask;
  slopeAlgo?: SlopeAlgoOptions;
  legalFilter?: LegalFilterOptions;
  includeTrafficLights?: boolean;
  driverZonesEnabled?: boolean;
  driverZones?: DriverZone[];
  waypoints?: WaypointDraft[];
  elevationA_m?: number | null;
  elevationB_m?: number | null;
  /** Library table hint (optional). */
  has_tls?: boolean;
  /**
   * Pack pré-enregistré démo : trajet + corridor + conducteur + profil
   * doivent peupler les 4 étapes du wizard à l’ouverture.
   */
  studioComplete?: boolean;
  librarySigle?: boolean;
};

export type SavedCycle = {
  id: string;
  name: string;
  savedAt: string;
  /** Human provenance, e.g. "CycleGen · Normal" or corpus id. */
  source: string;
  /** Site internet / URL de la source (corpus open data, etc.). */
  sourceUrl?: string | null;
  origin: CycleOrigin;
  corpusId?: string | null;
  stats: CycleStats;
  time: number[];
  /** m/s */
  velocity: number[];
  /** Longitudinal accel m/s² */
  acceleration: number[];
  /** Slope rad */
  slope: number[];
  /** Lateral / tangential accel m/s² (optional) */
  a_lat: number[];
  position: number[];
  geometry: LatLon[];
  /** True when a time/velocity profile is present. */
  resultAvailable: boolean;
  /** DEM altitude extremes along corridor (m). */
  z_min_m?: number | null;
  z_max_m?: number | null;
  /** Optional slim corridor snapshot for restore without rebuild. */
  corridor?: SpatialCorridor | null;
  /** Only for CycleGen-generated cycles with corridor. */
  limits?: CycleLimitOverlay | null;
  meta?: SavedCycleStudioMeta;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asNumArr(v: unknown): number[] {
  return Array.isArray(v) ? (v as number[]).map((x) => Number(x) || 0) : [];
}

function asOptNum(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** Min / max of a finite elevation series (m). */
export function elevationExtremesM(
  elevations: number[] | null | undefined
): { z_min_m: number | null; z_max_m: number | null } {
  if (!elevations?.length) return { z_min_m: null, z_max_m: null };
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const z of elevations) {
    if (typeof z !== "number" || !Number.isFinite(z)) continue;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    return { z_min_m: null, z_max_m: null };
  }
  return { z_min_m: zMin, z_max_m: zMax };
}

function pickIndices(n: number, maxPts: number): number[] {
  if (n <= 0) return [];
  if (n <= maxPts) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / maxPts);
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

function takeAt<T>(arr: T[] | undefined, indices: number[]): T[] | undefined {
  if (!arr?.length) return arr;
  return indices.map((i) => arr[Math.min(i, arr.length - 1)]);
}

function nearestS(S: number[], s: number): number {
  if (!S.length) return s;
  if (s <= S[0]) return S[0];
  if (s >= S[S.length - 1]) return S[S.length - 1];
  let lo = 0;
  let hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  return Math.abs(S[hi] - s) < Math.abs(S[lo] - s) ? S[hi] : S[lo];
}

/**
 * Downsample corridor series for localStorage (keeps TLS positions remapped).
 */
export function slimCorridorForSave(
  corridor: SpatialCorridor | null | undefined,
  maxPts = 900
): SpatialCorridor | null {
  if (!corridor?.S?.length) return null;
  const n = corridor.S.length;
  const indices = pickIndices(n, maxPts);
  const S = takeAt(corridor.S, indices)!;
  const slim: SpatialCorridor = {
    S,
    V_limite: takeAt(corridor.V_limite, indices) ?? S.map(() => 0),
    alpha: takeAt(corridor.alpha, indices) ?? S.map(() => 0),
    S_feux: (corridor.S_feux ?? []).map((s) => nearestS(S, s)),
    events: corridor.events ?? [],
    geometry: downsampleGeometry(
      takeAt(corridor.geometry, indices) ?? corridor.geometry ?? [],
      Math.min(250, maxPts)
    ),
  };
  if (corridor.V_limite_legal?.length)
    slim.V_limite_legal = takeAt(corridor.V_limite_legal, indices);
  if (corridor.V_traffic?.length)
    slim.V_traffic = takeAt(corridor.V_traffic, indices);
  if (corridor.V_curve?.length)
    slim.V_curve = takeAt(corridor.V_curve, indices);
  if (corridor.V_envelope?.length)
    slim.V_envelope = takeAt(corridor.V_envelope, indices);
  if (corridor.elevations_m?.length)
    slim.elevations_m = takeAt(corridor.elevations_m, indices);
  if (corridor.slope_profile)
    slim.slope_profile = corridor.slope_profile;
  if (corridor.feux_meta?.length) {
    slim.feux_meta = corridor.feux_meta.map((m, i) => ({
      ...m,
      s_m: slim.S_feux[i] ?? nearestS(S, m.s_m),
    }));
  }
  if (corridor.scheduled_stops?.length)
    slim.scheduled_stops = corridor.scheduled_stops;
  if (corridor.traffic_source != null)
    slim.traffic_source = corridor.traffic_source;
  if (corridor.warnings?.length) slim.warnings = corridor.warnings;
  if (corridor.a_y_mps2 != null) slim.a_y_mps2 = corridor.a_y_mps2;
  return slim;
}

function normalizeCorridor(raw: unknown): SpatialCorridor | null {
  if (!isRecord(raw)) return null;
  const S = asNumArr(raw.S);
  const V_limite = asNumArr(raw.V_limite);
  const alpha = asNumArr(raw.alpha);
  if (S.length < 2 || V_limite.length !== S.length) return null;
  const geometry = Array.isArray(raw.geometry)
    ? (raw.geometry as LatLon[]).filter(
        (p) =>
          p &&
          typeof p.lat === "number" &&
          typeof p.lon === "number" &&
          Number.isFinite(p.lat) &&
          Number.isFinite(p.lon)
      )
    : [];
  const corridor: SpatialCorridor = {
    S,
    V_limite,
    alpha: alpha.length === S.length ? alpha : S.map(() => 0),
    S_feux: asNumArr(raw.S_feux),
    events: Array.isArray(raw.events) ? (raw.events as SpatialCorridor["events"]) : [],
    geometry,
  };
  if (Array.isArray(raw.V_limite_legal))
    corridor.V_limite_legal = asNumArr(raw.V_limite_legal);
  if (Array.isArray(raw.V_traffic)) corridor.V_traffic = asNumArr(raw.V_traffic);
  if (Array.isArray(raw.V_curve)) corridor.V_curve = asNumArr(raw.V_curve);
  if (Array.isArray(raw.V_envelope))
    corridor.V_envelope = asNumArr(raw.V_envelope);
  if (Array.isArray(raw.elevations_m))
    corridor.elevations_m = asNumArr(raw.elevations_m);
  if (raw.slope_profile && typeof raw.slope_profile === "object")
    corridor.slope_profile = raw.slope_profile as SpatialCorridor["slope_profile"];
  if (Array.isArray(raw.feux_meta))
    corridor.feux_meta = raw.feux_meta as SpatialCorridor["feux_meta"];
  if (Array.isArray(raw.scheduled_stops))
    corridor.scheduled_stops =
      raw.scheduled_stops as SpatialCorridor["scheduled_stops"];
  if (typeof raw.traffic_source === "string")
    corridor.traffic_source = raw.traffic_source;
  if (Array.isArray(raw.warnings))
    corridor.warnings = raw.warnings as SpatialCorridor["warnings"];
  if (typeof raw.a_y_mps2 === "number") corridor.a_y_mps2 = raw.a_y_mps2;
  return corridor;
}

export function normalizeSavedCycle(raw: unknown): SavedCycle | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  const time = asNumArr(raw.time);
  const velocity = asNumArr(raw.velocity);
  if (!id || !name || time.length < 2 || time.length !== velocity.length) {
    return null;
  }
  const n = time.length;
  const acceleration = asNumArr(raw.acceleration);
  const slope = asNumArr(raw.slope);
  const a_lat = asNumArr(raw.a_lat);
  const position = asNumArr(raw.position);
  const pad = (arr: number[]) =>
    arr.length === n ? arr : Array.from({ length: n }, (_, i) => arr[i] ?? 0);

  const accelP = pad(acceleration);
  const slopeP = pad(slope);
  const posP = pad(position);
  const aLatP = pad(a_lat);

  /** Older saves may only have duration / v_* — recompute if accel stats missing. */
  const statsComplete =
    isRecord(raw.stats) &&
    typeof raw.stats.duration_s === "number" &&
    typeof raw.stats.a_lon_min_mps2 === "number" &&
    typeof raw.stats.a_lon_max_mps2 === "number" &&
    typeof raw.stats.v_mean_kmh === "number" &&
    typeof raw.stats.distance_m === "number";

  const stats = statsComplete
    ? (raw.stats as unknown as CycleStats)
    : computeCycleStats({
        time,
        velocity,
        acceleration: accelP,
        slope: slopeP,
        position: posP,
        a_lat: aLatP,
      });

  let limits: CycleLimitOverlay | null = null;
  if (isRecord(raw.limits)) {
    const legal = asNumArr(raw.limits.legal_kmh);
    const traffic = asNumArr(raw.limits.traffic_kmh);
    const curve = asNumArr(raw.limits.curve_kmh);
    if (legal.length === n) {
      limits = {
        legal_kmh: legal,
        traffic_kmh: traffic.length === n ? traffic : legal,
        curve_kmh: curve.length === n ? curve : legal,
      };
    }
  }

  const corridor = normalizeCorridor(raw.corridor);
  const fromElev = elevationExtremesM(corridor?.elevations_m);
  const z_min_m =
    asOptNum(raw.z_min_m) !== undefined
      ? asOptNum(raw.z_min_m) ?? null
      : fromElev.z_min_m;
  const z_max_m =
    asOptNum(raw.z_max_m) !== undefined
      ? asOptNum(raw.z_max_m) ?? null
      : fromElev.z_max_m;

  const resultAvailable =
    typeof raw.resultAvailable === "boolean"
      ? raw.resultAvailable
      : time.length > 1;

  return {
    id,
    name,
    savedAt:
      typeof raw.savedAt === "string" ? raw.savedAt : new Date(0).toISOString(),
    source: typeof raw.source === "string" ? raw.source : "unknown",
    sourceUrl:
      typeof raw.sourceUrl === "string" && raw.sourceUrl.trim()
        ? raw.sourceUrl.trim()
        : isRecord(raw.meta) &&
            typeof raw.meta.sourceUrl === "string" &&
            raw.meta.sourceUrl.trim()
          ? raw.meta.sourceUrl.trim()
          : null,
    origin:
      raw.origin === "corpus" || raw.origin === "import" || raw.origin === "cyclegen"
        ? raw.origin
        : "cyclegen",
    corpusId: typeof raw.corpusId === "string" ? raw.corpusId : null,
    stats,
    time,
    velocity,
    acceleration: pad(acceleration),
    slope: pad(slope),
    a_lat: pad(a_lat),
    position: pad(position),
    geometry: Array.isArray(raw.geometry)
      ? (raw.geometry as LatLon[]).filter(
          (p) =>
            p &&
            typeof p.lat === "number" &&
            typeof p.lon === "number" &&
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lon)
        )
      : [],
    resultAvailable,
    z_min_m: z_min_m ?? null,
    z_max_m: z_max_m ?? null,
    corridor,
    limits,
    meta: isRecord(raw.meta)
      ? (raw.meta as SavedCycleStudioMeta)
      : undefined,
  };
}

function readAll(): SavedCycle[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .map((c) => normalizeSavedCycle(c))
      .filter((c): c is SavedCycle => c != null)
      .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  } catch {
    return [];
  }
}

function writeAll(cycles: SavedCycle[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cycles));
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    if (
      name === "QuotaExceededError" ||
      name === "NS_ERROR_DOM_QUOTA_REACHED"
    ) {
      throw new Error(
        "Quota localStorage dépassée — impossible d’enregistrer la bibliothèque."
      );
    }
    throw e;
  }
}

/** Notify UI (bannières / tables) after library mutation. */
export function notifyLibraryChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("cyclegen:library-changed"));
}

/** Ids proposés sur la démo Pages — 4 cycles HERE (GPS + corridor + profil). */
export const ALPINE_DEMO_CYCLE_IDS = [
  "rs_here_grossglockner_prudent",
  "rs_here_veleta_prudent",
  "rs_here_iseran_prudent",
  "rs_here_stelvio_prudent",
] as const;

/** True when a library entry can restore wizard steps 1–4 without re-sim. */
export function isCompleteStudioLibraryCycle(
  cycle: Pick<SavedCycle, "geometry" | "corridor" | "time" | "velocity" | "meta">
): boolean {
  if (cycle.meta?.studioComplete === true || cycle.meta?.librarySigle === true) {
    return (
      (cycle.geometry?.length ?? 0) >= 2 &&
      !!cycle.corridor &&
      (cycle.corridor.S?.length ?? 0) > 1 &&
      cycle.time.length > 1 &&
      cycle.velocity.length === cycle.time.length
    );
  }
  return (
    (cycle.geometry?.length ?? 0) >= 2 &&
    !!cycle.corridor &&
    (cycle.corridor.S?.length ?? 0) > 1 &&
    cycle.time.length > 1 &&
    cycle.velocity.length === cycle.time.length
  );
}

/** Synthetic route analyze payload so step Trajet shows A/B + polyline. */
export function routeResultFromSavedCycle(
  cycle: SavedCycle,
  geo: LatLon[],
  corridor: SpatialCorridor | null
): RouteAnalyzeResponse | null {
  if (geo.length < 2) return null;
  const nSeg = geo.length - 1;
  const S = corridor?.S;
  const segment_distances_m: number[] = [];
  if (S && S.length >= 2) {
    const step = Math.max(1, Math.floor((S.length - 1) / nSeg));
    for (let i = 0; i < nSeg; i++) {
      const i0 = Math.min(i * step, S.length - 2);
      const i1 = Math.min(i0 + step, S.length - 1);
      segment_distances_m.push(Math.max(0, S[i1] - S[i0]));
    }
  } else {
    for (let i = 0; i < nSeg; i++) segment_distances_m.push(0);
  }
  const dist =
    cycle.stats.distance_m ||
    (S && S.length ? S[S.length - 1] : segment_distances_m.reduce((a, b) => a + b, 0));
  const dur = cycle.stats.duration_s || 1;
  const vMean = dist / Math.max(dur, 1);
  const elev =
    corridor?.elevations_m && corridor.elevations_m.length === geo.length
      ? corridor.elevations_m
      : corridor?.elevations_m?.length
        ? corridor.elevations_m
        : [];
  const lats = geo.map((p) => p.lat);
  const lons = geo.map((p) => p.lon);
  const label = cycle.meta?.routeLabel || cycle.meta?.saveTitle || cycle.name;
  return {
    geometry: geo,
    distance_m: dist,
    duration_s: dur,
    segment_speeds_mps: segment_distances_m.map(() => vMean),
    segment_distances_m,
    elevations_m: elev,
    traffic_signals: [],
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    origin: geo[0],
    destination: geo[geo.length - 1],
    origin_label: label,
    destination_label: "Arrivée",
    traffic_source:
      cycle.meta?.trafficSource ?? corridor?.traffic_source ?? undefined,
    warnings: corridor?.warnings ?? [],
    a_y_mps2:
      typeof cycle.meta?.aY === "number"
        ? cycle.meta.aY
        : corridor?.a_y_mps2 ?? undefined,
  };
}

/** Downloadable backup of the full saved-cycle library. */
export function exportSavedCyclesJson(): string {
  return JSON.stringify(
    {
      v: 1,
      exportedAt: new Date().toISOString(),
      cycles: readAll(),
    },
    null,
    2
  );
}

/**
 * Merge cycles from a backup JSON (does not wipe existing).
 * Returns number of cycles added or updated.
 */
export function importSavedCyclesJson(raw: string): {
  imported: number;
  total: number;
} {
  const data = JSON.parse(raw) as unknown;
  let list: unknown[] = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { cycles?: unknown }).cycles)
  ) {
    list = (data as { cycles: unknown[] }).cycles;
  } else {
    throw new Error("JSON invalide — attendu un tableau ou { cycles: [...] }");
  }
  const incoming = list
    .map((c) => normalizeSavedCycle(c))
    .filter((c): c is SavedCycle => c != null)
    .filter(
      (c) =>
        !isXspaceRoulageId(c.id) &&
        !isXspaceRoulageId(c.corpusId) &&
        !/xspace/i.test(c.name || "") &&
        !/xspace/i.test(c.source || "")
    );
  if (!incoming.length) {
    return { imported: 0, total: readAll().length };
  }
  const byId = new Map(readAll().map((c) => [c.id, c]));
  let imported = 0;
  for (const c of incoming) {
    byId.set(c.id, c);
    imported += 1;
  }
  const next = [...byId.values()]
    .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""))
    .slice(0, 30);
  writeAll(next);
  notifyLibraryChanged();
  return { imported, total: next.length };
}

const XSPACE_PURGE_FLAG = "cyclegen.purgeXspaceRoulages.v2";

/** Ids / corpus ids treated as XSPACE roulages (excluded from library UI). */
export function isXspaceRoulageId(id: string | null | undefined): boolean {
  if (!id) return false;
  const s = id.toLowerCase();
  return (
    s.startsWith("xspace_") ||
    s.includes("xspace_avl") ||
    s.includes("epsim_xspace") ||
    s === "xspace_prea_grossglockner_ref"
  );
}

/**
 * Drop XSPACE seed/corpus cycles from local saved library (no re-seed).
 * Idempotent via flag after a successful pass.
 */
export function purgeXspaceRoulagesFromLibrary(): {
  removed: number;
  total: number;
} {
  if (typeof window === "undefined") {
    return { removed: 0, total: 0 };
  }
  const all = readAll();
  const next = all.filter(
    (c) =>
      !isXspaceRoulageId(c.id) &&
      !isXspaceRoulageId(c.corpusId) &&
      !/xspace/i.test(c.name || "") &&
      !/xspace/i.test(c.source || "")
  );
  const removed = all.length - next.length;
  if (removed > 0) {
    writeAll(next);
    notifyLibraryChanged();
  }
  localStorage.setItem(XSPACE_PURGE_FLAG, "1");
  localStorage.removeItem("cyclegen.xspaceAvlSeed.v1");
  return { removed, total: next.length };
}

/** @deprecated Prefer purgeXspaceRoulagesFromLibrary — no longer imports XSPACE seeds. */
export async function ensureXspaceAvlSeedCycles(): Promise<{
  imported: number;
  total: number;
  skipped: boolean;
}> {
  const { removed, total } = purgeXspaceRoulagesFromLibrary();
  return { imported: -removed, total, skipped: removed === 0 };
}

const RS_FIT_PACK_FLAG = "cyclegen.routeStudioFitPack.v1";
const RS_ALPINE_DEMO_FLAG = "cyclegen.alpineDemoPack.v1";

type FitPackJson = {
  cycles?: unknown[];
  drivers?: unknown;
};

async function fetchRouteStudioFitPack(): Promise<FitPackJson | null> {
  const { withBase } = await import("@/lib/basePath");
  const res = await fetch(withBase("/data/route_studio_fit_pack.json"), {
    cache: "no-cache",
  });
  if (!res.ok) return null;
  return (await res.json()) as FitPackJson;
}

function importCyclesSubset(
  pack: FitPackJson,
  ids: readonly string[]
): { imported: number; total: number } {
  const want = new Set(ids);
  const cycles = (pack.cycles ?? []).filter(
    (c) =>
      c &&
      typeof c === "object" &&
      want.has(String((c as { id?: unknown }).id ?? ""))
  );
  return importSavedCyclesJson(JSON.stringify({ cycles }));
}

/**
 * Démo Pages : 4 cols alpins (~0,5 Mo) — prioritaire si le pack complet
 * dépasse le quota localStorage.
 */
export async function ensureAlpineDemoPack(): Promise<{
  imported: number;
  total: number;
  skipped: boolean;
  error?: string;
}> {
  if (typeof window === "undefined") {
    return { imported: 0, total: 0, skipped: true };
  }
  const existing = new Set(readAll().map((c) => c.id));
  const missing = ALPINE_DEMO_CYCLE_IDS.filter((id) => !existing.has(id));
  if (!missing.length && localStorage.getItem(RS_ALPINE_DEMO_FLAG) === "1") {
    return { imported: 0, total: readAll().length, skipped: true };
  }
  try {
    const pack = await fetchRouteStudioFitPack();
    if (!pack) {
      return {
        imported: 0,
        total: readAll().length,
        skipped: true,
        error: "Pack alpine introuvable (fichier /data).",
      };
    }
    const { imported, total } = importCyclesSubset(pack, ALPINE_DEMO_CYCLE_IDS);
    if (imported > 0) {
      localStorage.setItem(RS_ALPINE_DEMO_FLAG, "1");
      notifyLibraryChanged();
    }
    return { imported, total, skipped: false };
  } catch (e) {
    return {
      imported: 0,
      total: readAll().length,
      skipped: true,
      error: e instanceof Error ? e.message : "Échec seed alpine",
    };
  }
}

/**
 * Fetch /data/route_studio_fit_pack.json and merge cycles + drivers.
 * Idempotent via flag when all expected fit cycle ids are present.
 * Falls back to alpine demo subset on quota errors.
 */
export async function ensureRouteStudioFitPack(): Promise<{
  imported: number;
  drivers: number;
  total: number;
  skipped: boolean;
  error?: string;
}> {
  if (typeof window === "undefined") {
    return { imported: 0, drivers: 0, total: 0, skipped: true };
  }
  const expected = [
    "rs_fit_iseran_prudent",
    "rs_fit_iseran_dynamique",
    "rs_fit_veleta_prudent",
    "rs_fit_veleta_dynamique",
    "rs_fit_stelvio_prudent",
    "rs_fit_stelvio_dynamique",
    "rs_fit_grossglockner_prudent",
    "rs_fit_grossglockner_dynamique",
    "rs_fit_grossglockner_prea",
    "rs_avl_grossglockner_prudent",
    "rs_avl_grossglockner_dynamique",
    "rs_here_grossglockner_prudent",
    "rs_here_grossglockner_dynamique",
    "rs_here_grossglockner_prea",
    "rs_here_veleta_prudent",
    "rs_here_iseran_prudent",
    "rs_here_stelvio_prudent",
  ];
  const existing = new Set(readAll().map((c) => c.id));
  const missing = expected.filter((id) => !existing.has(id));
  if (!missing.length && localStorage.getItem(RS_FIT_PACK_FLAG) === "1") {
    return {
      imported: 0,
      drivers: 0,
      total: readAll().length,
      skipped: true,
    };
  }
  try {
    const pack = await fetchRouteStudioFitPack();
    if (!pack) {
      const alpine = await ensureAlpineDemoPack();
      return {
        imported: alpine.imported,
        drivers: 0,
        total: alpine.total,
        skipped: alpine.skipped,
        error: alpine.error,
      };
    }
    try {
      const { imported, total } = importSavedCyclesJson(
        JSON.stringify({ cycles: pack.cycles ?? [] })
      );
      let drivers = 0;
      try {
        const { upsertDriversFromPack } = await import("@/lib/driverLibrary");
        drivers = upsertDriversFromPack(pack);
      } catch {
        /* optional */
      }
      if (imported > 0 || drivers > 0) {
        localStorage.setItem(RS_FIT_PACK_FLAG, "1");
        localStorage.setItem(RS_ALPINE_DEMO_FLAG, "1");
        notifyLibraryChanged();
      }
      return { imported, drivers, total, skipped: false };
    } catch (e) {
      // Quota or parse — try slim alpine set
      const alpine = await ensureAlpineDemoPack();
      return {
        imported: alpine.imported,
        drivers: 0,
        total: alpine.total,
        skipped: alpine.skipped,
        error:
          alpine.error ||
          (e instanceof Error ? e.message : "Import pack incomplet"),
      };
    }
  } catch (e) {
    const alpine = await ensureAlpineDemoPack();
    return {
      imported: alpine.imported,
      drivers: 0,
      total: alpine.total,
      skipped: alpine.skipped,
      error:
        alpine.error ||
        (e instanceof Error ? e.message : "Échec seed bibliothèque"),
    };
  }
}

export function listSavedCycles(): SavedCycle[] {
  return readAll();
}

export function getSavedCycle(id: string): SavedCycle | null {
  return readAll().find((c) => c.id === id) ?? null;
}

export function deleteSavedCycle(id: string): void {
  writeAll(readAll().filter((c) => c.id !== id));
}

export function renameSavedCycle(id: string, name: string): SavedCycle | null {
  const title = name.trim();
  if (!title) return null;
  const all = readAll();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const next = [...all];
  next[idx] = {
    ...next[idx],
    name: title,
    meta: { ...next[idx].meta, saveTitle: title },
  };
  writeAll(next);
  return next[idx];
}

/** GPS trajet vs profil énergie (sans lat/lon). */
export type CycleGeoKind = "gps" | "energy";

export function cycleGeoKind(cycle: Pick<SavedCycle, "geometry">): CycleGeoKind {
  return (cycle.geometry?.length ?? 0) >= 2 ? "gps" : "energy";
}

export type SaveCycleInput = Omit<
  SavedCycle,
  "id" | "savedAt" | "stats" | "resultAvailable"
> & {
  id?: string;
  savedAt?: string;
  stats?: CycleStats;
  resultAvailable?: boolean;
};

export function newCycleInstanceId(prefix = "vs"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${rand}`;
}

/** Build a SavedCycle in memory (no localStorage). */
export function packCycle(
  input: SaveCycleInput,
  opts?: { maxPoints?: number; slimCorridor?: boolean }
): SavedCycle {
  const id = input.id ?? newCycleInstanceId("cycle");
  const maxPoints = opts?.maxPoints ?? 2500;

  const packed = downsampleSeries(
    {
      time: input.time,
      velocity: input.velocity,
      acceleration: input.acceleration,
      slope: input.slope,
      a_lat: input.a_lat,
      position: input.position,
      ...(input.limits
        ? {
            legal_kmh: input.limits.legal_kmh,
            traffic_kmh: input.limits.traffic_kmh,
            curve_kmh: input.limits.curve_kmh,
          }
        : {}),
    },
    maxPoints
  );

  const n = packed.time.length;
  const stats =
    input.stats ??
    computeCycleStats({
      time: packed.time,
      velocity: packed.velocity,
      acceleration: packed.acceleration,
      slope: packed.slope,
      position: packed.position,
      a_lat: packed.a_lat,
    });

  const corridor =
    opts?.slimCorridor === false
      ? input.corridor ?? null
      : slimCorridorForSave(input.corridor ?? null);

  const elevZ = elevationExtremesM(corridor?.elevations_m);
  const z_min_m =
    input.z_min_m !== undefined ? input.z_min_m : elevZ.z_min_m;
  const z_max_m =
    input.z_max_m !== undefined ? input.z_max_m : elevZ.z_max_m;

  const resultAvailable =
    input.resultAvailable ?? packed.time.length > 1;

  const saved: SavedCycle = {
    id,
    name: input.name.trim() || "Cycle sans nom",
    savedAt: input.savedAt ?? new Date().toISOString(),
    source: input.source,
    sourceUrl:
      (typeof input.sourceUrl === "string" && input.sourceUrl.trim()) ||
      input.meta?.sourceUrl ||
      null,
    origin: input.origin,
    corpusId: input.corpusId ?? null,
    stats,
    time: packed.time,
    velocity: packed.velocity,
    acceleration: packed.acceleration,
    slope: packed.slope,
    a_lat: packed.a_lat,
    position: packed.position,
    geometry: downsampleGeometry(input.geometry ?? [], 250),
    resultAvailable,
    z_min_m: z_min_m ?? null,
    z_max_m: z_max_m ?? null,
    corridor,
    limits:
      input.limits && packed.legal_kmh?.length === n
        ? {
            legal_kmh: packed.legal_kmh,
            traffic_kmh: packed.traffic_kmh ?? packed.legal_kmh,
            curve_kmh: packed.curve_kmh ?? packed.legal_kmh,
          }
        : null,
    meta: input.meta,
  };

  return saved;
}

export function saveCycle(input: SaveCycleInput): SavedCycle {
  const saved = packCycle(input, { maxPoints: 1200 });
  const next = [saved, ...readAll().filter((c) => c.id !== saved.id)].slice(
    0,
    MAX_CYCLES
  );
  try {
    writeAll(next);
  } catch {
    const slim: SavedCycle = {
      ...saved,
      geometry: [],
      limits: null,
      corridor: null,
    };
    writeAll(
      [slim, ...readAll().filter((c) => c.id !== saved.id)].slice(0, MAX_CYCLES)
    );
    return slim;
  }
  return saved;
}

const COMPARE_STASH_KEY = "cyclegen.compare.stash";

/** Pass cycles from the studio to /compare (sessionStorage, one-shot). */
export function stashCyclesForCompare(cycles: SavedCycle[]): void {
  if (typeof window === "undefined" || cycles.length === 0) return;
  try {
    sessionStorage.setItem(COMPARE_STASH_KEY, JSON.stringify(cycles));
  } catch {
    try {
      const slim = cycles.map((c) => ({
        ...c,
        geometry: [],
        limits: null,
        corridor: null,
      }));
      sessionStorage.setItem(COMPARE_STASH_KEY, JSON.stringify(slim));
    } catch {
      /* quota */
    }
  }
}

export function peekStashedCompareCycles(): SavedCycle[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(COMPARE_STASH_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .map((c) => {
        try {
          return normalizeSavedCycle(c);
        } catch {
          return null;
        }
      })
      .filter((c): c is SavedCycle => c != null);
  } catch {
    return [];
  }
}

export function takeStashedCompareCycles(): SavedCycle[] {
  const cycles = peekStashedCompareCycles();
  if (typeof window !== "undefined") {
    try {
      sessionStorage.removeItem(COMPARE_STASH_KEY);
    } catch {
      /* ignore */
    }
  }
  return cycles;
}

export function formatGpsCoord(
  lat: number | null | undefined,
  lon: number | null | undefined,
  digits = 5
): string | null {
  if (
    lat == null ||
    lon == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null;
  }
  return `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`;
}

/** True if label looks like « lat, lon » (possibly a A→B GPS pair). */
export function looksLikeGpsLabel(label: string | null | undefined): boolean {
  if (!label?.trim()) return false;
  const parts = label.split(/\s*→\s*/);
  const re = /^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$/;
  return parts.every((p) => re.test(p.trim()));
}

/**
 * Default name: titre libre persisté, sinon libellé trajet (lieux),
 * sinon GPS A→B, sinon horodatage.
 * Ne remplace jamais un titre non vide par des GPS.
 */
export function resolveCycleSaveName(args: {
  title?: string | null;
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  routeLabel?: string | null;
}): string {
  const title = args.title?.trim();
  if (title) return title;

  const route = args.routeLabel?.trim() || "";
  if (route && !looksLikeGpsLabel(route)) return route;

  const a = formatGpsCoord(args.originLat, args.originLon);
  const b = formatGpsCoord(args.destLat, args.destLon);
  if (a && b) return `${a} → ${b}`;

  if (route) return route;
  return defaultCycleName();
}

export function defaultCycleName(routeLabel?: string): string {
  const stamp = new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return routeLabel?.trim()
    ? `${routeLabel.trim()} · ${stamp}`
    : `Cycle · ${stamp}`;
}

const STUDIO_BASE_STASH_KEY = "cyclegen.studio.base";
const STUDIO_BASE_INTENT_KEY = "cyclegen.studio.base.intent";
const STUDIO_PENDING_CORPUS_KEY = "cyclegen.studio.pendingCorpus";

/** Cap series size so sessionStorage / stash fit (~5 MB quota). */
export const STUDIO_TRANSFER_MAX_POINTS = 1800;

/** How the stashed library cycle should open in Studio. */
export type StudioOpenIntent = "study" | "base";

export type PendingCorpusOpen = {
  corpusId: string;
  name: string;
  intent: StudioOpenIntent;
  vehicleId?: string | null;
};

export function stashPendingCorpusOpen(pending: PendingCorpusOpen): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STUDIO_PENDING_CORPUS_KEY, JSON.stringify(pending));
  } catch {
    /* ignore */
  }
}

export function takePendingCorpusOpen(): PendingCorpusOpen | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STUDIO_PENDING_CORPUS_KEY);
    sessionStorage.removeItem(STUDIO_PENDING_CORPUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCorpusOpen;
    if (!parsed?.corpusId || typeof parsed.corpusId !== "string") return null;
    return {
      corpusId: parsed.corpusId,
      name: typeof parsed.name === "string" ? parsed.name : parsed.corpusId,
      intent: parsed.intent === "study" ? "study" : "base",
      vehicleId:
        typeof parsed.vehicleId === "string" ? parsed.vehicleId : null,
    };
  } catch {
    try {
      sessionStorage.removeItem(STUDIO_PENDING_CORPUS_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function peekPendingCorpusOpen(): PendingCorpusOpen | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STUDIO_PENDING_CORPUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCorpusOpen;
    if (!parsed?.corpusId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Lightweight pointer for Flux 2 (energy study) — no full series in session. */
const ENERGY_OPEN_KEY = "cyclegen.energy.open";

export type EnergyOpenRef =
  | {
      kind: "corpus";
      corpusId: string;
      name?: string;
      vehicleId?: string | null;
    }
  | { kind: "saved"; cycleId: string; vehicleId?: string | null };

export function stashEnergyOpen(ref: EnergyOpenRef): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(ENERGY_OPEN_KEY, JSON.stringify(ref));
  } catch {
    /* ignore */
  }
}

export function takeEnergyOpen(): EnergyOpenRef | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ENERGY_OPEN_KEY);
    sessionStorage.removeItem(ENERGY_OPEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EnergyOpenRef;
    if (parsed?.kind === "corpus" && typeof parsed.corpusId === "string") {
      return {
        kind: "corpus",
        corpusId: parsed.corpusId,
        name: parsed.name,
        vehicleId: parsed.vehicleId ?? null,
      };
    }
    if (parsed?.kind === "saved" && typeof parsed.cycleId === "string") {
      return {
        kind: "saved",
        cycleId: parsed.cycleId,
        vehicleId: parsed.vehicleId ?? null,
      };
    }
    return null;
  } catch {
    try {
      sessionStorage.removeItem(ENERGY_OPEN_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function peekEnergyOpen(): EnergyOpenRef | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ENERGY_OPEN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as EnergyOpenRef;
  } catch {
    return null;
  }
}

/** Build ConsolidatedProfile-like series from a SavedCycle (no GPS required). */
export function profileFromEnergyCycle(cycle: SavedCycle): {
  time: number[];
  velocity: number[];
  position: number[];
  acceleration: number[];
  slope: number[];
  total_duration_s: number;
  average_speed_kmh: number;
  status: "completed";
  traffic_source: string | null;
  warnings: {
    code: string;
    message: string;
    s0: number;
    s1: number;
    source: string;
  }[];
} | null {
  if (cycle.time.length < 2 || cycle.velocity.length !== cycle.time.length) {
    return null;
  }
  const n = cycle.time.length;
  const zeros = () => Array.from({ length: n }, () => 0);
  const position =
    cycle.position?.length === n
      ? cycle.position
      : (() => {
          const s = [0];
          for (let i = 1; i < n; i++) {
            const dt = Math.max(cycle.time[i] - cycle.time[i - 1], 1e-6);
            s.push(
              s[i - 1] +
                0.5 * (cycle.velocity[i] + cycle.velocity[i - 1]) * dt
            );
          }
          return s;
        })();
  return {
    time: cycle.time,
    velocity: cycle.velocity,
    position,
    acceleration:
      cycle.acceleration?.length === n ? cycle.acceleration : zeros(),
    slope: cycle.slope?.length === n ? cycle.slope : zeros(),
    total_duration_s: cycle.stats.duration_s,
    average_speed_kmh: cycle.stats.v_mean_kmh,
    status: "completed",
    traffic_source: cycle.meta?.trafficSource ?? "profil_import",
    warnings: [
      {
        code: "no_gps",
        message:
          "Profil sans GPS — analyses v / pente / couple véhicule (masse, F0/F1/F2, r_dyn).",
        s0: 0,
        s1: cycle.stats.distance_m || 0,
        source: "studio",
      },
    ],
  };
}

/** Downsample a library cycle for Studio transfer (stash / session). */
export function slimCycleForStudioTransfer(
  cycle: SavedCycle,
  maxPoints = STUDIO_TRANSFER_MAX_POINTS
): SavedCycle {
  if (cycle.time.length <= maxPoints) {
    return {
      ...cycle,
      geometry: (cycle.geometry?.length ?? 0) >= 2 ? cycle.geometry : [],
      corridor:
        (cycle.geometry?.length ?? 0) >= 2 ? cycle.corridor : null,
      limits: (cycle.geometry?.length ?? 0) >= 2 ? cycle.limits : null,
    };
  }
  return packCycle(
    {
      id: cycle.id,
      savedAt: cycle.savedAt,
      name: cycle.name,
      source: cycle.source,
      sourceUrl: cycle.sourceUrl,
      origin: cycle.origin,
      corpusId: cycle.corpusId,
      time: cycle.time,
      velocity: cycle.velocity,
      acceleration: cycle.acceleration,
      slope: cycle.slope,
      a_lat: cycle.a_lat,
      position: cycle.position,
      geometry: (cycle.geometry?.length ?? 0) >= 2 ? cycle.geometry : [],
      corridor: (cycle.geometry?.length ?? 0) >= 2 ? cycle.corridor : null,
      limits: (cycle.geometry?.length ?? 0) >= 2 ? cycle.limits : null,
      meta: cycle.meta,
      z_min_m: cycle.z_min_m,
      z_max_m: cycle.z_max_m,
      resultAvailable: cycle.resultAvailable,
      stats: cycle.stats,
    },
    { maxPoints, slimCorridor: true }
  );
}

function downsampleProfile(
  profile: ConsolidatedProfile,
  maxPoints: number
): ConsolidatedProfile {
  if (profile.time.length <= maxPoints) return profile;
  const packed = downsampleSeries(
    {
      time: profile.time,
      velocity: profile.velocity,
      acceleration: profile.acceleration,
      slope: profile.slope,
      position: profile.position,
    },
    maxPoints
  );
  const n = packed.time.length;
  return {
    ...profile,
    time: packed.time,
    velocity: packed.velocity,
    acceleration:
      packed.acceleration?.length === n
        ? packed.acceleration
        : Array.from({ length: n }, () => 0),
    slope:
      packed.slope?.length === n
        ? packed.slope
        : Array.from({ length: n }, () => 0),
    position:
      packed.position?.length === n
        ? packed.position
        : Array.from({ length: n }, (_, i) => i),
  };
}

/**
 * Pass a library cycle into create-mode (sessionStorage, one-shot).
 * - `study`: restore full analysis at step 4 (saved CycleGen run).
 * - `base`: use as route/reference for a new study.
 */
export function stashBaseCycleForStudio(
  cycle: SavedCycle,
  intent: StudioOpenIntent = "base"
): void {
  if (typeof window === "undefined") return;
  const attempts = [STUDIO_TRANSFER_MAX_POINTS, 900, 450, 220];
  for (const maxPts of attempts) {
    try {
      const slim = slimCycleForStudioTransfer(cycle, maxPts);
      sessionStorage.setItem(STUDIO_BASE_INTENT_KEY, intent);
      sessionStorage.setItem(STUDIO_BASE_STASH_KEY, JSON.stringify(slim));
      return;
    } catch {
      /* try smaller */
    }
  }
}

function readStashedBaseRaw(): {
  cycle: SavedCycle;
  intent: StudioOpenIntent;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STUDIO_BASE_STASH_KEY);
    const intentRaw = sessionStorage.getItem(STUDIO_BASE_INTENT_KEY);
    if (!raw) return null;
    const cycle = normalizeSavedCycle(JSON.parse(raw));
    if (!cycle) return null;
    const intent: StudioOpenIntent =
      intentRaw === "study" ? "study" : "base";
    return { cycle, intent };
  } catch {
    return null;
  }
}

/** Peek without consuming — safe under React Strict Mode remount. */
export function peekStashedBaseCycle(): {
  cycle: SavedCycle;
  intent: StudioOpenIntent;
} | null {
  return readStashedBaseRaw();
}

export function clearStashedBaseCycle(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STUDIO_BASE_STASH_KEY);
    sessionStorage.removeItem(STUDIO_BASE_INTENT_KEY);
  } catch {
    /* ignore */
  }
}

/** Consume stash (legacy). Prefer peek + clear after session seed. */
export function takeStashedBaseCycle(): {
  cycle: SavedCycle;
  intent: StudioOpenIntent;
} | null {
  const stashed = readStashedBaseRaw();
  clearStashedBaseCycle();
  return stashed;
}

function profileFromSavedCycle(base: SavedCycle, hasGeo: boolean): ConsolidatedProfile | null {
  if (base.time.length < 2 || base.velocity.length !== base.time.length) {
    return null;
  }
  const n = base.time.length;
  const zeros = () => Array.from({ length: n }, () => 0);
  const position =
    base.position?.length === n
      ? base.position
      : (() => {
          const s = [0];
          for (let i = 1; i < n; i++) {
            const dt = Math.max(base.time[i] - base.time[i - 1], 1e-6);
            s.push(
              s[i - 1] + 0.5 * (base.velocity[i] + base.velocity[i - 1]) * dt
            );
          }
          return s;
        })();
  const meta = base.meta;
  return {
    time: base.time,
    velocity: base.velocity,
    position,
    acceleration:
      base.acceleration?.length === n ? base.acceleration : zeros(),
    slope: base.slope?.length === n ? base.slope : zeros(),
    total_duration_s: base.stats.duration_s,
    average_speed_kmh: base.stats.v_mean_kmh,
    status: "completed",
    traffic_source: meta?.trafficSource ?? (hasGeo ? null : "profil_import"),
    warnings: hasGeo
      ? undefined
      : [
          {
            code: "no_gps",
            message:
              "Profil sans coordonnées GPS — carte inactive ; analyses v / pente / couple véhicule disponibles.",
            s0: 0,
            s1: base.stats.distance_m || 0,
            source: "studio",
          },
        ],
  };
}

/**
 * Write a full Studio session *before* navigating to `/?mode=create`.
 * Ensures the first paint (and Strict Mode remount) boots on the right step
 * instead of Trajet after a one-shot stash was already consumed.
 */
export function seedStudioSessionFromCycle(
  baseIn: SavedCycle,
  intent: StudioOpenIntent = "base"
): boolean {
  if (typeof window === "undefined") return false;

  const base = slimCycleForStudioTransfer(baseIn, STUDIO_TRANSFER_MAX_POINTS);

  const geo =
    (base.geometry?.length ?? 0) >= 2
      ? base.geometry
      : base.corridor?.geometry?.length && base.corridor.geometry.length >= 2
        ? base.corridor.geometry
        : [];
  const hasGeo = geo.length >= 2;
  const hasProfile =
    base.time.length > 1 && base.velocity.length === base.time.length;
  const savedCorridor =
    hasGeo && base.corridor && base.corridor.S.length > 1
      ? base.corridor
      : null;
  const origin = hasGeo ? geo[0] : null;
  const destination = hasGeo ? geo[geo.length - 1] : null;
  const routeParts = (base.meta?.routeLabel || "")
    .split("→")
    .map((s) => s.trim())
    .filter(Boolean);
  const meta = base.meta;
  const completePack = isCompleteStudioLibraryCycle(base);
  const openAsStudy = (intent === "study" || completePack) && hasProfile;
  const noGpsBase = !hasGeo && hasProfile;
  const fullProfile = hasProfile ? profileFromSavedCycle(base, hasGeo) : null;
  const routeResult =
    hasGeo ? routeResultFromSavedCycle(base, geo, savedCorridor) : null;

  let activeStep: 1 | 2 | 3 | 4 = 1;
  let maxUnlocked: 1 | 2 | 3 | 4 = 1;
  let stage: StudioSessionSnapshot["stage"] = "route";
  let referenceCycle: StudioSessionSnapshot["referenceCycle"] = null;
  let showBaseOverlay = false;

  if (openAsStudy && fullProfile) {
    // Library sigle / étude : étape Cycle visible, mais 1–3 déverrouillées
    // et déjà peuplées (trajet, contraintes, conducteur).
    activeStep = 4;
    maxUnlocked = 4;
    stage = "completed";
  } else if (hasProfile && fullProfile) {
    referenceCycle = {
      name: base.name,
      time: base.time.slice(),
      velocity: base.velocity.slice(),
    };
    if (savedCorridor && savedCorridor.S.length > 1) {
      activeStep = 2;
      maxUnlocked = 3;
      stage = "corridor";
    } else if (hasGeo) {
      activeStep = 1;
      maxUnlocked = 1;
      stage = "route";
    } else {
      activeStep = 4;
      maxUnlocked = 4;
      stage = "completed";
    }
  } else if (hasGeo) {
    activeStep = savedCorridor ? 2 : 1;
    maxUnlocked = savedCorridor ? 2 : 1;
    stage = savedCorridor ? "corridor" : "route";
  }

  // Complet GPS + corridor + profil → toujours navigable sur les 4 écrans.
  if (completePack && fullProfile) {
    activeStep = 4;
    maxUnlocked = 4;
    stage = "completed";
  }

  const studyTitle =
    (typeof meta?.saveTitle === "string" && meta.saveTitle.trim()) ||
    (base.name?.trim() && !looksLikeGpsLabel(base.name)
      ? base.name.trim()
      : null) ||
    null;

  let driverProfile: DriverProfile = "Normal";
  if (
    meta?.driverProfile === "Eco" ||
    meta?.driverProfile === "Normal" ||
    meta?.driverProfile === "Agressif" ||
    meta?.driverProfile === "Sportif" ||
    meta?.driverProfile === "Prudent" ||
    meta?.driverProfile === "Dynamique"
  ) {
    driverProfile = meta.driverProfile;
  }
  const physics = meta?.physics ?? presetFor(driverProfile).physics;
  const preferredEngine: SimEngine =
    meta?.preferredEngine === "sumo" ? "sumo" : "idm";
  const routingProfile =
    (meta?.routingProfile as RoutingProfile) || "Mapbox/Traffic";
  const envelopeMask: EnvelopeMask = meta?.envelopeMask
    ? {
        legal: !!meta.envelopeMask.legal,
        traffic: !!meta.envelopeMask.traffic,
        curve: !!meta.envelopeMask.curve,
      }
    : DEFAULT_ENVELOPE_MASK;

  const warnings =
    openAsStudy || noGpsBase
      ? hasGeo
        ? savedCorridor?.warnings ?? []
        : [
            {
              code: "no_gps",
              message:
                "Pas de géométrie GPS : la carte est désactivée. Les courbes et le couple à la roue utilisent vitesse, pente et véhicule.",
              s0: 0,
              s1: base.stats.distance_m || 0,
              source: "studio",
            },
          ]
      : savedCorridor?.warnings ?? [];

  const defaultVehicle = DEFAULT_VEHICLE_ID;

  const buildSnap = (profile: ConsolidatedProfile | null): StudioSessionSnapshot => ({
    v: 1,
    savedAt: new Date().toISOString(),
    activeStep,
    maxUnlocked,
    preferredEngine,
    stage,
    departureLabel:
      routeParts[0] ||
      (origin
        ? `${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}`
        : base.name || "Départ"),
    destinationLabel:
      routeParts[1] ||
      (destination
        ? `${destination.lat.toFixed(5)}, ${destination.lon.toFixed(5)}`
        : hasGeo
          ? "Arrivée"
          : "Profil sans GPS"),
    pointA: origin,
    pointB: destination,
    geometry: hasGeo ? geo : [],
    distanceM: base.stats.distance_m,
    durationS: base.stats.duration_s,
    routeResult,
    corridor: savedCorridor,
    routingProfile,
    departAt:
      typeof meta?.departAt === "string" && meta.departAt.trim()
        ? meta.departAt
        : new Date().toISOString().slice(0, 16),
    aY:
      typeof meta?.aY === "number" && Number.isFinite(meta.aY)
        ? meta.aY
        : DEFAULT_A_Y,
    trafficSource: meta?.trafficSource ?? (hasGeo ? null : "profil_import"),
    warnings,
    driverProfile,
    physics,
    driverZonesEnabled: false,
    driverZones: [...RENAULT_GROSSGLOCKNER_ZONES],
    maxSpeedKmh: meta?.maxSpeedKmh !== undefined ? meta.maxSpeedKmh : null,
    vehicleId:
      typeof meta?.vehicleId === "string" && meta.vehicleId
        ? meta.vehicleId
        : defaultVehicle,
    slopeUnit: "percent",
    waypoints: [],
    profile,
    appliedParamsKey: null,
    envelopeMask,
    includeTrafficLights:
      typeof meta?.includeTrafficLights === "boolean"
        ? meta.includeTrafficLights
        : true,
    slopeAlgo: meta?.slopeAlgo
      ? normalizeSlopeAlgo(meta.slopeAlgo)
      : DEFAULT_SLOPE_ALGO,
    legalFilter: meta?.legalFilter
      ? normalizeLegalFilter(meta.legalFilter)
      : undefined,
    showRouteArrows: true,
    mapSpeedLayers: {
      envelope: false,
      legal: false,
      traffic: false,
      curve: false,
    },
    referenceGeometry: hasGeo ? geo : [],
    syncChartMap: true,
    elevationA_m:
      typeof meta?.elevationA_m === "number" ? meta.elevationA_m : null,
    elevationB_m:
      typeof meta?.elevationB_m === "number" ? meta.elevationB_m : null,
    referenceCycle,
    showBaseOverlay,
    noGpsBase,
    savedCycleTitle: studyTitle,
  });

  const budgets = [STUDIO_TRANSFER_MAX_POINTS, 900, 450, 220];
  for (const maxPts of budgets) {
    const profile = fullProfile
      ? downsampleProfile(fullProfile, maxPts)
      : null;
    const snap = buildSnap(profile);
    if (referenceCycle) {
      if (referenceCycle.time.length > maxPts) {
        const d = downsampleSeries(
          { time: referenceCycle.time, velocity: referenceCycle.velocity },
          maxPts
        );
        snap.referenceCycle = {
          name: referenceCycle.name,
          time: d.time,
          velocity: d.velocity,
        };
      } else {
        snap.referenceCycle = referenceCycle;
      }
    }
    if (saveStudioSession(snap)) return true;
  }

  // Last resort: step lock without heavy series (API re-fetch via pending corpus).
  const bare = buildSnap(null);
  bare.referenceCycle = null;
  return saveStudioSession(bare);
}
