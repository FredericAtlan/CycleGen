/**
 * Persist Studio wizard state across / ↔ /compare navigations (sessionStorage).
 * Cleared only when the user explicitly returns to the main menu.
 */

import type {
  ConsolidatedProfile,
  CycleGenWarning,
  DriverProfile,
  LatLon,
  RouteAnalyzeResponse,
  RoutingProfile,
  SimEngine,
  SpatialCorridor,
  Stage,
  WaypointDraft,
} from "@/lib/types";
import type { DriverPhysics } from "@/lib/driverPresets";
import type { DriverZone } from "@/lib/driverZones";
import type { EnvelopeMask } from "@/lib/corridorEdit";
import type { SlopeAlgoOptions } from "@/lib/slopeAlgo";
import type { LegalFilterOptions } from "@/lib/legalFilter";
import type { SlopeUnit } from "@/lib/units";
import type { MapSpeedLayers } from "@/components/MapLayerControls";
import type { StudioWizardStep } from "@/components/StudioStepper";

const SESSION_KEY = "cyclegen.studio.session.v1";
const FLAG_KEY = "cyclegen.studio.session.active";

export type StudioSessionSnapshot = {
  v: 1;
  savedAt: string;
  activeStep: StudioWizardStep;
  maxUnlocked: StudioWizardStep;
  preferredEngine: SimEngine;
  stage: Stage;
  departureLabel: string;
  destinationLabel: string;
  pointA: LatLon | null;
  pointB: LatLon | null;
  geometry: LatLon[];
  distanceM: number | null;
  durationS: number | null;
  routeResult: RouteAnalyzeResponse | null;
  corridor: SpatialCorridor | null;
  routingProfile: RoutingProfile;
  departAt: string;
  aY: number;
  trafficSource: string | null;
  warnings: CycleGenWarning[];
  driverProfile: DriverProfile;
  physics: DriverPhysics;
  /** Selected named driver (library id). */
  driverId?: string | null;
  driverZonesEnabled: boolean;
  driverZones: DriverZone[];
  maxSpeedKmh: number | null;
  vehicleId: string | null;
  slopeUnit: SlopeUnit;
  waypoints: WaypointDraft[];
  profile: ConsolidatedProfile | null;
  appliedParamsKey: string | null;
  envelopeMask: EnvelopeMask;
  /** Stochastic Markov a_noise (homologation default false). */
  enableMarkov?: boolean;
  /** When false, corridor TLS are stripped for charts / sim (restorable). */
  includeTrafficLights?: boolean;
  slopeAlgo?: SlopeAlgoOptions;
  /** Filtrage spatial V_legal (limites postées). */
  legalFilter?: LegalFilterOptions;
  showRouteArrows: boolean;
  mapSpeedLayers: MapSpeedLayers;
  referenceGeometry: LatLon[];
  syncChartMap: boolean;
  elevationA_m?: number | null;
  elevationB_m?: number | null;
  /** Base / corpus profile kept for overlay on analysis charts (vs current sim). */
  referenceCycle?: {
    name: string;
    time: number[];
    velocity: number[];
  } | null;
  /** True once a new simulation replaced the base as `profile`. */
  showBaseOverlay?: boolean;
  /** Corpus / import without GPS — results-only (vehicle power). */
  noGpsBase?: boolean;
  /** Display title when a library study was reopened. */
  savedCycleTitle?: string | null;
};

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function isMeaningfulStudioSession(
  s: StudioSessionSnapshot | null | undefined
): boolean {
  if (!s) return false;
  if (s.pointA || s.pointB) return true;
  if (s.geometry?.length >= 2) return true;
  if (s.corridor && s.corridor.S?.length > 1) return true;
  if (s.profile && s.profile.time?.length > 1) return true;
  if (s.waypoints?.some((w) => (w.lat != null && w.lon != null) || w.address?.trim()))
    return true;
  if (
    s.departureLabel &&
    s.destinationLabel &&
    (s.departureLabel.trim().length > 2 || s.destinationLabel.trim().length > 2)
  ) {
    // Labels alone can be defaults — require they differ from empty-ish work
    return s.activeStep > 1 || s.maxUnlocked > 1;
  }
  return s.activeStep > 1 || s.maxUnlocked > 1;
}

export function hasStudioSession(): boolean {
  if (!isBrowser()) return false;
  try {
    if (sessionStorage.getItem(FLAG_KEY) === "1") return true;
    return isMeaningfulStudioSession(loadStudioSession());
  } catch {
    return false;
  }
}

export function loadStudioSession(): StudioSessionSnapshot | null {
  if (!isBrowser()) return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StudioSessionSnapshot;
    if (!parsed || parsed.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStudioSession(snap: StudioSessionSnapshot): boolean {
  if (!isBrowser()) return false;
  try {
    const payload: StudioSessionSnapshot = {
      ...snap,
      v: 1,
      savedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    if (isMeaningfulStudioSession(payload)) {
      sessionStorage.setItem(FLAG_KEY, "1");
    }
    return true;
  } catch {
    // Quota / private mode — keep UI working without persistence.
    return false;
  }
}

export function clearStudioSession(): void {
  if (!isBrowser()) return;
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(FLAG_KEY);
  } catch {
    /* ignore */
  }
}
