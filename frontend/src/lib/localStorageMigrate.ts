/**
 * localStorage key migrations + origin hints.
 * Browser storage is origin-scoped: localhost ≠ 127.0.0.1.
 */

export const CYCLE_STORAGE_KEY = "cyclegen.savedCycles.v1";
export const TRIP_STORAGE_KEY = "cyclegen.savedTrips.v1";
export const DRIVER_STORAGE_KEY = "cyclegen.drivers.v3";
export const VEHICLE_STORAGE_KEY = "cyclegen.vehicles.v3";

const DRIVER_LEGACY = ["cyclegen.drivers.v2", "cyclegen.drivers.v1"] as const;
const VEHICLE_LEGACY = ["cyclegen.vehicles.v2", "cyclegen.vehicles.v1"] as const;

function parseArray(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Copy legacy driver/vehicle keys into current key once (user entries only). */
export function migrateLegacyLibraries(): {
  drivers: number;
  vehicles: number;
} {
  if (typeof window === "undefined") return { drivers: 0, vehicles: 0 };
  let drivers = 0;
  let vehicles = 0;

  try {
    const curD = parseArray(localStorage.getItem(DRIVER_STORAGE_KEY));
    if (!curD || curD.length === 0) {
      for (const key of DRIVER_LEGACY) {
        const legacy = parseArray(localStorage.getItem(key));
        if (legacy && legacy.length > 0) {
          localStorage.setItem(DRIVER_STORAGE_KEY, JSON.stringify(legacy));
          drivers = legacy.length;
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const curV = parseArray(localStorage.getItem(VEHICLE_STORAGE_KEY));
    if (!curV || curV.length === 0) {
      for (const key of VEHICLE_LEGACY) {
        const legacy = parseArray(localStorage.getItem(key));
        if (legacy && legacy.length > 0) {
          localStorage.setItem(VEHICLE_STORAGE_KEY, JSON.stringify(legacy));
          vehicles = legacy.length;
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }

  return { drivers, vehicles };
}

export function countSavedCyclesInStorage(): number {
  if (typeof window === "undefined") return 0;
  const arr = parseArray(localStorage.getItem(CYCLE_STORAGE_KEY));
  return arr?.length ?? 0;
}

/** Alternate host on same port (localhost ↔ 127.0.0.1). */
export function alternateOriginUrl(): string | null {
  if (typeof window === "undefined") return null;
  const { protocol, hostname, port, pathname, search, hash } = window.location;
  let alt: string | null = null;
  if (hostname === "localhost") alt = "127.0.0.1";
  else if (hostname === "127.0.0.1") alt = "localhost";
  if (!alt) return null;
  const p = port ? `:${port}` : "";
  return `${protocol}//${alt}${p}${pathname}${search}${hash}`;
}

export function currentOriginLabel(): string {
  if (typeof window === "undefined") return "";
  return window.location.host;
}
