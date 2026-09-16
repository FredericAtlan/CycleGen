"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import DynamicMap from "@/components/DynamicMap";
import RoadLoupe3D from "@/components/corridor/RoadLoupe3D";
import Sidebar from "@/components/Sidebar";
import MapCameraControls from "@/components/MapCameraControls";
import { ChartFocusHostProvider } from "@/components/corridor/ChartFocusHost";
import ConstraintWorkspace, {
  type ElevationCombineMode,
  type LegalSmoothMode,
} from "@/components/corridor/ConstraintWorkspace";
import {
  buildElevationSourceRows,
  buildSpeedSourceRows,
  type SpeedSourceKey,
} from "@/components/corridor/RouterSourceToggles";
import type { ElevationSourceKey } from "@/lib/types";
import {
  DEFAULT_MAP_SPEED_LAYERS,
  type MapSpeedLayers,
} from "@/components/MapLayerControls";
import {
  type StudioWizardStep,
} from "@/components/StudioStepper";
import { useHeaderChrome } from "@/components/HeaderChromeContext";
import ResultsAnalysisPanel from "@/components/export/ResultsAnalysisPanel";
import type { LivePoint } from "@/components/simulation/LiveCharts";
import LiveAnalysisPanel from "@/components/simulation/LiveAnalysisPanel";
import { interpolateAlongS } from "@/components/simulation/geo";
import {
  useSimulationSocket,
  type SimSocketStatus,
} from "@/components/simulation/useSimulationSocket";
import {
  buildCycleParamsSnapshot,
  cycleParamsKeyOf,
  diffCycleParamsLines,
  formatStaleCycleMessage,
  parseCycleParamsSnapshot,
} from "@/lib/cycleParamsDiff";
import { getVehicle } from "@/lib/vehicleLibrary";
import {
  DEFAULT_DRIVER_ID,
  driverLabel,
  getDriver,
} from "@/lib/driverLibrary";
import {
  analyzeRoute,
  buildCorridor,
  startSimulation,
  stopSimulation,
  simulationWsUrl,
  geocodeAddress,
  getBenchmarkSource,
  lookupElevations,
  ApiError,
} from "@/lib/api";
import type {
  ConsolidatedProfile,
  CycleGenWarning,
  DriverProfile,
  LatLon,
  RouteAnalyzeResponse,
  RoutingProfile,
  SimEngine,
  SimulationFrame,
  SpatialCorridor,
  Stage,
  VehicleSnapshot,
  WaypointDraft,
} from "@/lib/types";
import {
  DEFAULT_DEPARTURE_LABEL,
  DEFAULT_DESTINATION_LABEL,
  MAX_WAYPOINTS,
} from "@/lib/types";
import {
  DEFAULT_A_Y,
  DEFAULT_MAX_SPEED_KMH,
  defaultDriverPhysics,
  presetFor,
  type DriverPhysics,
} from "@/lib/driverPresets";
import {
  RENAULT_GROSSGLOCKNER_ZONES,
  type DriverZone,
} from "@/lib/driverZones";
import type { SlopeUnit } from "@/lib/units";
import { newWaypointDraft, type MapClickMode } from "@/components/WaypointsEditor";
import {
  defaultCycleName,
  elevationExtremesM,
  looksLikeGpsLabel,
  packCycle,
  resolveCycleSaveName,
  stashCyclesForCompare,
  clearStashedBaseCycle,
  peekStashedBaseCycle,
  seedStudioSessionFromCycle,
  slimCycleForStudioTransfer,
  peekPendingCorpusOpen,
  takePendingCorpusOpen,
  type SavedCycle,
} from "@/lib/cycleLibrary";
import {
  computeCycleStats,
  enrichSeriesFromGps,
  lateralAccelFromCorridor,
} from "@/lib/cycleMetrics";
import {
  geometrySliceByS,
  nextFocus,
  type MapFocusInput,
  type MapFocusRequest,
} from "@/lib/mapFocus";
import {
  applyEnvelopeMask,
  DEFAULT_ENVELOPE_MASK,
  restoreFeux,
  snapshotFeux,
  type EnvelopeMask,
  type FeuxBackup,
  withUpdatedFeux,
} from "@/lib/corridorEdit";
import {
  buildExportBundle,
  cacheKeyFromWaypoints,
  downloadCorridorProfileJson,
  getCorridorProfile,
  makeCorridorCacheKey,
  putCorridorProfile,
  readCorridorProfileFile,
  type CorridorProfileBundle,
} from "@/lib/corridorProfileStore";
import {
  CONSTRAINTS_REBUILD_DEBOUNCE_MS,
  DEFAULT_SLOPE_ALGO,
  normalizeSlopeAlgo,
  resolveSlopeAlgo,
  slopeAlgoKey,
  type SlopeAlgoOptions,
} from "@/lib/slopeAlgo";
import {
  DEFAULT_LEGAL_FILTER,
  legalFilterKey,
  normalizeLegalFilter,
  resolveLegalFilter,
  type LegalFilterOptions,
} from "@/lib/legalFilter";
import { formatGpsLabel, parseGpsCoords } from "@/lib/parseGps";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import {
  clearStudioSession,
  loadStudioSession,
  saveStudioSession,
  type StudioSessionSnapshot,
} from "@/lib/studioSession";
import { useHelpOptional } from "@/components/HelpContext";
import LeaveStudioDialog from "@/components/LeaveStudioDialog";
import StudioAlerts, { type StudioToast } from "@/components/StudioAlerts";
import BuildProgressGauge from "@/components/BuildProgressGauge";
import { useGlobalWarnings } from "@/components/GlobalWarningsContext";

const MAX_SERIES = 600;

/** Format Date → value for `<input type="datetime-local">` (local TZ). */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert datetime-local string to ISO 8601 for the API. */
function datetimeLocalToIso(local: string): string {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return `${h}h ${rem}m`;
  }
  return `${m} min ${s}s`;
}

function waypointRouteFingerprint(wps: WaypointDraft[]): string {
  return wps
    .filter((w) => (w.lat != null && w.lon != null) || w.address.trim().length > 0)
    .map(
      (w) =>
        `${w.lat ?? ""},${w.lon ?? ""},${w.address.trim()},${w.stop_duration_s}`
    )
    .join("|");
}

/** Stable route id — coords only (labels change after geocode and must not force re-analyze). */
function routeFingerprint(args: {
  departAt: string;
  routingProfile: string;
  pointA: LatLon | null;
  pointB: LatLon | null;
  waypoints: WaypointDraft[];
}): string {
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  return JSON.stringify({
    departAt: args.departAt,
    routingProfile: args.routingProfile,
    a: args.pointA
      ? [round(args.pointA.lat), round(args.pointA.lon)]
      : null,
    b: args.pointB
      ? [round(args.pointB.lat), round(args.pointB.lon)]
      : null,
    vias: args.waypoints
      .filter((w) => w.lat != null && w.lon != null)
      .map((w) => [round(w.lat!), round(w.lon!), w.stop_duration_s]),
  });
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function CycleGenShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openEnergy =
    searchParams.get("open") === "energy" ||
    searchParams.get("open") === "study";
  /** One-shot restore so Studio ↔ Versus keeps route / corridor / profile. */
  const bootRef = useRef<StudioSessionSnapshot | null | undefined>(undefined);
  if (bootRef.current === undefined) {
    bootRef.current = loadStudioSession();
  }
  const boot = bootRef.current;

  const [activeStep, setActiveStep] = useState<StudioWizardStep>(
    () => boot?.activeStep ?? 1
  );
  /** High-water unlock — does not drop when corridor is briefly cleared mid-pipeline. */
  const [maxUnlocked, setMaxUnlocked] = useState<StudioWizardStep>(
    () => boot?.maxUnlocked ?? 1
  );
  const [preferredEngine, setPreferredEngine] = useState<SimEngine>(
    () => boot?.preferredEngine ?? "idm"
  );
  const [stage, setStage] = useState<Stage>(() => {
    const s = boot?.stage ?? "route";
    if (s === "simulating") {
      return boot?.profile && boot.profile.time.length > 1
        ? "completed"
        : boot?.corridor
          ? "corridor"
          : "route";
    }
    return s;
  });
  const [departureLabel, setDepartureLabel] = useState(
    () => boot?.departureLabel ?? DEFAULT_DEPARTURE_LABEL
  );
  const [destinationLabel, setDestinationLabel] = useState(
    () => boot?.destinationLabel ?? DEFAULT_DESTINATION_LABEL
  );
  const [pointA, setPointA] = useState<LatLon | null>(() => boot?.pointA ?? null);
  const [pointB, setPointB] = useState<LatLon | null>(() => boot?.pointB ?? null);
  /** Title chosen at last save; cleared when A/B GPS change. */
  const [savedCycleTitle, setSavedCycleTitle] = useState<string | null>(
    () => boot?.savedCycleTitle ?? null
  );
  const [elevationA_m, setElevationA_m] = useState<number | null>(
    () => boot?.elevationA_m ?? null
  );
  const [elevationB_m, setElevationB_m] = useState<number | null>(
    () => boot?.elevationB_m ?? null
  );
  const [geometry, setGeometry] = useState<LatLon[]>(
    () => boot?.geometry ?? []
  );
  const [distanceM, setDistanceM] = useState<number | null>(
    () => boot?.distanceM ?? null
  );
  const [durationS, setDurationS] = useState<number | null>(
    () => boot?.durationS ?? null
  );
  const [routeResult, setRouteResult] = useState<RouteAnalyzeResponse | null>(
    () => boot?.routeResult ?? null
  );
  const [corridor, setCorridor] = useState<SpatialCorridor | null>(
    () => boot?.corridor ?? null
  );
  const [routingProfile, setRoutingProfile] = useState<RoutingProfile>(
    () => (boot?.routingProfile as RoutingProfile) ?? "HERE/ADAS"
  );
  // Multi-router selection (ordered ; first = primary geometry).
  const [routingProfiles, setRoutingProfiles] = useState<RoutingProfile[]>(
    () => {
      const primary =
        (boot?.routingProfile as RoutingProfile) ?? "HERE/ADAS";
      return [primary];
    }
  );
  const [departAt, setDepartAt] = useState(
    () => boot?.departAt ?? toDatetimeLocalValue(new Date())
  );
  const [aY, setAY] = useState(() => boot?.aY ?? DEFAULT_A_Y);
  const [trafficSource, setTrafficSource] = useState<string | null>(
    () => boot?.trafficSource ?? null
  );
  const [warnings, setWarnings] = useState<CycleGenWarning[]>(
    () => boot?.warnings ?? []
  );
  const [driverProfile, setDriverProfile] = useState<DriverProfile>(
    () => boot?.driverProfile ?? "Normal"
  );
  const [physics, setPhysics] = useState<DriverPhysics>(
    () => boot?.physics ?? defaultDriverPhysics()
  );
  const [driverZonesEnabled, setDriverZonesEnabled] = useState(
    () => boot?.driverZonesEnabled ?? false
  );
  const [driverZones, setDriverZones] = useState<DriverZone[]>(
    () => boot?.driverZones ?? [...RENAULT_GROSSGLOCKNER_ZONES]
  );
  const [maxSpeedKmh, setMaxSpeedKmh] = useState<number | null>(
    () => boot?.maxSpeedKmh ?? DEFAULT_MAX_SPEED_KMH
  );
  const [vehicleId, setVehicleId] = useState<string | null>(
    () => boot?.vehicleId ?? "renault-cspace-leapfrog-apr2bis"
  );
  const [driverId, setDriverId] = useState<string | null>(
    () => boot?.driverId ?? DEFAULT_DRIVER_ID
  );
  const [slopeUnit, setSlopeUnit] = useState<SlopeUnit>(
    () => boot?.slopeUnit ?? "percent"
  );
  const [waypoints, setWaypoints] = useState<WaypointDraft[]>(
    () => boot?.waypoints ?? []
  );
  const [clickMode, setClickMode] = useState<MapClickMode>("navigate");
  const [geocodingEndpoint, setGeocodingEndpoint] = useState<"A" | "B" | null>(
    null
  );
  const [geocodingWaypointId, setGeocodingWaypointId] = useState<string | null>(
    null
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [buildingCorridor, setBuildingCorridor] = useState(false);
  const [generatingCycle, setGeneratingCycle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [corridorError, setCorridorError] = useState<string | null>(null);

  /* Step 3–4 simulation state */
  const [simStarting, setSimStarting] = useState(false);
  const [simStopping, setSimStopping] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [simulationId, setSimulationId] = useState<string | null>(null);
  const [simEngine, setSimEngine] = useState<SimEngine | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [wsEnabled, setWsEnabled] = useState(false);
  const [wsStatus, setWsStatus] = useState<SimSocketStatus>("idle");
  const [wsMessage, setWsMessage] = useState<string | null>(null);
  const [series, setSeries] = useState<LivePoint[]>([]);
  const [density, setDensity] = useState(0);
  const [simT, setSimT] = useState(0);
  const [simS, setSimS] = useState(0);
  const [egoPosition, setEgoPosition] = useState<LatLon | null>(null);
  const [otherVehicles, setOtherVehicles] = useState<VehicleSnapshot[]>([]);
  const [profile, setProfile] = useState<ConsolidatedProfile | null>(
    () => boot?.profile ?? null
  );

  /* Chart ↔ map sync / camera */
  const [syncChartMap, setSyncChartMap] = useState(
    () => boot?.syncChartMap ?? true
  );
  const [chartCursorS, setChartCursorS] = useState<number | null>(null);
  const [brushRange, setBrushRange] = useState<{
    s0: number;
    s1: number;
  } | null>(null);
  const [mapFocus, setMapFocus] = useState<MapFocusRequest | null>(null);
  const [referenceGeometry, setReferenceGeometry] = useState<LatLon[]>(
    () => boot?.referenceGeometry ?? []
  );
  /** Base corpus/saved cycle kept for analysis overlay (sim vs base) — not Versus. */
  const [referenceCycle, setReferenceCycle] = useState<{
    name: string;
    time: number[];
    velocity: number[];
  } | null>(() => boot?.referenceCycle ?? null);
  const [showBaseOverlay, setShowBaseOverlay] = useState(
    () => boot?.showBaseOverlay ?? false
  );
  const [leaveOpen, setLeaveOpen] = useState(false);
  /** When set to the current stage-banner text, the bottom map chip stays hidden. */
  const [stageBannerDismissed, setStageBannerDismissed] = useState<string | null>(
    null
  );
  const help = useHelpOptional();
  const setHelpStudioStep = help?.setStudioStep;
  const { setHeaderChrome } = useHeaderChrome();
  const { setWarnings: setGlobalWarnings } = useGlobalWarnings();

  useEffect(() => {
    setGlobalWarnings(warnings);
  }, [warnings, setGlobalWarnings]);

  useEffect(() => {
    return () => setGlobalWarnings([]);
  }, [setGlobalWarnings]);

  useEffect(() => {
    setHelpStudioStep?.(activeStep);
  }, [activeStep, setHelpStudioStep]);

  /** Base corpus without lat/lon — results-only (vehicle power), no route/sim. */
  const [noGpsBase, setNoGpsBase] = useState(
    () =>
      boot?.noGpsBase ??
      !!(
        boot?.profile &&
        boot.profile.time.length > 1 &&
        (boot.geometry?.length ?? 0) < 2
      )
  );
  const [envelopeMask, setEnvelopeMask] = useState<EnvelopeMask>(
    () => boot?.envelopeMask ?? DEFAULT_ENVELOPE_MASK
  );
  const [enableMarkov, setEnableMarkov] = useState(
    () => boot?.enableMarkov ?? false
  );
  // Contraintes step 2 — sources cochables + clamps.
  const [speedSources, setSpeedSources] = useState<SpeedSourceKey[]>([
    "here",
    "mapbox",
    "osrm",
    "osm",
  ]);
  const [elevationSources, setElevationSources] = useState<ElevationSourceKey[]>(
    ["here", "open-meteo", "open-elevation", "opentopodata"]
  );
  const [elevationCombine, setElevationCombine] =
    useState<ElevationCombineMode>("mean");
  const [speedMinKmh, setSpeedMinKmh] = useState<number | null>(null);
  const [speedMaxKmh, setSpeedMaxKmh] = useState<number | null>(null);
  const [respectLegalLimits, setRespectLegalLimits] = useState(true);
  const [legalSmoothModeLocal, setLegalSmoothModeLocal] =
    useState<LegalSmoothMode>("majority");
  const [legalSmoothWindowLocal, setLegalSmoothWindowLocal] = useState(250);
  const [slopeSpatialWindowLocal, setSlopeSpatialWindowLocal] = useState(150);
  const [trapLengthMLocal, setTrapLengthMLocal] = useState(50);
  const [corridorProfileBusy, setCorridorProfileBusy] = useState(false);
  const [includeTrafficLights, setIncludeTrafficLights] = useState(
    () => boot?.includeTrafficLights ?? true
  );
  const feuxBackupRef = useRef<FeuxBackup | null>(null);
  const [slopeAlgo, setSlopeAlgo] = useState<SlopeAlgoOptions>(
    () => normalizeSlopeAlgo(boot?.slopeAlgo)
  );
  const [legalFilter, setLegalFilter] = useState<LegalFilterOptions>(
    () => normalizeLegalFilter(boot?.legalFilter)
  );
  const [showRouteArrows, setShowRouteArrows] = useState(
    () => boot?.showRouteArrows ?? true
  );
  const [mapSpeedLayers, setMapSpeedLayers] = useState<MapSpeedLayers>(
    () => boot?.mapSpeedLayers ?? DEFAULT_MAP_SPEED_LAYERS
  );
  const focusNonceRef = useRef(0);
  const lastBuiltAYRef = useRef<number | null>(boot?.aY ?? null);
  const lastSlopeAlgoKeyRef = useRef<string>(
    slopeAlgoKey(boot?.slopeAlgo ?? DEFAULT_SLOPE_ALGO)
  );
  const lastLegalFilterKeyRef = useRef<string>(
    legalFilterKey(boot?.legalFilter ?? DEFAULT_LEGAL_FILTER)
  );
  const simulationIdRef = useRef<string | null>(null);
  const consolidatingRef = useRef(false);
  /** Params fingerprint of the last successfully launched cycle (null = jamais généré). */
  const [appliedParamsKey, setAppliedParamsKey] = useState<string | null>(
    () => boot?.appliedParamsKey ?? null
  );
  /** After base-cycle restore: sync appliedParamsKey once cycleParamsKey settles. */
  const syncAppliedKeyRef = useRef(false);
  const lastRouteKeyRef = useRef<string | null>(
    boot
      ? routeFingerprint({
          departAt: boot.departAt,
          routingProfile: boot.routingProfile,
          pointA: boot.pointA,
          pointB: boot.pointB,
          waypoints: boot.waypoints,
        })
      : null
  );
  const lastEnvelopeKeyRef = useRef<string | null>(null);
  const sessionReadyRef = useRef(false);
  const sessionSnapRef = useRef<StudioSessionSnapshot | null>(null);
  const [studioToasts, setStudioToasts] = useState<StudioToast[]>([]);
  const staleToastPrevDirtyRef = useRef(false);
  const staleToastKeyRef = useRef<string | null>(null);

  /** Route factors that change traffic / legal envelope (coords, not address labels). */
  const routeKey = useMemo(
    () =>
      routeFingerprint({
        departAt,
        routingProfile,
        pointA,
        pointB,
        waypoints,
      }),
    [departAt, routingProfile, pointA, pointB, waypoints]
  );

  /** Spatial envelope factors (a_y, mask, route, slope algo, legal filter). */
  const envelopeKey = useMemo(
    () =>
      JSON.stringify({
        aY,
        envelopeMask,
        routeKey,
        slope: slopeAlgoKey(slopeAlgo),
        legal: legalFilterKey(legalFilter),
      }),
    [aY, envelopeMask, routeKey, slopeAlgo, legalFilter]
  );

  // After restore, treat envelope as already applied so we don't rebuild on mount.
  useEffect(() => {
    if (boot?.corridor && boot.corridor.S.length > 1) {
      lastEnvelopeKeyRef.current = envelopeKey;
      lastBuiltAYRef.current = aY;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once
  }, []);

  /**
   * Snapshot of params that structurally change the kinematic cycle on Appliquer.
   * Excludes UI-only / post-hoc overlays (vehicle power card, slope unit, map sync…).
   */
  const cycleParamsSnap = useMemo(
    () =>
      buildCycleParamsSnapshot({
        routeKey,
        aY,
        envelopeMask,
        slopeKey: slopeAlgoKey(slopeAlgo),
        legalKey: legalFilterKey(legalFilter),
        includeTrafficLights,
        physics,
        maxSpeedKmh,
        driverProfile,
        driverZonesEnabled,
        driverZones,
        preferredEngine,
        feux: (corridor?.S_feux ?? []).map((s, i) => ({
          s: Math.round(s * 10) / 10,
          m: corridor?.feux_meta?.[i]?.tls_mode ?? "stochastic",
        })),
      }),
    [
      routeKey,
      aY,
      envelopeMask,
      slopeAlgo,
      legalFilter,
      includeTrafficLights,
      physics,
      maxSpeedKmh,
      driverProfile,
      driverZonesEnabled,
      driverZones,
      preferredEngine,
      corridor?.S_feux,
      corridor?.feux_meta,
    ]
  );

  const cycleParamsKey = useMemo(
    () => cycleParamsKeyOf(cycleParamsSnap),
    [cycleParamsSnap]
  );

  /** Pending param edits after a cycle — wait for explicit Appliquer. */
  const paramsDirty =
    appliedParamsKey != null && appliedParamsKey !== cycleParamsKey;

  const paramsDirtyLines = useMemo(() => {
    if (!paramsDirty) return [];
    const before = parseCycleParamsSnapshot(appliedParamsKey);
    return diffCycleParamsLines(before, cycleParamsSnap);
  }, [paramsDirty, appliedParamsKey, cycleParamsSnap]);

  // After restoring a saved profile, mark current params as applied (not dirty).
  useEffect(() => {
    if (!syncAppliedKeyRef.current) return;
    syncAppliedKeyRef.current = false;
    setAppliedParamsKey(cycleParamsKey);
  }, [cycleParamsKey]);

  // Toast when params change after a profile is already available.
  useEffect(() => {
    const hasProfile = !!profile && profile.time.length > 1;
    const becameDirty = paramsDirty && !staleToastPrevDirtyRef.current;
    const fingerprintChangedWhileDirty =
      paramsDirty &&
      hasProfile &&
      staleToastKeyRef.current != null &&
      staleToastKeyRef.current !== cycleParamsKey;
    staleToastPrevDirtyRef.current = paramsDirty;

    if (!paramsDirty || !hasProfile) {
      if (!paramsDirty) {
        staleToastKeyRef.current = null;
        setStudioToasts((prev) =>
          prev.some((t) => t.id.startsWith("stale-"))
            ? prev.filter((t) => !t.id.startsWith("stale-"))
            : prev
        );
      }
      return;
    }

    if (becameDirty || fingerprintChangedWhileDirty) {
      staleToastKeyRef.current = cycleParamsKey;
      const id = `stale-${Date.now()}`;
      const { message, lines } = formatStaleCycleMessage(paramsDirtyLines);
      setStudioToasts((prev) => [
        ...prev.filter((t) => !t.id.startsWith("stale-")),
        { id, message, lines },
      ]);
      // Keep visible long enough to read the before→after list.
      const t = window.setTimeout(() => {
        setStudioToasts((prev) => prev.filter((x) => x.id !== id));
      }, 45_000);
      return () => window.clearTimeout(t);
    }
    staleToastKeyRef.current = cycleParamsKey;
  }, [paramsDirty, cycleParamsKey, paramsDirtyLines, profile]);

  const bumpFocus = useCallback((partial: MapFocusInput) => {
    focusNonceRef.current += 1;
    setMapFocus(nextFocus(partial, focusNonceRef.current));
  }, []);

  const focusEnteredPoints = useCallback(
    (a: LatLon | null, b: LatLon | null, vias = waypoints) => {
      const pts: LatLon[] = [];
      if (a) pts.push(a);
      for (const w of vias) {
        if (w.lat != null && w.lon != null) pts.push({ lat: w.lat, lon: w.lon });
      }
      if (b) pts.push(b);
      if (pts.length >= 2) bumpFocus({ kind: "bounds", points: pts });
      else if (pts.length === 1) bumpFocus({ kind: "bounds", points: pts });
    },
    [bumpFocus, waypoints]
  );

  const fetchPointElevation = useCallback(
    async (which: "A" | "B", lat: number, lon: number) => {
      const setElev = which === "A" ? setElevationA_m : setElevationB_m;
      setElev(null);
      try {
        const zs = await lookupElevations([{ lat, lon }]);
        const z = zs[0];
        setElev(z != null && Number.isFinite(z) ? z : null);
      } catch {
        setElev(null);
      }
    },
    []
  );

  const applyBaseCycle = useCallback(
    (baseIn: SavedCycle, intent: "study" | "base" = "base") => {
      const base = slimCycleForStudioTransfer(baseIn);
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
        base.corridor && base.corridor.S.length > 1 ? base.corridor : null;
      const origin = hasGeo ? geo[0] : null;
      const destination = hasGeo ? geo[geo.length - 1] : null;
      const routeParts = (base.meta?.routeLabel || "")
        .split("→")
        .map((s) => s.trim())
        .filter(Boolean);
      const meta = base.meta;
      const openAsStudy = intent === "study" && hasProfile;

      const studyTitle =
        (typeof meta?.saveTitle === "string" && meta.saveTitle.trim()) ||
        (base.name?.trim() && !looksLikeGpsLabel(base.name)
          ? base.name.trim()
          : null) ||
        null;
      // Persist human study name; never replace later with GPS labels.
      setSavedCycleTitle(studyTitle);

      // Always surface identity + KPIs (works without GPS).
      setDepartureLabel(
        routeParts[0] ||
          (origin
            ? `${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}`
            : base.name || DEFAULT_DEPARTURE_LABEL)
      );
      setDestinationLabel(
        routeParts[1] ||
          (destination
            ? `${destination.lat.toFixed(5)}, ${destination.lon.toFixed(5)}`
            : hasGeo
              ? DEFAULT_DESTINATION_LABEL
              : "Profil sans GPS")
      );
      setPointA(origin);
      setPointB(destination);
      setDistanceM(base.stats.distance_m);
      setDurationS(base.stats.duration_s);

      // Restore studio params from saved meta (before envelope key effects).
      if (meta?.driverProfile) {
        const dp = meta.driverProfile as DriverProfile;
        if (
          dp === "Eco" ||
          dp === "Normal" ||
          dp === "Agressif" ||
          dp === "Sportif"
        ) {
          setDriverProfile(dp);
          if (!meta.physics) setPhysics(presetFor(dp).physics);
        }
      }
      if (meta?.physics) setPhysics(meta.physics);
      if (typeof meta?.driverId === "string" && meta.driverId) {
        setDriverId(meta.driverId);
      } else if (meta?.driverProfile || meta?.physics) {
        setDriverId(null);
      }
      if (typeof meta?.aY === "number" && Number.isFinite(meta.aY)) {
        setAY(meta.aY);
      }
      if (meta?.routingProfile) {
        setRoutingProfile(meta.routingProfile as RoutingProfile);
      }
      if (typeof meta?.departAt === "string" && meta.departAt) {
        setDepartAt(meta.departAt);
      }
      if (meta?.maxSpeedKmh !== undefined) {
        setMaxSpeedKmh(meta.maxSpeedKmh);
      }
      if (typeof meta?.vehicleId === "string" && meta.vehicleId) {
        setVehicleId(meta.vehicleId);
      }
      if (
        meta?.preferredEngine === "idm" ||
        meta?.preferredEngine === "sumo"
      ) {
        setPreferredEngine(meta.preferredEngine);
      }
      if (meta?.envelopeMask) {
        setEnvelopeMask({
          legal: !!meta.envelopeMask.legal,
          traffic: !!meta.envelopeMask.traffic,
          curve: !!meta.envelopeMask.curve,
        });
      }
      if (meta?.slopeAlgo) {
        setSlopeAlgo(normalizeSlopeAlgo(meta.slopeAlgo));
      }
      if (meta?.legalFilter) {
        setLegalFilter(normalizeLegalFilter(meta.legalFilter));
      }
      if (typeof meta?.includeTrafficLights === "boolean") {
        setIncludeTrafficLights(meta.includeTrafficLights);
      }
      if (typeof meta?.driverZonesEnabled === "boolean") {
        setDriverZonesEnabled(meta.driverZonesEnabled);
      }
      if (Array.isArray(meta?.driverZones) && meta.driverZones.length) {
        setDriverZones(meta.driverZones);
      }
      if (Array.isArray(meta?.waypoints)) {
        setWaypoints(meta.waypoints);
      }

      if (hasGeo) {
        setGeometry(geo);
        setReferenceGeometry(geo);
        bumpFocus({ kind: "bounds", points: geo });
        setNoGpsBase(false);
        setCorridor(savedCorridor);
        if (savedCorridor?.traffic_source) {
          setTrafficSource(savedCorridor.traffic_source);
        }
        if (typeof meta?.elevationA_m === "number") {
          setElevationA_m(meta.elevationA_m);
        } else {
          void fetchPointElevation("A", geo[0].lat, geo[0].lon);
        }
        if (typeof meta?.elevationB_m === "number") {
          setElevationB_m(meta.elevationB_m);
        } else {
          void fetchPointElevation(
            "B",
            geo[geo.length - 1].lat,
            geo[geo.length - 1].lon
          );
        }
        if (savedCorridor && savedCorridor.S.length > 1) {
          lastBuiltAYRef.current =
            typeof meta?.aY === "number" ? meta.aY : lastBuiltAYRef.current;
          if (meta?.slopeAlgo) {
            lastSlopeAlgoKeyRef.current = slopeAlgoKey(
              normalizeSlopeAlgo(meta.slopeAlgo)
            );
          }
        }
      } else {
        setGeometry([]);
        setReferenceGeometry([]);
        setPointA(null);
        setPointB(null);
        setElevationA_m(
          typeof meta?.elevationA_m === "number" ? meta.elevationA_m : null
        );
        setElevationB_m(
          typeof meta?.elevationB_m === "number" ? meta.elevationB_m : null
        );
        setCorridor(null);
        setRouteResult(null);
        setNoGpsBase(true);
      }

      if (meta?.trafficSource) {
        setTrafficSource(meta.trafficSource);
      } else if (!hasGeo) {
        setTrafficSource("profil_import");
      }

      const buildProfile = (): ConsolidatedProfile | null => {
        if (!hasProfile) return null;
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
                    s[i - 1] +
                      0.5 * (base.velocity[i] + base.velocity[i - 1]) * dt
                  );
                }
                return s;
              })();
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
          traffic_source:
            meta?.trafficSource ?? (hasGeo ? null : "profil_import"),
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
      };

      if (openAsStudy) {
        // Full study restore: profile is the result, jump to analysis.
        setReferenceCycle(null);
        setShowBaseOverlay(false);
        const p = buildProfile();
        if (p) setProfile(p);
        setWarnings(
          hasGeo
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
        );
        setStage("completed");
        setActiveStep(4);
        setMaxUnlocked(4);
        syncAppliedKeyRef.current = true;
      } else if (hasProfile) {
        // Use as base: keep series for overlay; ready to re-simulate.
        setReferenceCycle({
          name: base.name,
          time: base.time.slice(),
          velocity: base.velocity.slice(),
        });
        setShowBaseOverlay(false);
        const p = buildProfile();
        if (p) setProfile(p);
        setWarnings(
          hasGeo
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
        );
        // Prefer corridor/constraints if available, else analysis of the base profile.
        if (savedCorridor && savedCorridor.S.length > 1) {
          setStage("corridor");
          setActiveStep(2);
          setMaxUnlocked(3);
        } else if (hasGeo) {
          setStage("route");
          setActiveStep(1);
          setMaxUnlocked(1);
        } else {
          setStage("completed");
          setActiveStep(4);
          setMaxUnlocked(4);
        }
        syncAppliedKeyRef.current = true;
      } else if (hasGeo) {
        setReferenceCycle(null);
        setShowBaseOverlay(false);
        setProfile(null);
        setStage(savedCorridor ? "corridor" : "route");
        setActiveStep(savedCorridor ? 2 : 1);
        setMaxUnlocked(savedCorridor ? 2 : 1);
      }

      // Persist immediately so Strict Mode remount boots on the right step
      // (debounced session effect is cancelled on unmount).
      seedStudioSessionFromCycle(base, intent);
    },
    [bumpFocus, fetchPointElevation]
  );

  useEffect(() => {
    const stashed = peekStashedBaseCycle();
    if (!stashed) return;
    applyBaseCycle(stashed.cycle, stashed.intent);
    // Keep stash briefly so Strict Mode remount can re-apply.
    const t = window.setTimeout(() => clearStashedBaseCycle(), 1500);
    return () => window.clearTimeout(t);
  }, [applyBaseCycle]);

  /** If session/stash lost the heavy profile, reload from corpus API. */
  useEffect(() => {
    if (!openEnergy) return;
    if (profile && profile.time.length > 1) return;
    let cancelled = false;
    (async () => {
      const stashed = peekStashedBaseCycle();
      if (stashed?.cycle.time && stashed.cycle.time.length > 1) {
        if (!cancelled) applyBaseCycle(stashed.cycle, stashed.intent);
        return;
      }
      const pending = peekPendingCorpusOpen();
      if (!pending?.corpusId) return;
      try {
        const series = await getBenchmarkSource(pending.corpusId);
        if (cancelled) return;
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
        const vehicleId =
          pending.vehicleId ||
          (pending.corpusId.includes("epsim") ||
          pending.corpusId.includes("xspace")
            ? "renault-xspace-apr2bis"
            : undefined);
        const cycle = packCycle({
          name: pending.name,
          source: "corpus",
          origin: "corpus",
          corpusId: pending.corpusId,
          stats,
          time: series.time,
          velocity: series.velocity,
          acceleration: enriched.acceleration,
          slope: enriched.slope,
          a_lat: enriched.a_lat,
          position: enriched.position,
          geometry: enriched.geometry,
          meta: vehicleId ? { vehicleId } : undefined,
        });
        applyBaseCycle(cycle, pending.intent);
        takePendingCorpusOpen();
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : "Impossible de recharger le profil corpus"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openEnergy, profile, applyBaseCycle]);

  /** Persist wizard artifacts so Versus ↔ Studio does not wipe the run. */
  useEffect(() => {
    const snap: StudioSessionSnapshot = {
      v: 1,
      savedAt: new Date().toISOString(),
      activeStep,
      maxUnlocked,
      preferredEngine,
      stage:
        stage === "simulating"
          ? profile && profile.time.length > 1
            ? "completed"
            : corridor
              ? "corridor"
              : "route"
          : stage,
      departureLabel,
      destinationLabel,
      pointA,
      pointB,
      geometry,
      distanceM,
      durationS,
      routeResult,
      corridor,
      routingProfile,
      departAt,
      aY,
      trafficSource,
      warnings,
      driverProfile,
      physics,
      driverId,
      driverZonesEnabled,
      driverZones,
      maxSpeedKmh,
      vehicleId,
      slopeUnit,
      waypoints,
      profile,
      appliedParamsKey,
      envelopeMask,
      enableMarkov,
      includeTrafficLights,
      slopeAlgo,
      legalFilter,
      showRouteArrows,
      mapSpeedLayers,
      referenceGeometry,
      syncChartMap,
      elevationA_m,
      elevationB_m,
      referenceCycle,
      showBaseOverlay,
      noGpsBase,
      savedCycleTitle,
    };
    sessionSnapRef.current = snap;
    if (!sessionReadyRef.current) {
      sessionReadyRef.current = true;
      return;
    }
    const t = window.setTimeout(() => {
      saveStudioSession(snap);
    }, 350);
    return () => window.clearTimeout(t);
  }, [
    activeStep,
    maxUnlocked,
    preferredEngine,
    stage,
    departureLabel,
    destinationLabel,
    pointA,
    pointB,
    geometry,
    distanceM,
    durationS,
    routeResult,
    corridor,
    routingProfile,
    departAt,
    aY,
    trafficSource,
    warnings,
    driverProfile,
    physics,
    driverId,
    driverZonesEnabled,
    driverZones,
    maxSpeedKmh,
    vehicleId,
    slopeUnit,
    waypoints,
    profile,
    appliedParamsKey,
    envelopeMask,
    enableMarkov,
    includeTrafficLights,
    slopeAlgo,
    legalFilter,
    showRouteArrows,
    mapSpeedLayers,
    referenceGeometry,
    syncChartMap,
    elevationA_m,
    elevationB_m,
    referenceCycle,
    showBaseOverlay,
    noGpsBase,
    savedCycleTitle,
  ]);

  useEffect(() => {
    const flush = () => {
      if (sessionSnapRef.current) saveStudioSession(sessionSnapRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const sAxis = useMemo(() => {
    if (corridor?.S?.length) return corridor.S;
    if (geometry.length < 2) return [] as number[];
    // Approximate cumulative from route geometry when corridor not ready
    const S = [0];
    for (let i = 1; i < geometry.length; i++) {
      const a = geometry[i - 1];
      const b = geometry[i];
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLon = ((b.lon - a.lon) * Math.PI) / 180;
      const lat1 = (a.lat * Math.PI) / 180;
      const lat2 = (b.lat * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      S.push(S[i - 1] + 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
    }
    return S;
  }, [corridor, geometry]);

  const rangeGeometry = useMemo(() => {
    if (!brushRange || geometry.length < 2 || sAxis.length < 2) return [];
    return geometrySliceByS(sAxis, geometry, brushRange.s0, brushRange.s1);
  }, [brushRange, geometry, sAxis]);

  const syncCursor = useMemo(() => {
    if (!syncChartMap || chartCursorS == null) return null;
    return interpolateAlongS(corridor, chartCursorS, geometry);
  }, [syncChartMap, chartCursorS, corridor, geometry]);

  const lastLoupeSRef = useRef(0);

  const handleBrushRangeS = useCallback(
    (range: { s0: number; s1: number } | null) => {
      setBrushRange(range);
      focusNonceRef.current += 1;
      if (range) {
        setMapFocus(
          nextFocus(
            { kind: "range", s0: range.s0, s1: range.s1 },
            focusNonceRef.current
          )
        );
      } else {
        setMapFocus(nextFocus({ kind: "route" }, focusNonceRef.current));
      }
    },
    []
  );

  const resetSimState = useCallback(() => {
    setSimStarting(false);
    setSimStopping(false);
    setSimError(null);
    setSimulationId(null);
    simulationIdRef.current = null;
    setSimEngine(null);
    setWsUrl(null);
    setWsEnabled(false);
    setWsStatus("idle");
    setWsMessage(null);
    setSeries([]);
    setDensity(0);
    setSimT(0);
    setSimS(0);
    setEgoPosition(null);
    setOtherVehicles([]);
  }, []);

  const resetRouteArtifacts = useCallback(() => {
    setGeometry([]);
    setDistanceM(null);
    setDurationS(null);
    setRouteResult(null);
    setCorridor(null);
    setCorridorError(null);
    setTrafficSource(null);
    setWarnings([]);
    setProfile(null);
    setChartCursorS(null);
    setBrushRange(null);
    setMapFocus(null);
    setReferenceGeometry([]);
    lastBuiltAYRef.current = null;
    lastSlopeAlgoKeyRef.current = slopeAlgoKey(DEFAULT_SLOPE_ALGO);
    lastLegalFilterKeyRef.current = legalFilterKey(DEFAULT_LEGAL_FILTER);
    setAppliedParamsKey(null);
    lastRouteKeyRef.current = null;
    lastEnvelopeKeyRef.current = null;
    feuxBackupRef.current = null;
    resetSimState();
    setMaxUnlocked(1);
    setActiveStep(1);
  }, [resetSimState]);

  const runBuildCorridor = useCallback(
    async (
      route: RouteAnalyzeResponse,
      opts?: {
        includeTls?: boolean;
        slopeAlgo?: SlopeAlgoOptions;
        legalFilter?: LegalFilterOptions;
      }
    ): Promise<SpatialCorridor | null> => {
      const includeTls = opts?.includeTls ?? includeTrafficLights;
      const slopeOpts = opts?.slopeAlgo ?? slopeAlgo;
      const legalOpts = opts?.legalFilter ?? legalFilter;
      const algo = resolveSlopeAlgo(slopeOpts);
      const legal = resolveLegalFilter(legalOpts);
      // Mark keys early so debounce effects don't double-fire during the request.
      lastSlopeAlgoKeyRef.current = slopeAlgoKey(slopeOpts);
      lastLegalFilterKeyRef.current = legalFilterKey(legalOpts);
      setBuildingCorridor(true);
      setCorridorError(null);
      try {
        const result = await buildCorridor(route, {
          aY,
          smoothWindow: algo.smoothWindow,
          sgMinSpanM: algo.sgMinSpanM,
          maxGrade: algo.maxGrade,
          alphaMinPct: algo.alphaMinPct,
          alphaMaxPct: algo.alphaMaxPct,
          trapLengthM: algo.trapLengthM,
          legalSmoothMode: legal.mode,
          legalSmoothWindowM: legal.windowM,
          legalMinRunM: legal.minRunM,
          enableSpeedLimits: respectLegalLimits && envelopeMask.legal,
          globalMaxSpeedKmh: maxSpeedKmh ?? 130,
          includeTrafficInEnvelope: envelopeMask.traffic,
          speedSources,
          elevationSources,
          elevationCombine,
          speedMinKmh,
          speedMaxKmh,
        });
        const masked = applyEnvelopeMask(result.corridor, envelopeMask, {
          globalMaxKmh: maxSpeedKmh,
          aY,
          speedMinKmh,
          speedMaxKmh,
        });
        const snap = snapshotFeux(masked);
        if (snap) feuxBackupRef.current = snap;
        const next = includeTls ? masked : withUpdatedFeux(masked, []);
        setCorridor(next);
        lastBuiltAYRef.current = aY;
        lastSlopeAlgoKeyRef.current = slopeAlgoKey(slopeOpts);
        lastLegalFilterKeyRef.current = legalFilterKey(legalOpts);
        const src =
          result.corridor.traffic_source ??
          result.traffic_source ??
          route.traffic_source ??
          null;
        setTrafficSource(src);
        const w =
          result.corridor.warnings ??
          result.warnings ??
          route.warnings ??
          [];
        setWarnings(w);
        lastEnvelopeKeyRef.current = envelopeKey;

        // Persist full route+corridor in IndexedDB (local-first).
        const origin = route.origin ?? route.geometry[0];
        const dest =
          route.destination ?? route.geometry[route.geometry.length - 1];
        if (origin && dest && next.S.length > 1) {
          const key = makeCorridorCacheKey({
            routingProfile:
              route.traffic_source?.startsWith("HERE")
                ? "HERE/ADAS"
                : routingProfile,
            latA: origin.lat,
            lonA: origin.lon,
            latB: dest.lat,
            lonB: dest.lon,
            vias: cacheKeyFromWaypoints(waypoints),
            aY,
            maxSpeedKmh,
            envelopeMask,
            slopeAlgoKey: slopeAlgoKey(slopeOpts),
            legalFilterKey: legalFilterKey(legalOpts),
            includeTrafficLights: includeTls,
          });
          void putCorridorProfile(
            buildExportBundle({
              route,
              corridor: next,
              cacheKey: key,
              label: `${departureLabel} → ${destinationLabel}`,
              meta: {
                routingProfile,
                departAt,
                aY,
                maxSpeedKmh,
                envelopeMask,
                slopeAlgo: slopeOpts,
                legalFilter: legalOpts,
                includeTrafficLights: includeTls,
                origin,
                destination: dest,
                originLabel: departureLabel,
                destinationLabel,
              },
            })
          );
        }

        return next;
      } catch (err) {
        setCorridor(null);
        setCorridorError(
          errMessage(err, "Erreur inattendue pendant la construction du cycle.")
        );
        return null;
      } finally {
        setBuildingCorridor(false);
      }
    },
    [
      aY,
      envelopeMask,
      envelopeKey,
      includeTrafficLights,
      slopeAlgo,
      legalFilter,
      maxSpeedKmh,
      routingProfile,
      waypoints,
      departAt,
      departureLabel,
      destinationLabel,
      respectLegalLimits,
      speedSources,
      elevationSources,
      elevationCombine,
      speedMinKmh,
      speedMaxKmh,
    ]
  );

  const handleIncludeTrafficLightsChange = useCallback(
    (include: boolean) => {
      setIncludeTrafficLights(include);
      if (!include) {
        setCorridor((prev) => {
          if (!prev) return prev;
          const snap = snapshotFeux(prev);
          if (snap) feuxBackupRef.current = snap;
          return withUpdatedFeux(prev, []);
        });
        return;
      }
      const backup = feuxBackupRef.current;
      if (backup?.S_feux.length) {
        setCorridor((prev) => (prev ? restoreFeux(prev, backup) : prev));
        return;
      }
      if (routeResult) {
        void runBuildCorridor(routeResult, { includeTls: true });
      }
    },
    [routeResult, runBuildCorridor]
  );

  /* Rebuild V_curve when a_y changes, only if a corridor already exists. */
  useEffect(() => {
    if (!routeResult) return;
    if (!corridor || corridor.S.length <= 1) return;
    if (stage === "simulating" || generatingCycle) return;
    if (stage === "completed" && profile) return;
    if (appliedParamsKey != null) return;
    if (lastBuiltAYRef.current === aY) return;
    const t = window.setTimeout(() => {
      void runBuildCorridor(routeResult);
    }, CONSTRAINTS_REBUILD_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [
    aY,
    routeResult,
    corridor,
    stage,
    profile,
    generatingCycle,
    appliedParamsKey,
    runBuildCorridor,
  ]);

  /* Rebuild α(z) when slope algorithm options change. */
  useEffect(() => {
    if (!routeResult) return;
    if (!corridor || corridor.S.length <= 1) return;
    if (stage === "simulating" || generatingCycle) return;
    // After a finished sim, still rebuild when editing Contraintes (step 2).
    if (stage === "completed" && profile && activeStep !== 2) return;
    const key = slopeAlgoKey(slopeAlgo);
    if (lastSlopeAlgoKeyRef.current === key) return;
    const t = window.setTimeout(() => {
      void runBuildCorridor(routeResult);
    }, CONSTRAINTS_REBUILD_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [
    slopeAlgo,
    routeResult,
    corridor,
    stage,
    profile,
    generatingCycle,
    activeStep,
    runBuildCorridor,
  ]);

  /* Rebuild V_legal when filter params change. */
  useEffect(() => {
    if (!routeResult) return;
    if (!corridor || corridor.S.length <= 1) return;
    if (stage === "simulating" || generatingCycle) return;
    if (stage === "completed" && profile && activeStep !== 2) return;
    const key = legalFilterKey(legalFilter);
    if (lastLegalFilterKeyRef.current === key) return;
    const t = window.setTimeout(() => {
      void runBuildCorridor(routeResult);
    }, CONSTRAINTS_REBUILD_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [
    legalFilter,
    routeResult,
    corridor,
    stage,
    profile,
    generatingCycle,
    activeStep,
    runBuildCorridor,
  ]);

  const handleSlopeAlgoChange = useCallback(
    (next: SlopeAlgoOptions) => {
      const normalized = normalizeSlopeAlgo(next);
      lastSlopeAlgoKeyRef.current = slopeAlgoKey(normalized);
      setSlopeAlgo(normalized);
      if (!routeResult) return;
      if (!corridor || corridor.S.length <= 1) return;
      if (stage === "simulating" || generatingCycle) return;
      void runBuildCorridor(routeResult, { slopeAlgo: normalized });
    },
    [routeResult, corridor, stage, generatingCycle, runBuildCorridor]
  );

  const handleLegalFilterChange = useCallback(
    (next: LegalFilterOptions) => {
      const normalized = normalizeLegalFilter(next);
      lastLegalFilterKeyRef.current = legalFilterKey(normalized);
      setLegalFilter(normalized);
      if (!routeResult) return;
      if (!corridor || corridor.S.length <= 1) return;
      if (stage === "simulating" || generatingCycle) return;
      void runBuildCorridor(routeResult, { legalFilter: normalized });
    },
    [routeResult, corridor, stage, generatingCycle, runBuildCorridor]
  );

  const handleEnvelopeMaskChange = useCallback(
    (mask: EnvelopeMask) => {
      setEnvelopeMask(mask);
      setCorridor((prev) =>
        prev
          ? applyEnvelopeMask(prev, mask, {
              globalMaxKmh: maxSpeedKmh,
              aY,
            })
          : prev
      );
    },
    [aY, maxSpeedKmh]
  );

  const handleMaxSpeedKmhChange = useCallback(
    (value: number | null) => {
      setMaxSpeedKmh(value);
      setCorridor((prev) =>
        prev
          ? applyEnvelopeMask(prev, envelopeMask, {
              globalMaxKmh: value,
              aY,
            })
          : prev
      );
    },
    [aY, envelopeMask]
  );

  const handleAYChange = useCallback(
    (value: number) => {
      setAY(value);
      setCorridor((prev) =>
        prev
          ? applyEnvelopeMask(prev, envelopeMask, {
              globalMaxKmh: maxSpeedKmh,
              aY: value,
              speedMinKmh,
              speedMaxKmh,
            })
          : prev
      );
    },
    [envelopeMask, maxSpeedKmh, speedMinKmh, speedMaxKmh]
  );

  // Debounced spatial-filter rebuild (300 ms) — called by the workspace when
  // an option that requires a server rebuild changes (legal_smooth_mode,
  // trap_length, alpha_min/max, elevation_combine, speed_min/max, sources).
  const rebuildDebounceRef = useRef<number | null>(null);
  const requestConstraintRebuild = useCallback(() => {
    if (!routeResult) return;
    if (rebuildDebounceRef.current != null) {
      window.clearTimeout(rebuildDebounceRef.current);
    }
    rebuildDebounceRef.current = window.setTimeout(() => {
      rebuildDebounceRef.current = null;
      void runBuildCorridor(routeResult);
    }, 300);
  }, [routeResult, runBuildCorridor]);
  useEffect(() => {
    return () => {
      if (rebuildDebounceRef.current != null) {
        window.clearTimeout(rebuildDebounceRef.current);
      }
    };
  }, []);

  const handleApplyHomologationPreset = useCallback(() => {
    setRoutingProfile("HERE/ADAS");
    setRoutingProfiles(["HERE/ADAS"]);
    setMaxSpeedKmh(130);
    setEnableMarkov(false);
    setAY(3.5);
    const mask: EnvelopeMask = { legal: true, traffic: false, curve: true };
    setEnvelopeMask(mask);
    setCorridor((prev) =>
      prev
        ? applyEnvelopeMask(prev, mask, {
            globalMaxKmh: 130,
            aY: 3.5,
          })
        : prev
    );
  }, []);

  const buildCurrentCacheKey = useCallback(
    (coords: {
      latA: number;
      lonA: number;
      latB: number;
      lonB: number;
      vias?: Array<{ lat: number; lon: number }>;
    }) =>
      makeCorridorCacheKey({
        routingProfile,
        latA: coords.latA,
        lonA: coords.lonA,
        latB: coords.latB,
        lonB: coords.lonB,
        vias: coords.vias,
        aY,
        maxSpeedKmh,
        envelopeMask,
        slopeAlgoKey: slopeAlgoKey(slopeAlgo),
        legalFilterKey: legalFilterKey(legalFilter),
        includeTrafficLights,
      }),
    [
      routingProfile,
      aY,
      maxSpeedKmh,
      envelopeMask,
      slopeAlgo,
      legalFilter,
      includeTrafficLights,
    ]
  );

  const applyCorridorBundle = useCallback(
    (bundle: CorridorProfileBundle, opts?: { soft?: boolean }) => {
      const route = bundle.route;
      const mask = bundle.meta.envelopeMask ?? envelopeMask;
      const vmax = bundle.meta.maxSpeedKmh ?? maxSpeedKmh;
      const masked = applyEnvelopeMask(bundle.corridor, mask, {
        globalMaxKmh: vmax,
      });
      const snap = snapshotFeux(masked);
      if (snap) feuxBackupRef.current = snap;
      const next = includeTrafficLights
        ? masked
        : withUpdatedFeux(masked, []);

      if (bundle.meta.routingProfile) {
        setRoutingProfile(bundle.meta.routingProfile as RoutingProfile);
      }
      if (bundle.meta.envelopeMask) setEnvelopeMask(bundle.meta.envelopeMask);
      if (bundle.meta.maxSpeedKmh != null) {
        setMaxSpeedKmh(bundle.meta.maxSpeedKmh);
      }
      if (bundle.meta.aY != null) setAY(bundle.meta.aY);
      if (bundle.meta.slopeAlgo) {
        setSlopeAlgo(normalizeSlopeAlgo(bundle.meta.slopeAlgo));
      }
      if (bundle.meta.legalFilter) {
        setLegalFilter(normalizeLegalFilter(bundle.meta.legalFilter));
      }

      setRouteResult(route);
      setCorridor(next);
      setGeometry(route.geometry);
      setDistanceM(route.distance_m);
      setDurationS(route.duration_s);
      setTrafficSource(
        next.traffic_source ?? route.traffic_source ?? "imported"
      );
      setWarnings(next.warnings ?? route.warnings ?? []);
      setProfile(null);
      setCorridorError(null);
      setError(null);

      const origin = route.origin ?? bundle.meta.origin ?? route.geometry[0];
      const dest =
        route.destination ??
        bundle.meta.destination ??
        route.geometry[route.geometry.length - 1];
      if (origin) {
        setPointA(origin);
        setDepartureLabel(
          route.origin_label ||
            bundle.meta.originLabel ||
            formatGpsLabel(origin)
        );
      }
      if (dest) {
        setPointB(dest);
        setDestinationLabel(
          route.destination_label ||
            bundle.meta.destinationLabel ||
            formatGpsLabel(dest)
        );
      }
      if (route.elevations_m?.length) {
        const z0 = route.elevations_m[0];
        const z1 = route.elevations_m[route.elevations_m.length - 1];
        if (z0 != null && Number.isFinite(z0)) setElevationA_m(z0);
        if (z1 != null && Number.isFinite(z1)) setElevationB_m(z1);
      }

      lastBuiltAYRef.current = bundle.meta.aY ?? aY;
      lastEnvelopeKeyRef.current = envelopeKey;
      lastRouteKeyRef.current = routeFingerprint({
        departAt,
        routingProfile: bundle.meta.routingProfile || routingProfile,
        pointA: origin ?? null,
        pointB: dest ?? null,
        waypoints,
      });
      if (!opts?.soft) {
        setMaxUnlocked((u) => (u < 3 ? 3 : u));
        setActiveStep(3);
      } else {
        setMaxUnlocked((u) => (u < 2 ? 2 : u));
      }
      setStage("corridor");
      focusNonceRef.current += 1;
      setMapFocus(nextFocus({ kind: "route" }, focusNonceRef.current));
      return route;
    },
    [
      envelopeMask,
      maxSpeedKmh,
      includeTrafficLights,
      aY,
      envelopeKey,
      departAt,
      routingProfile,
      waypoints,
    ]
  );

  const handleExportCorridorProfile = useCallback(() => {
    if (!routeResult || !corridor) {
      setError("Aucun corridor à exporter — analysez un trajet d’abord.");
      return;
    }
    const origin = routeResult.origin ?? pointA;
    const dest = routeResult.destination ?? pointB;
    if (!origin || !dest) {
      setError("Origine / destination manquantes pour l’export.");
      return;
    }
    const key = buildCurrentCacheKey({
      latA: origin.lat,
      lonA: origin.lon,
      latB: dest.lat,
      lonB: dest.lon,
      vias: cacheKeyFromWaypoints(waypoints),
    });
    const bundle = buildExportBundle({
      route: routeResult,
      corridor,
      cacheKey: key,
      label: `${departureLabel} → ${destinationLabel}`,
      meta: {
        routingProfile,
        departAt,
        aY,
        maxSpeedKmh,
        envelopeMask,
        slopeAlgo,
        legalFilter,
        includeTrafficLights,
        origin,
        destination: dest,
        originLabel: departureLabel,
        destinationLabel,
      },
    });
    void putCorridorProfile(bundle);
    downloadCorridorProfileJson(
      bundle,
      `cyclegen_corridor_${departureLabel.slice(0, 24).replace(/\W+/g, "_")}.json`
    );
  }, [
    routeResult,
    corridor,
    pointA,
    pointB,
    waypoints,
    buildCurrentCacheKey,
    departureLabel,
    destinationLabel,
    routingProfile,
    departAt,
    aY,
    maxSpeedKmh,
    envelopeMask,
    slopeAlgo,
    legalFilter,
    includeTrafficLights,
  ]);

  const handleImportCorridorProfile = useCallback(
    async (file: File) => {
      setCorridorProfileBusy(true);
      setError(null);
      try {
        const bundle = await readCorridorProfileFile(file);
        applyCorridorBundle(bundle);
        await putCorridorProfile(bundle);
        setStudioToasts((prev) => [
          ...prev.slice(-4),
          {
            id: `import-${Date.now()}`,
            message: `Profil importé (${bundle.corridor.S.length} pts) — prêt pour l’IDM.`,
          },
        ]);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Échec import JSON du profil routier."
        );
      } finally {
        setCorridorProfileBusy(false);
      }
    },
    [applyCorridorBundle]
  );

  const handleMapClick = useCallback(
    (lat: number, lon: number) => {
      if (stage === "simulating") return;
      if (clickMode === "navigate") return;

      setError(null);
      const label = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

      if (clickMode === "waypoints") {
        setWaypoints((prev) => {
          if (prev.length >= MAX_WAYPOINTS) return prev;
          return [
            ...prev,
            newWaypointDraft({
              lat,
              lon,
              address: label,
              label: `Stop ${prev.length + 1}`,
              stop_duration_s: 60,
            }),
          ];
        });
        resetRouteArtifacts();
        focusEnteredPoints(pointA, pointB, [
          ...waypoints,
          { lat, lon, id: "tmp", address: label, label: "", stop_duration_s: 0 },
        ]);
        return;
      }

      if (clickMode === "setA") {
        setPointA({ lat, lon });
        setDepartureLabel(label);
        void fetchPointElevation("A", lat, lon);
        resetRouteArtifacts();
        setStage("route");
        setClickMode("navigate");
        focusEnteredPoints({ lat, lon }, pointB);
        return;
      }

      if (clickMode === "setB") {
        setPointB({ lat, lon });
        setDestinationLabel(label);
        void fetchPointElevation("B", lat, lon);
        resetRouteArtifacts();
        setStage("route");
        setClickMode("navigate");
        focusEnteredPoints(pointA, { lat, lon });
      }
    },
    [
      resetRouteArtifacts,
      stage,
      clickMode,
      focusEnteredPoints,
      fetchPointElevation,
      pointA,
      pointB,
      waypoints,
    ]
  );

  const handleGeocodeA = useCallback(async () => {
    if (!departureLabel.trim()) return;
    setGeocodingEndpoint("A");
    setError(null);
    try {
      const gps = parseGpsCoords(departureLabel);
      if (gps) {
        setPointA(gps);
        setDepartureLabel(formatGpsLabel(gps));
        void fetchPointElevation("A", gps.lat, gps.lon);
        resetRouteArtifacts();
        focusEnteredPoints(gps, pointB);
        return;
      }
      const hit = await geocodeAddress(departureLabel.trim(), {
        nearLat: pointB?.lat,
        nearLon: pointB?.lon,
      });
      setPointA({ lat: hit.lat, lon: hit.lon });
      setDepartureLabel(hit.display_name);
      if (hit.elevation_m != null && Number.isFinite(hit.elevation_m)) {
        setElevationA_m(hit.elevation_m);
      } else {
        void fetchPointElevation("A", hit.lat, hit.lon);
      }
      resetRouteArtifacts();
      focusEnteredPoints({ lat: hit.lat, lon: hit.lon }, pointB);
    } catch (err) {
      setError(
        errMessage(
          err,
          "Impossible de localiser le départ — adresse ou GPS du type 48.822, 1.617."
        )
      );
    } finally {
      setGeocodingEndpoint(null);
    }
  }, [
    departureLabel,
    pointB,
    resetRouteArtifacts,
    focusEnteredPoints,
    fetchPointElevation,
  ]);

  const handleGeocodeB = useCallback(async () => {
    if (!destinationLabel.trim()) return;
    setGeocodingEndpoint("B");
    setError(null);
    try {
      const gps = parseGpsCoords(destinationLabel);
      if (gps) {
        setPointB(gps);
        setDestinationLabel(formatGpsLabel(gps));
        void fetchPointElevation("B", gps.lat, gps.lon);
        resetRouteArtifacts();
        focusEnteredPoints(pointA, gps);
        return;
      }
      const hit = await geocodeAddress(destinationLabel.trim(), {
        nearLat: pointA?.lat,
        nearLon: pointA?.lon,
      });
      setPointB({ lat: hit.lat, lon: hit.lon });
      setDestinationLabel(hit.display_name);
      if (hit.elevation_m != null && Number.isFinite(hit.elevation_m)) {
        setElevationB_m(hit.elevation_m);
      } else {
        void fetchPointElevation("B", hit.lat, hit.lon);
      }
      resetRouteArtifacts();
      focusEnteredPoints(pointA, { lat: hit.lat, lon: hit.lon });
    } catch (err) {
      setError(
        errMessage(
          err,
          "Impossible de localiser l’arrivée — adresse ou GPS du type 48.791, 1.602."
        )
      );
    } finally {
      setGeocodingEndpoint(null);
    }
  }, [
    destinationLabel,
    pointA,
    resetRouteArtifacts,
    focusEnteredPoints,
    fetchPointElevation,
  ]);

  const handleGeocodeWaypoint = useCallback(
    async (id: string) => {
      const wp = waypoints.find((w) => w.id === id);
      if (!wp?.address.trim()) return;
      setGeocodingWaypointId(id);
      setError(null);
      try {
        const gps = parseGpsCoords(wp.address);
        if (gps) {
          const nextVias = waypoints.map((w) =>
            w.id === id
              ? {
                  ...w,
                  lat: gps.lat,
                  lon: gps.lon,
                  address: formatGpsLabel(gps),
                  label: w.label || `Stop`,
                }
              : w
          );
          setWaypoints(nextVias);
          resetRouteArtifacts();
          focusEnteredPoints(pointA, pointB, nextVias);
          return;
        }
        const hit = await geocodeAddress(wp.address.trim(), {
          nearLat: pointA?.lat ?? pointB?.lat,
          nearLon: pointA?.lon ?? pointB?.lon,
        });
        const nextVias = waypoints.map((w) =>
          w.id === id
            ? {
                ...w,
                lat: hit.lat,
                lon: hit.lon,
                address: hit.display_name,
                label: w.label || hit.display_name.split(",")[0] || w.label,
              }
            : w
        );
        setWaypoints(nextVias);
        resetRouteArtifacts();
        focusEnteredPoints(pointA, pointB, nextVias);
      } catch (err) {
        setError(
          errMessage(
            err,
            "Impossible de localiser l’arrêt — adresse ou GPS lat, lon."
          )
        );
      } finally {
        setGeocodingWaypointId(null);
      }
    },
    [waypoints, pointA, pointB, resetRouteArtifacts, focusEnteredPoints]
  );

  const handleAnalyze = useCallback(async (opts?: {
    soft?: boolean;
  }): Promise<RouteAnalyzeResponse | null> => {
    const noGpsHint =
      noGpsBase ||
      destinationLabel.trim() === "Profil sans GPS" ||
      trafficSource === "profil_import" ||
      (!pointA &&
        !pointB &&
        geometry.length < 2 &&
        !!profile &&
        profile.time.length > 1);

    if (noGpsHint) {
      setNoGpsBase(true);
      setActiveStep(4);
      setMaxUnlocked(4);
      setStage("completed");
      setError(
        "Ce cycle n’a pas de GPS — pas d’itinéraire à calculer. Analyse vitesse / pente / couple à l’étape Résultats."
      );
      return null;
    }

    const gpsA = pointA ?? parseGpsCoords(departureLabel);
    const gpsB = pointB ?? parseGpsCoords(destinationLabel);
    const hasA = gpsA != null || departureLabel.trim().length > 1;
    const hasB = gpsB != null || destinationLabel.trim().length > 1;
    if (!hasA || !hasB) return null;

    // Refuse geocoding placeholder labels from energy imports.
    const badLabel = (s: string) => {
      const t = s.trim().toLowerCase();
      return (
        t === "profil sans gps" ||
        t === "arrivée" ||
        t.startsWith("profil sans")
      );
    };
    if (!gpsA && badLabel(departureLabel)) {
      setError("Adresse de départ invalide (profil sans GPS).");
      return null;
    }
    if (!gpsB && badLabel(destinationLabel)) {
      setNoGpsBase(true);
      setActiveStep(4);
      setMaxUnlocked(4);
      setError(
        "Pas de coordonnées GPS sur ce cycle — ouvrez-le via « Étude énergie » depuis la bibliothèque."
      );
      return null;
    }

    const resolvedWaypoints = waypoints.map((w) => {
      if (w.lat != null && w.lon != null) return w;
      const gps = parseGpsCoords(w.address);
      if (!gps) return w;
      return {
        ...w,
        lat: gps.lat,
        lon: gps.lon,
        address: formatGpsLabel(gps),
      };
    });

    for (const wp of resolvedWaypoints) {
      if (wp.lat == null || wp.lon == null) {
        if (!wp.address.trim()) {
          setError(
            `L’arrêt « ${wp.label || "sans nom"} » nécessite un clic carte, une adresse ou des GPS.`
          );
          return null;
        }
      }
    }

    if (gpsA && !pointA) {
      setPointA(gpsA);
      setDepartureLabel(formatGpsLabel(gpsA));
      void fetchPointElevation("A", gpsA.lat, gpsA.lon);
    }
    if (gpsB && !pointB) {
      setPointB(gpsB);
      setDestinationLabel(formatGpsLabel(gpsB));
      void fetchPointElevation("B", gpsB.lat, gpsB.lon);
    }
    if (resolvedWaypoints.some((w, i) => w.lat !== waypoints[i]?.lat)) {
      setWaypoints(resolvedWaypoints);
    }

    setAnalyzing(true);
    setError(null);
    resetSimState();
    try {
      // Local-first cache: identical geometry + envelope options → skip network.
      if (gpsA && gpsB) {
        const vias = resolvedWaypoints
          .filter((w) => w.lat != null && w.lon != null)
          .map((w) => ({ lat: w.lat as number, lon: w.lon as number }));
        const cacheKey = buildCurrentCacheKey({
          latA: gpsA.lat,
          lonA: gpsA.lon,
          latB: gpsB.lat,
          lonB: gpsB.lon,
          vias,
        });
        const hit = await getCorridorProfile(cacheKey);
        if (hit?.corridor?.S?.length && hit?.route?.geometry?.length) {
          applyCorridorBundle(hit, { soft: opts?.soft });
          setStudioToasts((prev) => [
            ...prev.slice(-4),
            {
              id: `cache-${Date.now()}`,
              message: "Corridor rechargé depuis le cache local (IndexedDB).",
            },
          ]);
          return hit.route;
        }
      }

      const result = await analyzeRoute({
        latA: gpsA?.lat ?? null,
        lonA: gpsA?.lon ?? null,
        latB: gpsB?.lat ?? null,
        lonB: gpsB?.lon ?? null,
        addressA: gpsA ? null : departureLabel.trim() || null,
        addressB: gpsB ? null : destinationLabel.trim() || null,
        waypoints: resolvedWaypoints.map((w) => ({
          lat: w.lat,
          lon: w.lon,
          address: w.lat == null ? w.address : null,
          label: w.label || null,
          stop_duration_s: w.stop_duration_s,
        })),
        routingProfile,
        routingProfiles:
          routingProfiles.length > 0 ? routingProfiles : [routingProfile],
        departAt: datetimeLocalToIso(departAt),
        aY,
      });
      // Clear previous profile only after a successful new route.
      setProfile(null);
      if (result.origin) {
        setPointA(result.origin);
        if (result.origin_label) setDepartureLabel(result.origin_label);
      }
      if (result.destination) {
        setPointB(result.destination);
        if (result.destination_label)
          setDestinationLabel(result.destination_label);
      }
      if (result.via_points?.length) {
        setWaypoints(
          result.via_points.map((v) =>
            newWaypointDraft({
              lat: v.lat,
              lon: v.lon,
              address: v.label,
              label: v.label,
              stop_duration_s: v.stop_duration_s,
            })
          )
        );
      }
      setRouteResult(result);
      setGeometry(result.geometry);
      setDistanceM(result.distance_m);
      setDurationS(result.duration_s);
      // Prefer DEM samples from the analyzed polyline ends when available.
      if (result.elevations_m?.length) {
        const z0 = result.elevations_m[0];
        const z1 = result.elevations_m[result.elevations_m.length - 1];
        if (z0 != null && Number.isFinite(z0)) setElevationA_m(z0);
        if (z1 != null && Number.isFinite(z1)) setElevationB_m(z1);
      }
      setCorridor(null);
      setProfile(null);
      lastBuiltAYRef.current = null;
      lastEnvelopeKeyRef.current = null;
      if (!opts?.soft) {
        setMaxUnlocked(2);
      } else {
        setMaxUnlocked((u) => (u < 2 ? 2 : u));
      }
      if (result.traffic_source) setTrafficSource(result.traffic_source);
      if (result.warnings?.length) setWarnings(result.warnings);
      else setWarnings([]);
      setBrushRange(null);
      setChartCursorS(null);
      setStage("corridor");
      focusNonceRef.current += 1;
      setMapFocus(nextFocus({ kind: "route" }, focusNonceRef.current));
      lastRouteKeyRef.current = routeFingerprint({
        departAt,
        routingProfile,
        pointA: result.origin ?? gpsA ?? pointA,
        pointB: result.destination ?? gpsB ?? pointB,
        waypoints: result.via_points?.length
          ? result.via_points.map((v) =>
              newWaypointDraft({
                lat: v.lat,
                lon: v.lon,
                address: v.label,
                label: v.label,
                stop_duration_s: v.stop_duration_s,
              })
            )
          : resolvedWaypoints,
      });
      return result;
    } catch (err) {
      setError(errMessage(err, "Erreur inattendue pendant l’analyse d’itinéraire."));
      return null;
    } finally {
      setAnalyzing(false);
    }
  }, [
    pointA,
    pointB,
    departureLabel,
    destinationLabel,
    waypoints,
    routingProfile,
    routingProfiles,
    departAt,
    aY,
    resetSimState,
    fetchPointElevation,
    noGpsBase,
    trafficSource,
    geometry.length,
    profile,
    buildCurrentCacheKey,
    applyCorridorBundle,
  ]);

  const handleGenerateStaticAnalysis = useCallback(async () => {
    if (!routeResult) return;
    setStage("corridor");
    const c = await runBuildCorridor(routeResult);
    if (c && c.S.length > 1) {
      setMaxUnlocked((u) => (u < 3 ? 3 : u));
      setActiveStep(3);
    }
  }, [routeResult, runBuildCorridor]);

  const consolidateSimulation = useCallback(async () => {
    const id = simulationIdRef.current;
    if (!id || consolidatingRef.current) return;
    consolidatingRef.current = true;
    setWsEnabled(false);
    setSimStopping(true);
    try {
      const res = await stopSimulation(id);
      setProfile(res.profile);
      setStage("completed");
      setShowBaseOverlay(true);
      setWsMessage(null);
      setGeneratingCycle(false);
      if (res.profile && res.profile.time.length > 1) {
        setMaxUnlocked(4);
        setActiveStep(4);
      }
    } catch (err) {
      setSimError(errMessage(err, "Impossible de consolider le profil."));
      setWsEnabled(true);
      setGeneratingCycle(false);
    } finally {
      setSimStopping(false);
      consolidatingRef.current = false;
    }
  }, []);

  const handleGenerateCycle = useCallback(async () => {
    if (noGpsBase || geometry.length < 2) {
      setSimError(
        "Profil sans GPS : pas de génération trajet/cycle. Changez de véhicule à droite pour recalculer couple et puissance aux roues."
      );
      setActiveStep(4);
      setGeneratingCycle(false);
      return;
    }
    setGeneratingCycle(true);
    setError(null);
    setSimError(null);
    const paramsSnapshot = cycleParamsKey;

    // Stop any running sim so params can relaunch cleanly
    const runningId = simulationIdRef.current;
    if (runningId) {
      setWsEnabled(false);
      try {
        await stopSimulation(runningId);
      } catch {
        /* ignore — we'll start a new one */
      }
      simulationIdRef.current = null;
      setSimulationId(null);
    }

    try {
      let route = routeResult;
      const routeChanged = lastRouteKeyRef.current !== routeKey;
      if (!route || routeChanged) {
        route = await handleAnalyze({ soft: true });
        if (!route) {
          setGeneratingCycle(false);
          return;
        }
        // lastRouteKeyRef already set inside handleAnalyze from resolved coords
      }

      const envelopeChanged = lastEnvelopeKeyRef.current !== envelopeKey;
      // Prefer live corridor; rebuild if missing or inputs changed
      let corr = corridor;
      if (!corr || envelopeChanged || routeChanged) {
        corr = await runBuildCorridor(route);
        lastEnvelopeKeyRef.current = envelopeKey;
      }
      if (!corr) {
        setGeneratingCycle(false);
        return;
      }

      setMaxUnlocked(4);
      setActiveStep(4);
      resetSimState();
      setProfile(null);
      setSimStarting(true);
      setStage("simulating");

      const res = await startSimulation(corr, {
        driverProfile,
        engine: preferredEngine,
        maxSpeedKmh,
        enableMarkov,
        driverParams: {
          a_max: physics.a_max,
          b_comf: physics.b_comf,
          speed_factor: physics.speed_factor,
          T: physics.T,
          T_h: physics.T_h,
          s0: physics.s0,
          jerk_max: physics.jerk_max,
          jerk_brake_max: physics.jerk_brake_max,
        },
        driverZones: driverZonesEnabled
          ? driverZones.map((z) => ({
              id: z.id,
              label: z.label,
              s0_m: z.s0_m,
              s1_m: z.s1_m,
              a_max: z.physics.a_max,
              b_comf: z.physics.b_comf,
              speed_factor: z.physics.speed_factor,
              a_y_mps2: z.a_y ?? null,
            }))
          : null,
      });
      simulationIdRef.current = res.simulation_id;
      setSimulationId(res.simulation_id);
      setSimEngine(res.engine);
      setAppliedParamsKey(paramsSnapshot);

      // IDM is fully solved inside /start. Do not wait for a slow WS replay
      // (0.05s/frame used to stall ~300s of cycle time before consolidate).
      if (res.status === "completed" || res.engine === "idm") {
        setWsEnabled(false);
        setWsUrl(null);
        setSimStarting(false);
        await consolidateSimulation();
        return;
      }

      setWsUrl(simulationWsUrl(res.ws_path));
      setWsEnabled(true);
    } catch (err) {
      setSimError(errMessage(err, "Impossible de générer le cycle."));
      setWsEnabled(false);
      setGeneratingCycle(false);
      setStage(routeResult ? "corridor" : "route");
      setActiveStep(3);
    } finally {
      setSimStarting(false);
    }
  }, [
    cycleParamsKey,
    routeKey,
    envelopeKey,
    routeResult,
    corridor,
    handleAnalyze,
    runBuildCorridor,
    resetSimState,
    driverProfile,
    physics,
    maxSpeedKmh,
    enableMarkov,
    driverZonesEnabled,
    driverZones,
    preferredEngine,
    noGpsBase,
    geometry.length,
    consolidateSimulation,
  ]);

  const applyFrame = useCallback(
    (frame: SimulationFrame) => {
      setSimT(frame.t);
      setSimS(frame.s);
      setDensity(frame.density);
      setSeries((prev) => {
        const next = [
          ...prev,
          {
            t: frame.t,
            v: frame.v,
            a: frame.a,
            alpha: frame.alpha,
            s: frame.s,
          },
        ];
        return next.length > MAX_SERIES ? next.slice(-MAX_SERIES) : next;
      });

      const vehicles = frame.vehicles ?? [];
      const ego = vehicles.find((v) => v.is_ego);
      const others = vehicles.filter((v) => !v.is_ego);

      if (ego) {
        setEgoPosition({ lat: ego.lat, lon: ego.lon });
      } else {
        const projected = interpolateAlongS(corridor, frame.s, geometry);
        if (projected) setEgoPosition(projected);
      }
      setOtherVehicles(others);
    },
    [corridor, geometry]
  );

  const handleWsStatus = useCallback(
    (status: SimSocketStatus, detail?: string) => {
      setWsStatus(status);
      if (detail) setWsMessage(detail);
      else if (status === "open") setWsMessage(null);
    },
    []
  );

  useSimulationSocket({
    url: wsUrl,
    enabled: wsEnabled && stage === "simulating",
    onFrame: applyFrame,
    onStatus: handleWsStatus,
    onEnd: () => {
      void consolidateSimulation();
    },
  });

  const handleStopSimulation = useCallback(() => {
    void consolidateSimulation();
  }, [consolidateSimulation]);

  const totalS = useMemo(() => {
    if (corridor?.S?.length) return corridor.S[corridor.S.length - 1] ?? 0;
    return distanceM ?? 0;
  }, [corridor, distanceM]);

  const liveFollow = stage === "simulating" && !!egoPosition;
  const isLiveRun = stage === "simulating" || simStarting;
  /** Completed profile without map geometry (regulatory / OEM speed traces). */
  const profileOnlyMode =
    noGpsBase ||
    (!!profile &&
      profile.time.length > 1 &&
      geometry.length < 2 &&
      (stage === "completed" || activeStep === 4));

  if (liveFollow) {
    lastLoupeSRef.current = simS;
  } else if (chartCursorS != null && Number.isFinite(chartCursorS)) {
    lastLoupeSRef.current = chartCursorS;
  }
  const loupeS = liveFollow ? simS : chartCursorS ?? lastLoupeSRef.current;
  const showRoadLoupe =
    !!corridor &&
    !!corridor.elevations_m?.length &&
    corridor.geometry.length >= 2 &&
    !profileOnlyMode;

  // Sans GPS : rester sur Résultats — pas de pipeline trajet / corridor / sim.
  useEffect(() => {
    const labeledNoGps =
      destinationLabel.trim() === "Profil sans GPS" ||
      trafficSource === "profil_import";
    const hasProfileOnly =
      !!profile &&
      profile.time.length > 1 &&
      geometry.length < 2 &&
      !pointA &&
      !pointB;
    const shouldLock =
      noGpsBase || openEnergy || labeledNoGps || hasProfileOnly;
    if (!shouldLock) return;
    if (!noGpsBase) setNoGpsBase(true);
    if (activeStep !== 4) setActiveStep(4);
    setMaxUnlocked((u) => (u < 4 ? 4 : u));
    setStage((s) => (s === "completed" ? s : "completed"));
    // Recover profile wiped by a failed "Calculer l’itinéraire".
    if ((!profile || profile.time.length < 2) && labeledNoGps) {
      const snap = loadStudioSession();
      if (snap?.profile && snap.profile.time.length > 1) {
        setProfile(snap.profile);
        if (snap.savedCycleTitle) setSavedCycleTitle(snap.savedCycleTitle);
      }
    }
  }, [
    noGpsBase,
    activeStep,
    openEnergy,
    destinationLabel,
    trafficSource,
    profile,
    geometry.length,
    pointA,
    pointB,
  ]);

  /** Map narrows to a rail so a right panel can host analysis charts. */
  const mapRightLayout =
    isLiveRun ||
    activeStep === 4 ||
    noGpsBase ||
    (activeStep === 2 && !!corridor);
  /** Sidebar hidden only when the whole left column is a rail (live/results/no-gps). */
  const hideSidebar = isLiveRun || activeStep === 4 || noGpsBase;

  const mapRightPrev = useRef(false);
  useEffect(() => {
    const entered = mapRightLayout && !mapRightPrev.current;
    mapRightPrev.current = mapRightLayout;
    if (!entered || geometry.length < 2) return;
    const t = window.setTimeout(() => bumpFocus({ kind: "route" }), 280);
    return () => window.clearTimeout(t);
  }, [mapRightLayout, geometry, bumpFocus]);
  const selectedVehicle = useMemo(
    () => (vehicleId ? getVehicle(vehicleId) : null),
    [vehicleId]
  );
  const selectedDriver = useMemo(
    () => (driverId ? getDriver(driverId) : null),
    [driverId]
  );
  const driverDisplayName =
    selectedDriver != null
      ? driverLabel(selectedDriver)
      : driverId
        ? driverId
        : null;
  const routeLabel = useMemo(
    () =>
      [departureLabel, destinationLabel].filter(Boolean).join(" → ") ||
      "Cycle actuel",
    [departureLabel, destinationLabel]
  );

  const defaultGpsTitle = useMemo(
    () =>
      resolveCycleSaveName({
        title: "",
        originLat: pointA?.lat ?? corridor?.geometry?.[0]?.lat ?? null,
        originLon: pointA?.lon ?? corridor?.geometry?.[0]?.lon ?? null,
        destLat:
          pointB?.lat ??
          (corridor?.geometry && corridor.geometry.length >= 2
            ? corridor.geometry[corridor.geometry.length - 1].lat
            : null),
        destLon:
          pointB?.lon ??
          (corridor?.geometry && corridor.geometry.length >= 2
            ? corridor.geometry[corridor.geometry.length - 1].lon
            : null),
        routeLabel,
      }),
    [pointA, pointB, corridor, routeLabel]
  );

  /**
   * Study name is sticky once human. GPS is only a fallback seed.
   * If we only had GPS and place labels appear later, upgrade once.
   * Never downgrade a human name to GPS when labels change after analyze.
   */
  useEffect(() => {
    const current = savedCycleTitle?.trim() || "";
    const dep = departureLabel.trim();
    const dest = destinationLabel.trim();
    const labelsReady =
      dep.length > 1 &&
      dest.length > 1 &&
      dep !== DEFAULT_DEPARTURE_LABEL &&
      dest !== DEFAULT_DESTINATION_LABEL;
    const humanRoute =
      labelsReady && !looksLikeGpsLabel(`${dep} → ${dest}`)
        ? `${dep} → ${dest}`
        : "";

    if (humanRoute) {
      if (!current || looksLikeGpsLabel(current)) {
        setSavedCycleTitle(humanRoute);
      }
      return;
    }

    if (current) return;
    if (!(pointA && pointB)) return;

    const seeded = resolveCycleSaveName({
      title: "",
      originLat: pointA.lat,
      originLon: pointA.lon,
      destLat: pointB.lat,
      destLon: pointB.lon,
      routeLabel,
    });
    if (seeded.trim()) setSavedCycleTitle(seeded.trim());
  }, [
    savedCycleTitle,
    departureLabel,
    destinationLabel,
    pointA,
    pointB,
    routeLabel,
  ]);

  /** Prefer persisted study name; GPS only as display fallback. */
  const headerCycleTitle = savedCycleTitle?.trim() || defaultGpsTitle;

  /** Sticky name for Excel / bibliothèque — never the live GPS fallback. */
  const persistentStudyName = savedCycleTitle?.trim() || null;

  const handleCycleSaved = useCallback((name: string) => {
    const n = name.trim();
    if (n) setSavedCycleTitle(n);
  }, []);

  const handleWizardCta = useCallback(() => {
    if (noGpsBase && activeStep !== 4) {
      setActiveStep(4);
      return;
    }
    if (activeStep === 1) {
      void handleAnalyze().then((r) => {
        if (r && r.geometry.length >= 2) {
          setMaxUnlocked((u) => (u < 2 ? 2 : u));
          setActiveStep(2);
        }
      });
      return;
    }
    if (activeStep === 2) {
      void handleGenerateStaticAnalysis();
      return;
    }
    if (activeStep === 3) {
      void handleGenerateCycle();
      return;
    }
    if (!profile || profile.time.length < 2) return;
    const route = [departureLabel, destinationLabel]
      .filter(Boolean)
      .join(" → ");
    // Flush session before leaving so Studio remount restores the run.
    saveStudioSession({
      v: 1,
      savedAt: new Date().toISOString(),
      activeStep: 4,
      maxUnlocked: Math.max(maxUnlocked, 4) as StudioWizardStep,
      preferredEngine,
      stage: "completed",
      departureLabel,
      destinationLabel,
      pointA,
      pointB,
      geometry,
      distanceM,
      durationS,
      routeResult,
      corridor,
      routingProfile,
      departAt,
      aY,
      trafficSource,
      warnings,
      driverProfile,
      physics,
      driverId,
      driverZonesEnabled,
      driverZones,
      maxSpeedKmh,
      vehicleId,
      slopeUnit,
      waypoints,
      profile,
      appliedParamsKey,
      envelopeMask,
      showRouteArrows,
      mapSpeedLayers,
      referenceGeometry,
      syncChartMap,
      savedCycleTitle: persistentStudyName,
    });
    stashCyclesForCompare([
      packCycle({
        name:
          persistentStudyName ||
          defaultCycleName(route || "Cycle actuel"),
        source: "CycleGen · actuel",
        origin: "cyclegen",
        time: profile.time,
        velocity: profile.velocity,
        acceleration: profile.acceleration ?? [],
        slope: profile.slope ?? [],
        position: profile.position ?? [],
        a_lat: lateralAccelFromCorridor(profile, corridor, aY),
        geometry,
        resultAvailable: true,
        corridor,
        z_min_m: elevationExtremesM(corridor?.elevations_m).z_min_m,
        z_max_m: elevationExtremesM(corridor?.elevations_m).z_max_m,
        meta: {
          driverProfile,
          trafficSource: trafficSource ?? undefined,
          routeLabel: route || undefined,
          saveTitle: persistentStudyName || undefined,
          routingProfile,
          departAt,
          aY,
          physics,
          maxSpeedKmh,
          vehicleId,
          preferredEngine,
          envelopeMask,
          slopeAlgo,
          legalFilter,
          includeTrafficLights,
          driverZonesEnabled,
          driverZones,
          waypoints,
          elevationA_m,
          elevationB_m,
        },
      }),
    ]);
    router.push("/compare");
  }, [
    activeStep,
    noGpsBase,
    handleAnalyze,
    handleGenerateStaticAnalysis,
    handleGenerateCycle,
    profile,
    departureLabel,
    destinationLabel,
    geometry,
    corridor,
    aY,
    router,
    maxUnlocked,
    preferredEngine,
    pointA,
    pointB,
    distanceM,
    durationS,
    routeResult,
    routingProfile,
    departAt,
    trafficSource,
    warnings,
    driverProfile,
    physics,
    driverZonesEnabled,
    driverZones,
    maxSpeedKmh,
    vehicleId,
    slopeUnit,
    waypoints,
    appliedParamsKey,
    envelopeMask,
    slopeAlgo,
    includeTrafficLights,
    elevationA_m,
    elevationB_m,
    showRouteArrows,
    mapSpeedLayers,
    referenceGeometry,
    syncChartMap,
    persistentStudyName,
  ]);

  const handleLeaveToMenu = useCallback(() => {
    clearStudioSession();
    setLeaveOpen(false);
    router.push("/");
  }, [router]);

  const requestLeaveToMenu = useCallback(() => {
    // Empty session: no confirm / save prompt.
    if (
      !profile?.time?.length &&
      !corridor &&
      geometry.length < 2 &&
      !pointA &&
      !pointB
    ) {
      handleLeaveToMenu();
      return;
    }
    setLeaveOpen(true);
  }, [profile, corridor, geometry.length, pointA, pointB, handleLeaveToMenu]);

  useEffect(() => {
    setHeaderChrome({
      kind: "studio",
      activeStep,
      maxUnlocked,
      lockToStep: noGpsBase ? 4 : undefined,
      cycleTitle: headerCycleTitle,
      onStepChange: (step) => {
        if (noGpsBase && step !== 4) return;
        setActiveStep(step);
      },
      onLeaveToMenu: requestLeaveToMenu,
    });
    return () => setHeaderChrome(null);
  }, [
    setHeaderChrome,
    activeStep,
    maxUnlocked,
    noGpsBase,
    headerCycleTitle,
    requestLeaveToMenu,
  ]);

  const stageHint = (() => {
    if (clickMode === "setA") return "Cliquez la carte pour poser le départ (A)";
    if (clickMode === "setB") return "Cliquez la carte pour poser l’arrivée (B)";
    if (clickMode === "waypoints") {
      if (waypoints.length >= MAX_WAYPOINTS)
        return "Maximum 20 arrêts — retirez-en un pour en ajouter";
      return "Cliquez la carte pour ajouter des arrêts";
    }
    if (buildingCorridor) return "Construction du cycle…";
    if (generatingCycle) return "Génération du cycle…";
    if (stage === "simulating") {
      if (simStarting) return "Démarrage de la simulation…";
      if (simError) return simError;
      return `Simulation live (${(simEngine ?? preferredEngine).toUpperCase()})`;
    }
    if (stage === "completed") return "Résultats — colonne droite";
    if (activeStep === 1) return "Départ, arrivée, puis calculer l’itinéraire";
    if (activeStep === 2) return "Pente, feux, enveloppes — construire le cycle";
    if (activeStep === 3) return "Véhicule + IDM/SUMO, puis générez le cycle";
    return "Carte + analyse à droite";
  })();

  const canAnalyze =
    !noGpsBase &&
    destinationLabel.trim() !== "Profil sans GPS" &&
    trafficSource !== "profil_import" &&
    !!departAt &&
    (pointA != null || departureLabel.trim().length > 1) &&
    (pointB != null || destinationLabel.trim().length > 1);

  // Raise unlock when artifacts appear (never lower except analyze/reset handlers).
  useEffect(() => {
    if (profile && profile.time.length > 1) {
      setMaxUnlocked((u) => (u < 4 ? 4 : u));
      return;
    }
    if (corridor && corridor.S.length > 1) {
      setMaxUnlocked((u) => (u < 3 ? 3 : u));
      return;
    }
    if (geometry.length >= 2) {
      setMaxUnlocked((u) => (u < 2 ? 2 : u));
    }
  }, [profile, corridor, geometry.length]);

  return (
    <ChartFocusHostProvider>
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-slate-50 text-slate-900">
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {!hideSidebar && (
      <Sidebar
        activeStep={activeStep}
        departureLabel={departureLabel}
        destinationLabel={destinationLabel}
        onDepartureLabelChange={setDepartureLabel}
        onDestinationLabelChange={setDestinationLabel}
        pointASet={!!pointA}
        pointBSet={!!pointB}
        originLat={pointA?.lat ?? null}
        originLon={pointA?.lon ?? null}
        destLat={pointB?.lat ?? null}
        destLon={pointB?.lon ?? null}
        elevationA_m={elevationA_m}
        elevationB_m={elevationB_m}
        onGeocodeA={() => void handleGeocodeA()}
        onGeocodeB={() => void handleGeocodeB()}
        geocodingEndpoint={geocodingEndpoint}
        waypoints={waypoints}
        onWaypointsChange={(next) => {
          const same =
            waypointRouteFingerprint(next) ===
            waypointRouteFingerprint(waypoints);
          setWaypoints(next);
          if (!same) resetRouteArtifacts();
        }}
        clickMode={clickMode}
        onClickModeChange={setClickMode}
        onGeocodeWaypoint={(id) => void handleGeocodeWaypoint(id)}
        geocodingWaypointId={geocodingWaypointId}
        routingProfile={routingProfile}
        onRoutingProfileChange={(v) =>
          setRoutingProfile(v as RoutingProfile)
        }
        routingProfiles={routingProfiles}
        onRoutingProfilesChange={(next) => {
          setRoutingProfiles(next);
          if (next.length > 0) setRoutingProfile(next[0]);
        }}
        routerStatus={routeResult?.router_status ?? undefined}
        departAt={departAt}
        onDepartAtChange={setDepartAt}
        aY={aY}
        onAYChange={handleAYChange}
        trafficSource={trafficSource}
        warnings={warnings}
        driverProfile={driverProfile}
        onDriverProfileChange={setDriverProfile}
        physics={physics}
        onPhysicsChange={setPhysics}
        driverId={driverId}
        onDriverIdChange={setDriverId}
        driverName={driverDisplayName}
        maxSpeedKmh={maxSpeedKmh}
        onMaxSpeedKmhChange={handleMaxSpeedKmhChange}
        envelopeMask={envelopeMask}
        onEnvelopeMaskChange={handleEnvelopeMaskChange}
        onCursorS={setChartCursorS}
        onBrushRangeS={setBrushRange}
        enableMarkov={enableMarkov}
        onEnableMarkovChange={setEnableMarkov}
        onApplyHomologationPreset={handleApplyHomologationPreset}
        onExportCorridorProfile={handleExportCorridorProfile}
        onImportCorridorProfile={(f) => void handleImportCorridorProfile(f)}
        corridorProfileBusy={corridorProfileBusy}
        includeTrafficLights={includeTrafficLights}
        onIncludeTrafficLightsChange={handleIncludeTrafficLightsChange}
        slopeAlgo={slopeAlgo}
        onSlopeAlgoChange={handleSlopeAlgoChange}
        legalFilter={legalFilter}
        onLegalFilterChange={handleLegalFilterChange}
        routeElevationsM={routeResult?.elevations_m ?? null}
        analyzing={analyzing}
        canAnalyze={canAnalyze}
        generatingCycle={generatingCycle}
        distanceLabel={
          distanceM != null ? formatDistance(distanceM) : "—"
        }
        durationLabel={
          durationS != null ? formatDuration(durationS) : "—"
        }
        canBuildCorridor={!!routeResult}
        buildingCorridor={buildingCorridor}
        paramsDisabled={generatingCycle}
        paramsDirty={paramsDirty}
        paramsDirtyLines={paramsDirtyLines}
        driverZonesEnabled={driverZonesEnabled}
        onDriverZonesEnabledChange={setDriverZonesEnabled}
        driverZones={driverZones}
        onDriverZonesChange={setDriverZones}
        vehicleId={vehicleId}
        onVehicleSelect={(v) => {
          setVehicleId(v.id);
          if (v.v_max_kmh != null) setMaxSpeedKmh(v.v_max_kmh);
        }}
        corridor={corridor}
        onCorridorChange={setCorridor}
        slopeUnit={slopeUnit}
        onSlopeUnitChange={setSlopeUnit}
        profile={profile}
        preferredEngine={preferredEngine}
        onPreferredEngineChange={setPreferredEngine}
        onCta={handleWizardCta}
        onCycleSaved={handleCycleSaved}
        studyName={persistentStudyName}
      />
      )}

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
        <div
          className={
            mapRightLayout
              ? "relative flex h-full w-80 shrink-0 flex-col border-r border-slate-200"
              : "relative flex min-h-0 min-w-0 flex-1 flex-col"
          }
        >
        <div
          className={
            profileOnlyMode
              ? "pointer-events-none relative min-h-0 flex-1 opacity-30 grayscale contrast-75"
              : "relative min-h-0 flex-1"
          }
          aria-hidden={profileOnlyMode || undefined}
        >
        <DynamicMap
          pointA={pointA}
          pointB={pointB}
          geometry={geometry}
          corridor={corridor}
          alpha={corridor?.alpha ?? null}
          trafficSource={trafficSource}
          warnings={warnings}
          waypoints={waypoints}
          onMapClick={profileOnlyMode ? () => undefined : handleMapClick}
          layoutKey={`${activeStep}-${mapRightLayout ? "right" : "idle"}-${showRoadLoupe ? "loupe" : "noloupe"}`}
          egoPosition={
            stage === "simulating" || stage === "completed"
              ? egoPosition
              : null
          }
          otherVehicles={stage === "simulating" ? otherVehicles : []}
          syncCursor={liveFollow ? egoPosition : syncCursor}
          syncPan={liveFollow ? true : syncChartMap}
          rangeGeometry={rangeGeometry}
          referenceGeometry={referenceGeometry}
          mapFocus={mapFocus}
          showArrows={showRouteArrows}
          speedLayers={mapSpeedLayers}
          onRouteCursorS={
            corridor && !profileOnlyMode ? setChartCursorS : undefined
          }
        />
        {!profileOnlyMode && (buildingCorridor || analyzing) ? (
          <BuildProgressGauge
            active
            phase={buildingCorridor ? "corridor" : "analyzing"}
            variant="overlay"
          />
        ) : null}
        </div>
        {showRoadLoupe && corridor && (
          <div className="shrink-0 border-t border-slate-200 bg-white p-1.5">
            <RoadLoupe3D corridor={corridor} s_m={loupeS} />
          </div>
        )}
        {profileOnlyMode && (
          <div className="pointer-events-none absolute inset-0 z-[1100] flex items-center justify-center bg-slate-900/35">
            <div className="relative mx-3 max-w-[15rem] rounded-lg border-2 border-slate-400 bg-white/95 px-3 py-3 text-center shadow-md">
              <div
                className="pointer-events-none absolute inset-x-3 top-1/2 h-0.5 -translate-y-1/2 rotate-[-16deg] bg-slate-500/70"
                aria-hidden
              />
              <p className="relative text-[11px] font-bold uppercase tracking-wide text-slate-800">
                Profil choisi
              </p>
              <p className="relative mt-1 text-[11px] font-semibold leading-snug text-slate-700">
                sans coordonnées GPS
              </p>
              <p className="relative mt-1.5 text-[10px] leading-snug text-slate-500">
                Carte grisée — analyse à droite (P / couple roue)
              </p>
            </div>
          </div>
        )}
        {!profileOnlyMode && (
        <MapCameraControls
          hasRoute={geometry.length >= 2}
          hasA={!!pointA}
          hasB={!!pointB}
          hasPoints={
            !!pointA ||
            !!pointB ||
            waypoints.some((w) => w.lat != null && w.lon != null)
          }
          hasReference={referenceGeometry.length >= 2}
          hasRange={rangeGeometry.length >= 2}
          syncEnabled={liveFollow ? true : syncChartMap}
          onSyncChange={setSyncChartMap}
          onFocus={(kind) => bumpFocus({ kind })}
          onFocusRange={() => {
            if (!brushRange) return;
            bumpFocus({
              kind: "range",
              s0: brushRange.s0,
              s1: brushRange.s1,
            });
          }}
          onClearRange={() => {
            setBrushRange(null);
            bumpFocus({ kind: "route" });
          }}
          showArrows={showRouteArrows}
          onShowArrowsChange={setShowRouteArrows}
          speedLayers={mapSpeedLayers}
          onSpeedLayersChange={setMapSpeedLayers}
          hasCorridorSpeeds={
            !!corridor?.V_limite?.length && corridor.V_limite.length > 1
          }
        />
        )}
        {(() => {
          const stageBadge = profileOnlyMode
            ? "profil"
            : stage === "route"
              ? "trajet"
              : stage === "simulating"
                ? "simulation"
                : stage === "completed"
                  ? "terminé"
                  : "cycle";
          const stageText = profileOnlyMode
            ? "Sans GPS — couple / puissance véhicule depuis le profil"
            : stageHint;
          const bannerKey = `${stageBadge}|${stageText}`;
          if (stageBannerDismissed === bannerKey) return null;
          return (
            <div className="pointer-events-auto absolute bottom-3 left-1/2 z-[1000] flex max-w-[90%] -translate-x-1/2 items-start gap-2 rounded-md bg-white/90 pl-1 pr-3 py-1.5 text-xs text-slate-600 shadow-sm ring-1 ring-slate-200">
              <button
                type="button"
                onClick={() => setStageBannerDismissed(bannerKey)}
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Fermer le message"
                title="Fermer"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  aria-hidden
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
              <div className="flex min-w-0 items-center gap-2 pt-0.5">
                <span className="rounded bg-brand/10 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-brand">
                  {stageBadge}
                </span>
                <span className="truncate">{stageText}</span>
              </div>
            </div>
          );
        })()}
        </div>

        {!isLiveRun && activeStep === 2 && corridor && routeResult && (
          <aside className="flex h-full min-w-0 flex-1 flex-col border-l border-slate-200 bg-white">
            <ConstraintWorkspace
              corridor={corridor}
              meta={{
                originLat: pointA?.lat ?? null,
                originLon: pointA?.lon ?? null,
                destLat: pointB?.lat ?? null,
                destLon: pointB?.lon ?? null,
                originLabel: departureLabel,
                destLabel: destinationLabel,
              }}
              envelopeMask={envelopeMask}
              onEnvelopeMaskChange={handleEnvelopeMaskChange}
              speedSources={speedSources}
              onSpeedSourcesChange={setSpeedSources}
              speedSourceRows={buildSpeedSourceRows({
                routersUsed: routeResult.routers_used,
                routerStatus: routeResult.router_status,
                speedsByRouter: routeResult.segment_speeds_by_router,
                osmSpeedLimitsCount:
                  routeResult.osm_speed_limits?.length ?? 0,
              })}
              legalSmoothMode={legalSmoothModeLocal}
              onLegalSmoothModeChange={(m) => {
                setLegalSmoothModeLocal(m);
                setLegalFilter((prev) => ({ ...prev, mode: m }));
              }}
              legalSmoothWindowM={legalSmoothWindowLocal}
              onLegalSmoothWindowChange={(w) => {
                setLegalSmoothWindowLocal(w);
                setLegalFilter((prev) => ({ ...prev, windowM: w }));
              }}
              respectLegalLimits={respectLegalLimits}
              onRespectLegalLimitsChange={setRespectLegalLimits}
              speedMinKmh={speedMinKmh}
              onSpeedMinKmhChange={setSpeedMinKmh}
              speedMaxKmh={speedMaxKmh}
              onSpeedMaxKmhChange={setSpeedMaxKmh}
              globalMaxKmh={maxSpeedKmh}
              trafficSource={trafficSource}
              routersUsed={routeResult.routers_used}
              elevationSources={elevationSources}
              onElevationSourcesChange={setElevationSources}
              elevationSourceRows={buildElevationSourceRows({
                elevationsBySource: routeResult.elevations_by_source,
                elevationSourceTag: routeResult.elevation_source,
              })}
              elevationCombine={elevationCombine}
              onElevationCombineChange={setElevationCombine}
              slopeSpatialWindowM={slopeSpatialWindowLocal}
              onSlopeSpatialWindowChange={(w) => {
                setSlopeSpatialWindowLocal(w);
                setSlopeAlgo((prev) => ({ ...prev, sgMinSpanM: w }));
              }}
              alphaMinPct={slopeAlgo.alphaMinPct ?? null}
              onAlphaMinPctChange={(v) =>
                setSlopeAlgo((prev) => ({ ...prev, alphaMinPct: v }))
              }
              alphaMaxPct={slopeAlgo.alphaMaxPct ?? null}
              onAlphaMaxPctChange={(v) =>
                setSlopeAlgo((prev) => ({ ...prev, alphaMaxPct: v }))
              }
              slopeUnit={slopeUnit}
              onSlopeUnitChange={setSlopeUnit}
              trapLengthM={trapLengthMLocal}
              onTrapLengthMChange={(v) => {
                setTrapLengthMLocal(v);
                setSlopeAlgo((prev) => ({ ...prev, trapLengthM: v }));
              }}
              onCursorS={setChartCursorS}
              onBrushRangeS={handleBrushRangeS}
              highlightS={chartCursorS ?? null}
              onRequestRebuild={requestConstraintRebuild}
            />
          </aside>
        )}

        {isLiveRun && (
          <LiveAnalysisPanel
            series={series}
            simT={simT}
            simS={simS}
            totalS={totalS}
            corridor={corridor}
            onCorridorChange={setCorridor}
            vehicle={selectedVehicle}
            aY={aY}
            engineLabel={simEngine ?? preferredEngine}
            starting={simStarting}
            stopping={simStopping}
            error={simError}
            onStop={handleStopSimulation}
            slopeUnit={slopeUnit}
            onSlopeUnitChange={setSlopeUnit}
          />
        )}

        {!isLiveRun &&
          activeStep === 4 &&
          profile &&
          profile.time.length > 1 && (
            <ResultsAnalysisPanel
              profile={profile}
              corridor={corridor}
              onCorridorChange={setCorridor}
              vehicle={selectedVehicle}
              aY={aY}
              slopeUnit={slopeUnit}
              onSlopeUnitChange={setSlopeUnit}
              syncEnabled={syncChartMap}
              onCursorS={setChartCursorS}
              onBrushRangeS={handleBrushRangeS}
              trafficSource={trafficSource}
              warnings={warnings}
              driverProfile={driverProfile}
              driverId={driverId}
              driverName={driverDisplayName}
              routeLabel={routeLabel}
              onVersus={handleWizardCta}
              physics={physics}
              engine={simEngine ?? preferredEngine}
              maxSpeedKmh={maxSpeedKmh}
              envelopeMask={envelopeMask}
              routingProfile={routingProfile}
              departAt={departAt}
              driverZonesEnabled={driverZonesEnabled}
              driverZonesCount={driverZones.length}
              driverZones={driverZones}
              distanceM={distanceM}
              durationS={durationS}
              noGps={profileOnlyMode}
              vehicleId={vehicleId}
              onVehicleSelect={(v) => {
                setVehicleId(v.id);
                if (v.v_max_kmh != null) setMaxSpeedKmh(v.v_max_kmh);
              }}
              slopeAlgo={slopeAlgo}
              includeTrafficLights={includeTrafficLights}
              waypoints={waypoints}
              elevationA_m={elevationA_m}
              elevationB_m={elevationB_m}
              originLat={pointA?.lat ?? null}
              originLon={pointA?.lon ?? null}
              destLat={pointB?.lat ?? null}
              destLon={pointB?.lon ?? null}
              studyName={persistentStudyName}
              onCycleSaved={handleCycleSaved}
              referenceCycle={
                showBaseOverlay && referenceCycle && !profileOnlyMode
                  ? referenceCycle
                  : null
              }
              onClearReference={() => {
                setReferenceCycle(null);
                setShowBaseOverlay(false);
              }}
            />
          )}

        {!isLiveRun &&
          activeStep === 4 &&
          (!profile || profile.time.length < 2) && (
            <aside className="flex h-full min-w-0 flex-1 flex-col items-center justify-center border-l border-slate-200 bg-white px-6 text-center">
              <p className="text-sm text-slate-500">
                {noGpsBase || openEnergy
                  ? "Chargement du profil… Si rien n’apparaît, rouvrez le cycle via Bibliothèque → Étude énergie."
                  : "Aucun profil encore — générez le cycle à l’étape Comportement."}
              </p>
              {!(noGpsBase || openEnergy) && (
              <button
                type="button"
                onClick={() => setActiveStep(3)}
                className="mt-3 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Retour à l’étape 3
              </button>
              )}
              {(noGpsBase || openEnergy) && (
              <button
                type="button"
                onClick={() => router.push("/?mode=library")}
                className="mt-3 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Retour à la bibliothèque
              </button>
              )}
            </aside>
          )}
      </main>

      <LeaveStudioDialog
        open={leaveOpen}
        onCancel={() => setLeaveOpen(false)}
        onLeave={handleLeaveToMenu}
        profile={profile}
        corridor={corridor}
        aY={aY}
        driverProfile={driverProfile}
        driverId={driverId}
        driverName={driverDisplayName}
        trafficSource={trafficSource}
        routeLabel={routeLabel}
        studyName={persistentStudyName}
        originLat={pointA?.lat ?? null}
        originLon={pointA?.lon ?? null}
        destLat={pointB?.lat ?? null}
        destLon={pointB?.lon ?? null}
        physics={physics}
        routingProfile={routingProfile}
        departAt={departAt}
        maxSpeedKmh={maxSpeedKmh}
        vehicleId={vehicleId}
        preferredEngine={preferredEngine}
        envelopeMask={envelopeMask}
        slopeAlgo={slopeAlgo}
        legalFilter={legalFilter}
        includeTrafficLights={includeTrafficLights}
        driverZonesEnabled={driverZonesEnabled}
        driverZones={driverZones}
        waypoints={waypoints}
        elevationA_m={elevationA_m}
        elevationB_m={elevationB_m}
        onSaved={handleCycleSaved}
      />

      <StudioAlerts
        toasts={
          paramsDirty && profile && profile.time.length > 1
            ? studioToasts
            : studioToasts.filter((t) => !t.id.startsWith("stale-"))
        }
        onDismissToast={(id) =>
          setStudioToasts((prev) => prev.filter((t) => t.id !== id))
        }
      />

      {(error || simError) && (
        <div
          role="alert"
          className="absolute bottom-6 left-1/2 z-[1100] flex max-w-md -translate-x-1/2 items-start gap-3 rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700 shadow-lg"
        >
          <span className="flex-1">{error || simError}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setSimError(null);
            }}
            className="shrink-0 font-medium text-red-500 hover:text-red-700"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>
      )}
      </div>
    </div>
    </ChartFocusHostProvider>
  );
}

