/**
 * Local-first corridor profile store (IndexedDB).
 * Full route + corridor JSON is too large for localStorage — IDB holds it.
 */

import type {
  LatLon,
  RouteAnalyzeResponse,
  RoutingProfile,
  SpatialCorridor,
  WaypointDraft,
} from "@/lib/types";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import type { SlopeAlgoOptions } from "@/lib/slopeAlgo";
import type { LegalFilterOptions } from "@/lib/legalFilter";

const DB_NAME = "cyclegen.corridor_profiles.v1";
const DB_VERSION = 1;
const STORE = "profiles";
const MAX_ENTRIES = 24;

export const CORRIDOR_PROFILE_KIND = "cyclegen.corridor_profile" as const;

export type CorridorProfileBundle = {
  v: 1;
  kind: typeof CORRIDOR_PROFILE_KIND;
  savedAt: string;
  cacheKey: string;
  label?: string;
  meta: {
    routingProfile: RoutingProfile | string;
    departAt?: string;
    aY: number;
    maxSpeedKmh: number | null;
    envelopeMask: EnvelopeMask;
    slopeAlgo?: SlopeAlgoOptions;
    legalFilter?: LegalFilterOptions;
    includeTrafficLights?: boolean;
    origin?: LatLon | null;
    destination?: LatLon | null;
    originLabel?: string | null;
    destinationLabel?: string | null;
  };
  route: RouteAnalyzeResponse;
  corridor: SpatialCorridor;
};

export type CorridorCacheKeyInput = {
  routingProfile: string;
  latA: number;
  lonA: number;
  latB: number;
  lonB: number;
  vias?: Array<{ lat: number; lon: number }>;
  aY: number;
  maxSpeedKmh: number | null;
  envelopeMask: EnvelopeMask;
  slopeAlgoKey: string;
  legalFilterKey: string;
  includeTrafficLights: boolean;
};

function roundCoord(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/** Stable fingerprint for identical geometry + envelope options. */
export function makeCorridorCacheKey(input: CorridorCacheKeyInput): string {
  const vias = (input.vias ?? [])
    .map((p) => `${roundCoord(p.lat)},${roundCoord(p.lon)}`)
    .join(";");
  return [
    input.routingProfile,
    `${roundCoord(input.latA)},${roundCoord(input.lonA)}`,
    vias,
    `${roundCoord(input.latB)},${roundCoord(input.lonB)}`,
    `ay=${input.aY.toFixed(2)}`,
    `vmax=${input.maxSpeedKmh ?? "none"}`,
    `leg=${input.envelopeMask.legal ? 1 : 0}`,
    `trf=${input.envelopeMask.traffic ? 1 : 0}`,
    `crv=${input.envelopeMask.curve ? 1 : 0}`,
    `tls=${input.includeTrafficLights ? 1 : 0}`,
    `slope=${input.slopeAlgoKey}`,
    `legal=${input.legalFilterKey}`,
  ].join("|");
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "cacheKey" });
        os.createIndex("savedAt", "savedAt", { unique: false });
      }
    };
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB request failed"));
  });
}

export async function getCorridorProfile(
  cacheKey: string
): Promise<CorridorProfileBundle | null> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const row = await idbReq(
        tx.objectStore(STORE).get(cacheKey) as IDBRequest<CorridorProfileBundle>
      );
      return row?.kind === CORRIDOR_PROFILE_KIND ? row : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function putCorridorProfile(
  bundle: CorridorProfileBundle
): Promise<boolean> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      await idbReq(store.put(bundle));
      // Evict oldest if over capacity
      const all = await idbReq(
        store.getAll() as IDBRequest<CorridorProfileBundle[]>
      );
      if (all.length > MAX_ENTRIES) {
        const sorted = [...all].sort((a, b) =>
          (a.savedAt || "").localeCompare(b.savedAt || "")
        );
        const drop = sorted.slice(0, all.length - MAX_ENTRIES);
        for (const d of drop) {
          await idbReq(store.delete(d.cacheKey));
        }
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IDB tx failed"));
      });
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function isCorridorProfileBundle(
  raw: unknown
): raw is CorridorProfileBundle {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (o.kind !== CORRIDOR_PROFILE_KIND && o.kind !== "cyclegen.road_profile") {
    // Accept corridor-only imports with explicit corridor + optional route
    if (!o.corridor || typeof o.corridor !== "object") return false;
  }
  const corridor = (o.corridor ?? o) as Record<string, unknown>;
  if (!Array.isArray(corridor.S) || corridor.S.length < 2) return false;
  if (!Array.isArray(corridor.geometry) || corridor.geometry.length < 2) {
    return false;
  }
  const V =
    corridor.V_envelope ?? corridor.V_limite ?? corridor.V_limite_legal;
  if (!Array.isArray(V) || V.length < 2) return false;
  return true;
}

/** Normalize imported JSON into a usable bundle (route may be synthetic). */
export function normalizeImportedProfile(
  raw: unknown
): CorridorProfileBundle | null {
  if (!isCorridorProfileBundle(raw)) return null;
  const o = raw as Record<string, unknown>;
  const corridor = (o.corridor ?? o) as SpatialCorridor;
  const route =
    (o.route as RouteAnalyzeResponse | undefined) ??
    synthesizeRouteFromCorridor(corridor);
  const cacheKey =
    typeof o.cacheKey === "string" && o.cacheKey
      ? o.cacheKey
      : `import:${Date.now()}`;
  const meta =
    o.meta && typeof o.meta === "object"
      ? (o.meta as CorridorProfileBundle["meta"])
      : {
          routingProfile: "HERE/ADAS",
          aY: corridor.a_y_mps2 ?? 3.5,
          maxSpeedKmh: 130,
          envelopeMask: { legal: true, traffic: false, curve: true },
          origin: corridor.geometry[0] ?? null,
          destination:
            corridor.geometry[corridor.geometry.length - 1] ?? null,
        };
  return {
    v: 1,
    kind: CORRIDOR_PROFILE_KIND,
    savedAt:
      typeof o.savedAt === "string"
        ? o.savedAt
        : new Date().toISOString(),
    cacheKey,
    label: typeof o.label === "string" ? o.label : undefined,
    meta,
    route,
    corridor,
  };
}

function synthesizeRouteFromCorridor(
  corridor: SpatialCorridor
): RouteAnalyzeResponse {
  const geom = corridor.geometry ?? [];
  const n = geom.length;
  const segs: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const s0 = corridor.S[i] ?? 0;
    const s1 = corridor.S[i + 1] ?? s0;
    segs.push(Math.max(0, s1 - s0));
  }
  const legal = corridor.V_limite_legal?.length
    ? corridor.V_limite_legal.slice(0, Math.max(0, n - 1))
    : (corridor.V_limite ?? []).slice(0, Math.max(0, n - 1));
  while (legal.length < Math.max(0, n - 1)) {
    legal.push(legal[legal.length - 1] ?? 20);
  }
  const lats = geom.map((p) => p.lat);
  const lons = geom.map((p) => p.lon);
  return {
    geometry: geom,
    distance_m: corridor.S[corridor.S.length - 1] ?? 0,
    duration_s: 0,
    segment_speeds_mps: legal,
    segment_distances_m: segs,
    elevations_m: corridor.elevations_m ?? geom.map(() => 0),
    traffic_signals: [],
    bbox: [
      Math.min(...lats),
      Math.min(...lons),
      Math.max(...lats),
      Math.max(...lons),
    ],
    origin: geom[0] ?? null,
    destination: geom[n - 1] ?? null,
    traffic_source: corridor.traffic_source ?? "imported",
    segment_traffic_speeds_mps: corridor.V_traffic?.slice(0, n - 1) ?? [],
    a_y_mps2: corridor.a_y_mps2 ?? 3.5,
    elevation_source: "imported",
  };
}

export function buildExportBundle(args: {
  route: RouteAnalyzeResponse;
  corridor: SpatialCorridor;
  cacheKey: string;
  meta: CorridorProfileBundle["meta"];
  label?: string;
}): CorridorProfileBundle {
  return {
    v: 1,
    kind: CORRIDOR_PROFILE_KIND,
    savedAt: new Date().toISOString(),
    cacheKey: args.cacheKey,
    label: args.label,
    meta: args.meta,
    route: args.route,
    corridor: args.corridor,
  };
}

/** Async JSON parse — offloads large strings via Worker when > 1.5 MB. */
export function parseJsonAsync(text: string): Promise<unknown> {
  if (text.length < 1_500_000 || typeof Worker === "undefined") {
    return Promise.resolve().then(() => JSON.parse(text) as unknown);
  }
  return new Promise((resolve, reject) => {
    const src = `
      self.onmessage = (e) => {
        try {
          self.postMessage({ ok: true, data: JSON.parse(e.data) });
        } catch (err) {
          self.postMessage({ ok: false, error: String(err) });
        }
      };
    `;
    const blob = new Blob([src], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    const timer = window.setTimeout(() => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error("JSON parse timeout"));
    }, 60_000);
    worker.onmessage = (e: MessageEvent) => {
      window.clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      const msg = e.data as { ok: boolean; data?: unknown; error?: string };
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error || "JSON parse failed"));
    };
    worker.onerror = (err) => {
      window.clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(err.error ?? new Error("Worker failed"));
    };
    worker.postMessage(text);
  });
}

export async function readCorridorProfileFile(
  file: File
): Promise<CorridorProfileBundle> {
  const text = await file.text();
  const raw = await parseJsonAsync(text);
  const bundle = normalizeImportedProfile(raw);
  if (!bundle) {
    throw new Error(
      "JSON invalide — attendu un profil CycleGen (corridor.S + geometry)."
    );
  }
  return bundle;
}

export function downloadCorridorProfileJson(
  bundle: CorridorProfileBundle,
  filename?: string
): void {
  const json = JSON.stringify(bundle);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    filename ||
    `cyclegen_corridor_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function cacheKeyFromWaypoints(
  waypoints: WaypointDraft[]
): Array<{ lat: number; lon: number }> {
  return waypoints
    .filter((w) => w.lat != null && w.lon != null)
    .map((w) => ({ lat: w.lat as number, lon: w.lon as number }));
}
