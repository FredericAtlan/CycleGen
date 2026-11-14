import type {
  BenchmarkAlign,
  BenchmarkRunRequest,
  BenchmarkRunResponse,
  BenchmarkSourceMeta,
  BenchmarkSourceSeries,
  ConsolidatedProfile,
  CorridorBuildRequest,
  CorridorBuildResponse,
  DriverProfile,
  ElevationSourceKey,
  ExportFormat,
  ExportRequest,
  RouteAnalyzeRequest,
  RouteAnalyzeResponse,
  RouterKey,
  RoutingProfile,
  ScenarioRunRequest,
  ScenarioRunResponse,
  SimEngine,
  SimulateStartRequest,
  SimulateStartResponse,
  SimulateStopResponse,
  SpatialCorridor,
  TlsOverride,
  WaypointSpec,
} from "./types";
import {
  beginApiRequest,
  endApiRequestError,
  endApiRequestOk,
} from "./apiActivity";
import { useDemoOsrmClient } from "./demoFlags";
import {
  demoAnalyzeRoute,
  demoBuildCorridor,
  demoGeocodeAddress,
} from "./demoOsrmClient";

const STATIC_EXPORT =
  process.env.NEXT_PUBLIC_STATIC_EXPORT === "1" ||
  process.env.CYCLEGEN_STATIC_EXPORT === "1";

const API_URL_ENV = (process.env.NEXT_PUBLIC_API_URL || "")
  .trim()
  .replace(/\/$/, "");

/**
 * Sur export Pages sans variable `NEXT_PUBLIC_API_URL`, ne jamais cibler
 * localhost (injoignable depuis github.io). Dev local garde le défaut :8000.
 */
const API_URL =
  API_URL_ENV || (STATIC_EXPORT ? "" : "http://localhost:8000");

const WS_URL_ENV = (process.env.NEXT_PUBLIC_WS_URL || "")
  .trim()
  .replace(/\/$/, "");

const WS_URL =
  WS_URL_ENV ||
  (API_URL_ENV
    ? API_URL_ENV.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:")
    : STATIC_EXPORT
      ? ""
      : "ws://localhost:8000");

/** Optional — must match backend CYCLEGEN_API_KEY when that env is set. */
const API_KEY = (process.env.NEXT_PUBLIC_API_KEY || "").trim();

const API_MISSING_MSG =
  "API non configurée sur cette démo GitHub Pages. Utilisez la bibliothèque alpine (traces hors ligne), ou déployez le backend et renseignez NEXT_PUBLIC_API_URL.";

/** True when the browser can call a configured FastAPI origin. */
export function isApiConfigured(): boolean {
  return Boolean(API_URL);
}

export function apiOriginLabel(): string {
  if (API_URL) return API_URL;
  if (useDemoOsrmClient()) return "démo OSRM (client)";
  return "— (démo hors ligne)";
}

export function wsOriginLabel(): string {
  return WS_URL || "—";
}

const _timeoutRaw = process.env.NEXT_PUBLIC_API_TIMEOUT_MS;
const _timeoutParsed = _timeoutRaw != null ? Number(_timeoutRaw) : NaN;
const API_TIMEOUT_MS =
  Number.isFinite(_timeoutParsed) && _timeoutParsed > 0
    ? _timeoutParsed
    : 120_000;

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  return headers;
}

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type AnalyzeRouteParams = {
  latA?: number | null;
  lonA?: number | null;
  latB?: number | null;
  lonB?: number | null;
  addressA?: string | null;
  addressB?: string | null;
  waypoints?: WaypointSpec[];
  /** DEPRECATED — use `routingProfiles`. Kept for backwards compat callers. */
  routingProfile?: RoutingProfile | null;
  /** Ordered list of routers to call in parallel (first = primary geometry). */
  routingProfiles?: RoutingProfile[];
  /** Departure timestamp as ISO 8601 string. */
  departAt: string;
  /** Comfort lateral acceleration (m/s²). */
  aY?: number;
};

export type GeocodeResult = {
  lat: number;
  lon: number;
  display_name: string;
  query: string;
  elevation_m?: number | null;
};

export type ElevationLookupResult = {
  elevations_m: Array<number | null>;
};

async function postJson<T>(path: string, body: unknown, failLabel: string): Promise<T> {
  const ctx = beginApiRequest("POST", path, body);
  if (!API_URL) {
    endApiRequestError(ctx, API_MISSING_MSG);
    throw new ApiError(API_MISSING_MSG);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    if (isAbortError(err)) {
      const detail = `Request timed out after ${API_TIMEOUT_MS / 1000}s`;
      endApiRequestError(ctx, detail);
      throw new ApiError(detail);
    }
    const detail = STATIC_EXPORT
      ? `API injoignable (${API_URL}) — vérifier le backend et CORS.`
      : "API injoignable — backend démarré sur le port 8000 ?";
    endApiRequestError(ctx, detail);
    throw new ApiError(detail);
  }

  if (!res.ok) {
    let detail = `${failLabel} (${res.status})`;
    try {
      const err = (await res.json()) as { detail?: string };
      if (err.detail) detail = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
    } catch {
      /* ignore parse errors */
    }
    endApiRequestError(ctx, detail, res.status);
    throw new ApiError(detail, res.status);
  }

  const data = (await res.json()) as T;
  endApiRequestOk(ctx, { status: res.status, data });
  return data;
}

/** Resolve a free-text address via Nominatim (POST /api/geocode) or Photon (démo Pages). */
export async function geocodeAddress(
  query: string,
  opts?: { nearLat?: number; nearLon?: number }
): Promise<GeocodeResult> {
  if (useDemoOsrmClient()) {
    return demoGeocodeAddress(query, opts);
  }
  const body: {
    query: string;
    near_lat?: number;
    near_lon?: number;
  } = { query };
  if (opts?.nearLat != null && opts?.nearLon != null) {
    body.near_lat = opts.nearLat;
    body.near_lon = opts.nearLon;
  }
  return postJson<GeocodeResult>("/api/geocode", body, "Geocoding failed");
}

/** DEM altitudes for lat/lon points (POST /api/elevation). */
export async function lookupElevations(
  points: Array<{ lat: number; lon: number }>
): Promise<Array<number | null>> {
  if (!points.length) return [];
  const res = await postJson<ElevationLookupResult>(
    "/api/elevation",
    { points },
    "Elevation lookup failed"
  );
  return res.elevations_m ?? points.map(() => null);
}

/**
 * Step 1 — POST /api/route/analyze
 * Maps camelCase client params to the FastAPI snake_case contract.
 */
export async function analyzeRoute(
  params: AnalyzeRouteParams
): Promise<RouteAnalyzeResponse> {
  if (useDemoOsrmClient()) {
    return demoAnalyzeRoute({
      latA: params.latA,
      lonA: params.lonA,
      latB: params.latB,
      lonB: params.lonB,
      addressA: params.addressA,
      addressB: params.addressB,
      waypoints: params.waypoints,
      departAt: params.departAt,
      aY: params.aY,
    });
  }
  const body: RouteAnalyzeRequest = {
    lat_a: params.latA ?? null,
    lon_a: params.lonA ?? null,
    lat_b: params.latB ?? null,
    lon_b: params.lonB ?? null,
    address_a: params.addressA ?? null,
    address_b: params.addressB ?? null,
    waypoints: params.waypoints ?? [],
    depart_at: params.departAt,
    a_y_mps2: params.aY,
  };
  if (params.routingProfiles && params.routingProfiles.length > 0) {
    body.routing_profiles = params.routingProfiles;
  } else if (params.routingProfile) {
    body.routing_profile = params.routingProfile;
  }

  return postJson<RouteAnalyzeResponse>(
    "/api/route/analyze",
    body,
    "Route analysis failed"
  );
}

/**
 * Step 2 — POST /api/corridor/build
 * Builds spatial constraint corridor (S, α, V_lim, events) from a route.
 */
export async function buildCorridor(
  route: RouteAnalyzeResponse,
  options?: {
    smoothWindow?: number;
    smoothPolyorder?: number;
    aY?: number;
    maxGrade?: number;
    sgMinSpanM?: number;
    alphaMinPct?: number | null;
    alphaMaxPct?: number | null;
    trapLengthM?: number;
    legalSmoothMode?: "none" | "majority" | "min" | "mean_snap";
    legalSmoothWindowM?: number;
    legalMinRunM?: number;
    enableSpeedLimits?: boolean;
    globalMaxSpeedKmh?: number;
    includeTrafficInEnvelope?: boolean;
    speedSources?: Array<RouterKey | "osm">;
    speedCombine?: "min" | "mean_snap" | "majority";
    elevationSources?: ElevationSourceKey[];
    elevationCombine?: "mean" | "min" | "max";
    speedMinKmh?: number | null;
    speedMaxKmh?: number | null;
  }
): Promise<CorridorBuildResponse> {
  const body: CorridorBuildRequest = {
    route,
    smooth_window: options?.smoothWindow,
    smooth_polyorder: options?.smoothPolyorder,
    a_y_mps2: options?.aY,
    max_grade: options?.maxGrade,
    sg_min_span_m: options?.sgMinSpanM,
    alpha_min_pct: options?.alphaMinPct ?? null,
    alpha_max_pct: options?.alphaMaxPct ?? null,
    trap_length_m: options?.trapLengthM,
    legal_smooth_mode: options?.legalSmoothMode,
    legal_smooth_window_m: options?.legalSmoothWindowM,
    legal_min_run_m: options?.legalMinRunM,
    enable_speed_limits: options?.enableSpeedLimits,
    global_max_speed_kmh: options?.globalMaxSpeedKmh,
    include_traffic_in_envelope: options?.includeTrafficInEnvelope,
    speed_sources: options?.speedSources,
    speed_combine: options?.speedCombine,
    elevation_sources: options?.elevationSources,
    elevation_combine: options?.elevationCombine,
    speed_min_kmh: options?.speedMinKmh ?? null,
    speed_max_kmh: options?.speedMaxKmh ?? null,
  };

  if (useDemoOsrmClient()) {
    const ctx = beginApiRequest("POST", "/demo/corridor/build", {
      pts: route.geometry?.length,
    });
    try {
      const result = demoBuildCorridor(route, {
        aY: options?.aY,
        globalMaxSpeedKmh: options?.globalMaxSpeedKmh,
      });
      endApiRequestOk(ctx, { status: 200, data: result });
      return result;
    } catch (e) {
      const detail = e instanceof Error ? e.message : "Corridor démo échoué";
      endApiRequestError(ctx, detail);
      throw new ApiError(detail);
    }
  }

  return postJson<CorridorBuildResponse>(
    "/api/corridor/build",
    body,
    "Cycle build failed"
  );
}

/**
 * Step 3 — POST /api/simulate/start
 */
export async function startSimulation(
  corridor: SpatialCorridor,
  options?: {
    driverProfile?: DriverProfile;
    engine?: SimEngine;
    seed?: number | null;
    maxSpeedKmh?: number | null;
    driverParams?: {
      a_max?: number;
      b_comf?: number;
      speed_factor?: number;
      T?: number;
      T_h?: number;
      s0?: number;
      jerk_max?: number;
      jerk_brake_max?: number;
    } | null;
    driverZones?: SimulateStartRequest["driver_zones"];
    tlsOverride?: TlsOverride | null;
    enableMarkov?: boolean;
  }
): Promise<SimulateStartResponse> {
  const body: SimulateStartRequest = {
    corridor,
    driver_profile: options?.driverProfile ?? "Normal",
    engine: options?.engine ?? "sumo",
    seed: options?.seed ?? null,
    max_speed_kmh: options?.maxSpeedKmh ?? null,
    driver_params: options?.driverParams ?? null,
    driver_zones: options?.driverZones ?? null,
    enable_markov: options?.enableMarkov ?? false,
  };
  if (options?.tlsOverride != null) {
    body.tls_override = options.tlsOverride;
  }

  return postJson<SimulateStartResponse>(
    "/api/simulate/start",
    body,
    "Simulation start failed"
  );
}

/**
 * POST /api/scenario/run — batch scenario runner when backend supports it.
 * Callers should fall back to sequential simulate on 404.
 */
export async function runScenario(
  body: ScenarioRunRequest
): Promise<ScenarioRunResponse> {
  return postJson<ScenarioRunResponse>(
    "/api/scenario/run",
    body,
    "Scenario run failed"
  );
}

/**
 * Step 3 — POST /api/simulate/{id}/stop
 */
export async function stopSimulation(
  simulationId: string
): Promise<SimulateStopResponse> {
  return postJson<SimulateStopResponse>(
    `/api/simulate/${encodeURIComponent(simulationId)}/stop`,
    {},
    "Simulation stop failed"
  );
}

/**
 * Build absolute WebSocket URL from a relative ws_path returned by start.
 * Absolute `ws://` / `wss://` (and any non-`/` path) are rejected — only
 * server-relative paths are accepted to avoid open-redirect / SSRF-style misuse.
 * When `wsToken` is set, appends `?token=` or `&token=`.
 */
export function simulationWsUrl(wsPath: string, wsToken?: string): string {
  if (
    !wsPath ||
    !wsPath.startsWith("/") ||
    wsPath.startsWith("//") ||
    /^wss?:\/\//i.test(wsPath)
  ) {
    throw new ApiError(
      "Invalid WebSocket path: only relative paths starting with / are allowed"
    );
  }
  let url = `${WS_URL}${wsPath}`;
  const params = new URLSearchParams();
  if (wsToken) params.set("token", wsToken);
  if (API_KEY) params.set("api_key", API_KEY);
  const q = params.toString();
  if (q) url += `${url.includes("?") ? "&" : "?"}${q}`;
  return url;
}

/**
 * Step 4 — POST /api/export → blob download
 */
export async function exportProfile(
  profile: ConsolidatedProfile,
  format: ExportFormat = "csv"
): Promise<{ blob: Blob; filename: string }> {
  const body: ExportRequest = { profile, format };
  const ctx = beginApiRequest("POST", "/api/export", body);

  if (!API_URL) {
    endApiRequestError(ctx, API_MISSING_MSG);
    throw new ApiError(API_MISSING_MSG);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/export`, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    const detail = STATIC_EXPORT
      ? `API injoignable (${API_URL}) — vérifier le backend et CORS.`
      : "API injoignable — backend démarré sur le port 8000 ?";
    endApiRequestError(ctx, detail);
    throw new ApiError(detail);
  }

  if (!res.ok) {
    let detail = `Export failed (${res.status})`;
    try {
      const err = (await res.json()) as { detail?: string };
      if (err.detail) detail = err.detail;
    } catch {
      /* ignore */
    }
    endApiRequestError(ctx, detail, res.status);
    throw new ApiError(detail, res.status);
  }

  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
  const filename =
    match?.[1]?.replace(/['"]/g, "") ||
    `cyclegen_profile.${format === "xml" ? "xml" : "csv"}`;

  const blob = await res.blob();
  endApiRequestOk(ctx, {
    status: res.status,
    bytesHint: `${(blob.size / 1024).toFixed(1)} Ko · ${filename}`,
  });
  return { blob, filename };
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function getJson<T>(path: string, failLabel: string): Promise<T> {
  const ctx = beginApiRequest("GET", path);
  if (!API_URL) {
    endApiRequestError(ctx, API_MISSING_MSG);
    throw new ApiError(API_MISSING_MSG);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    if (isAbortError(err)) {
      const detail = `Request timed out after ${API_TIMEOUT_MS / 1000}s`;
      endApiRequestError(ctx, detail);
      throw new ApiError(detail);
    }
    const detail = STATIC_EXPORT
      ? `API injoignable (${API_URL}) — vérifier le backend et CORS.`
      : "API injoignable — backend démarré ?";
    endApiRequestError(ctx, detail);
    throw new ApiError(detail);
  }
  if (!res.ok) {
    let detail = `${failLabel} (${res.status})`;
    try {
      const err = (await res.json()) as { detail?: string };
      if (err.detail)
        detail =
          typeof err.detail === "string"
            ? err.detail
            : JSON.stringify(err.detail);
    } catch {
      /* ignore */
    }
    endApiRequestError(ctx, detail, res.status);
    throw new ApiError(detail, res.status);
  }
  const data = (await res.json()) as T;
  endApiRequestOk(ctx, { status: res.status, data });
  return data;
}

/** GET /api/benchmark/sources — empty on Pages démo sans API (pas d’appel localhost). */
export async function listBenchmarkSources(): Promise<BenchmarkSourceMeta[]> {
  if (!isApiConfigured()) return [];
  return getJson<BenchmarkSourceMeta[]>(
    "/api/benchmark/sources",
    "Benchmark sources failed"
  );
}

/** GET /api/benchmark/sources/{id} — reference series without a CycleGen profile */
export async function getBenchmarkSource(
  sourceId: string
): Promise<BenchmarkSourceSeries> {
  return getJson<BenchmarkSourceSeries>(
    `/api/benchmark/sources/${encodeURIComponent(sourceId)}`,
    "Benchmark source load failed"
  );
}

/** POST /api/benchmark/run */
export async function runBenchmark(params: {
  profile: ConsolidatedProfile;
  referenceId: string;
  align?: BenchmarkAlign;
  simulationId?: string | null;
}): Promise<BenchmarkRunResponse> {
  const body: BenchmarkRunRequest = {
    profile: params.profile,
    reference_id: params.referenceId,
    align: params.align ?? "time",
    simulation_id: params.simulationId ?? null,
  };
  return postJson<BenchmarkRunResponse>(
    "/api/benchmark/run",
    body,
    "Benchmark run failed"
  );
}

export { API_URL, WS_URL, API_TIMEOUT_MS };
