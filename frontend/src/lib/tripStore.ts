import { DRIVER_PRESETS, type DriverPhysics } from "./driverPresets";
import type {
  ConsolidatedProfile,
  CycleGenWarning,
  DriverProfile,
  LatLon,
  RouteAnalyzeResponse,
  RoutingProfile,
  SpatialCorridor,
  WaypointDraft,
} from "./types";

const STORAGE_KEY = "cyclegen.savedTrips.v1";
const MAX_TRIPS = 40;

export type SavedTripSnapshot = {
  id: string;
  name: string;
  savedAt: string;
  departureLabel: string;
  destinationLabel: string;
  pointA: LatLon | null;
  pointB: LatLon | null;
  waypoints: WaypointDraft[];
  departAt: string;
  routingProfile: RoutingProfile | string;
  aY: number;
  driverProfile: DriverProfile;
  physics: DriverPhysics;
  maxSpeedKmh: number | null;
  /** Optional analysis cache — avoids recompute on load when present. */
  geometry?: LatLon[];
  distanceM?: number | null;
  durationS?: number | null;
  routeResult?: RouteAnalyzeResponse | null;
  corridor?: SpatialCorridor | null;
  profile?: ConsolidatedProfile | null;
  trafficSource?: string | null;
  warnings?: CycleGenWarning[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function normalizePhysics(raw: unknown): DriverPhysics {
  const base = DRIVER_PRESETS[1].physics;
  if (!isRecord(raw)) return { ...base };
  return {
    a_max: asNumber(raw.a_max, base.a_max),
    b_comf: asNumber(raw.b_comf, base.b_comf),
    speed_factor: asNumber(raw.speed_factor, base.speed_factor),
    T: asNumber(raw.T, base.T),
    T_h: asNumber(raw.T_h, base.T_h),
    s0: asNumber(raw.s0, base.s0),
    jerk_max: asNumber(raw.jerk_max, base.jerk_max),
    jerk_brake_max: asNumber(raw.jerk_brake_max, base.jerk_brake_max),
  };
}

function normalizeProfile(raw: unknown): ConsolidatedProfile | null {
  if (!isRecord(raw)) return null;
  const time = Array.isArray(raw.time) ? (raw.time as number[]) : null;
  const velocity = Array.isArray(raw.velocity)
    ? (raw.velocity as number[])
    : null;
  if (!time || !velocity || time.length < 2 || time.length !== velocity.length) {
    return null;
  }
  const n = time.length;
  const zeros = () => Array.from({ length: n }, () => 0);
  const position = Array.isArray(raw.position)
    ? (raw.position as number[])
    : zeros();
  const acceleration = Array.isArray(raw.acceleration)
    ? (raw.acceleration as number[])
    : zeros();
  const slope = Array.isArray(raw.slope) ? (raw.slope as number[]) : zeros();
  const status =
    raw.status === "stopped" || raw.status === "completed"
      ? raw.status
      : "completed";
  return {
    time,
    velocity,
    position: position.length === n ? position : zeros(),
    acceleration: acceleration.length === n ? acceleration : zeros(),
    slope: slope.length === n ? slope : zeros(),
    total_duration_s: asNumber(
      raw.total_duration_s,
      Math.max(0, time[time.length - 1] - time[0])
    ),
    average_speed_kmh: asNumber(raw.average_speed_kmh, 0),
    status,
    traffic_source:
      typeof raw.traffic_source === "string" || raw.traffic_source === null
        ? (raw.traffic_source as string | null)
        : undefined,
    warnings: Array.isArray(raw.warnings)
      ? (raw.warnings as CycleGenWarning[])
      : undefined,
  };
}

function normalizeCorridor(raw: unknown): SpatialCorridor | null {
  if (!isRecord(raw)) return null;
  const S = Array.isArray(raw.S) ? (raw.S as number[]) : null;
  const V_limite = Array.isArray(raw.V_limite)
    ? (raw.V_limite as number[])
    : null;
  const alpha = Array.isArray(raw.alpha) ? (raw.alpha as number[]) : null;
  const geometry = Array.isArray(raw.geometry)
    ? (raw.geometry as LatLon[])
    : null;
  if (!S || !V_limite || !alpha || !geometry) return null;
  if (S.length < 2 || S.length !== V_limite.length || S.length !== alpha.length) {
    return null;
  }
  return {
    ...(raw as unknown as SpatialCorridor),
    S,
    V_limite,
    alpha,
    geometry,
    S_feux: Array.isArray(raw.S_feux) ? (raw.S_feux as number[]) : [],
    events: Array.isArray(raw.events) ? (raw.events as SpatialCorridor["events"]) : [],
  };
}

/** Coerce a loosely stored trip into a safe runtime snapshot. */
export function normalizeSavedTrip(raw: unknown): SavedTripSnapshot | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id, "");
  const name = asString(raw.name, "");
  if (!id || !name) return null;

  const driverProfile =
    raw.driverProfile === "Eco" ||
    raw.driverProfile === "Normal" ||
    raw.driverProfile === "Agressif" ||
    raw.driverProfile === "Sportif" ||
    raw.driverProfile === "Prudent" ||
    raw.driverProfile === "Dynamique"
      ? raw.driverProfile
      : "Normal";

  return {
    id,
    name,
    savedAt: asString(raw.savedAt, new Date(0).toISOString()),
    departureLabel: asString(raw.departureLabel, ""),
    destinationLabel: asString(raw.destinationLabel, ""),
    pointA: isRecord(raw.pointA)
      ? {
          lat: asNumber(raw.pointA.lat, 0),
          lon: asNumber(raw.pointA.lon, 0),
        }
      : null,
    pointB: isRecord(raw.pointB)
      ? {
          lat: asNumber(raw.pointB.lat, 0),
          lon: asNumber(raw.pointB.lon, 0),
        }
      : null,
    waypoints: Array.isArray(raw.waypoints)
      ? (raw.waypoints as WaypointDraft[])
      : [],
    departAt: asString(raw.departAt, ""),
    routingProfile: asString(raw.routingProfile, "Mapbox/Traffic"),
    aY: asNumber(raw.aY, 2.5),
    driverProfile,
    physics: normalizePhysics(raw.physics),
    maxSpeedKmh:
      typeof raw.maxSpeedKmh === "number" || raw.maxSpeedKmh === null
        ? (raw.maxSpeedKmh as number | null)
        : null,
    geometry: Array.isArray(raw.geometry) ? (raw.geometry as LatLon[]) : [],
    distanceM:
      typeof raw.distanceM === "number" || raw.distanceM === null
        ? (raw.distanceM as number | null)
        : null,
    durationS:
      typeof raw.durationS === "number" || raw.durationS === null
        ? (raw.durationS as number | null)
        : null,
    routeResult: (raw.routeResult as RouteAnalyzeResponse | null) ?? null,
    corridor: normalizeCorridor(raw.corridor),
    profile: normalizeProfile(raw.profile),
    trafficSource:
      typeof raw.trafficSource === "string" || raw.trafficSource === null
        ? (raw.trafficSource as string | null)
        : null,
    warnings: Array.isArray(raw.warnings)
      ? (raw.warnings as CycleGenWarning[])
      : [],
  };
}

function safeParse(raw: string | null): SavedTripSnapshot[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .map((t) => normalizeSavedTrip(t))
      .filter((t): t is SavedTripSnapshot => t != null);
  } catch {
    return [];
  }
}

export function listSavedTrips(): SavedTripSnapshot[] {
  if (typeof window === "undefined") return [];
  return safeParse(window.localStorage.getItem(STORAGE_KEY)).sort((a, b) =>
    (b.savedAt || "").localeCompare(a.savedAt || "")
  );
}

export type SaveTripResult =
  | { ok: true; trip: SavedTripSnapshot; slimmed?: boolean }
  | { ok: false; reason: string };

export function saveTrip(
  trip: Omit<SavedTripSnapshot, "id" | "savedAt"> & {
    id?: string;
    savedAt?: string;
  }
): SaveTripResult {
  const id =
    trip.id ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `trip-${Date.now()}`);
  const saved: SavedTripSnapshot = {
    ...trip,
    id,
    savedAt: trip.savedAt ?? new Date().toISOString(),
    physics: normalizePhysics(trip.physics),
    profile: normalizeProfile(trip.profile) ?? trip.profile ?? null,
    corridor: normalizeCorridor(trip.corridor) ?? trip.corridor ?? null,
    waypoints: trip.waypoints ?? [],
    warnings: trip.warnings ?? [],
  };
  const next = [saved, ...listSavedTrips().filter((t) => t.id !== id)].slice(
    0,
    MAX_TRIPS
  );
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return { ok: true, trip: saved };
  } catch (err) {
    // Long alpine corridors (~3k pts × arrays) can exceed localStorage quota.
    const slim = {
      ...saved,
      geometry: (saved.geometry ?? []).filter((_, i, arr) => {
        if (arr.length <= 400) return true;
        const step = Math.ceil(arr.length / 400);
        return i % step === 0 || i === arr.length - 1;
      }),
      corridor: saved.corridor
        ? {
            ...saved.corridor,
            // Keep metadata; drop heavy series so save still works.
            S: [],
            alpha: [],
            V_limite: [],
            geometry: [],
          }
        : null,
      profile: null,
      routeResult: saved.routeResult
        ? {
            ...saved.routeResult,
            geometry: [],
            elevations_m: [],
          }
        : null,
    };
    const slimNext = [
      slim,
      ...listSavedTrips().filter((t) => t.id !== id),
    ].slice(0, MAX_TRIPS);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slimNext));
      return { ok: true, trip: slim, slimmed: true };
    } catch {
      console.warn(
        "tripStore: localStorage quota exceeded; trip not persisted",
        err
      );
      return {
        ok: false,
        reason: "localStorage quota exceeded — trip not saved",
      };
    }
  }
}

export function deleteSavedTrip(id: string): void {
  const next = listSavedTrips().filter((t) => t.id !== id);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function getSavedTrip(id: string): SavedTripSnapshot | null {
  return listSavedTrips().find((t) => t.id === id) ?? null;
}

export function defaultTripName(
  departureLabel: string,
  destinationLabel: string
): string {
  const a = departureLabel.trim() || "A";
  const b = destinationLabel.trim() || "B";
  const stamp = new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${a} → ${b} · ${stamp}`;
}
