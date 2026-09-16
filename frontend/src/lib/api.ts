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
  ExportFormat,
  ExportRequest,
  RouteAnalyzeRequest,
  RouteAnalyzeResponse,
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

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
  "http://localhost:8000";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL?.replace(/\/$/, "") ||
  "ws://localhost:8000";

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
  routingProfile?: RouteAnalyzeRequest["routing_profile"];
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
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      "Cannot reach CycleGen API. Is the backend running?"
    );
  }

  if (!res.ok) {
    let detail = `${failLabel} (${res.status})`;
    try {
      const err = (await res.json()) as { detail?: string };
      if (err.detail) detail = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
    } catch {
      /* ignore parse errors */
    }
    throw new ApiError(detail, res.status);
  }

  return res.json() as Promise<T>;
}

/** Resolve a free-text address via Nominatim (POST /api/geocode). */
export async function geocodeAddress(
  query: string,
  opts?: { nearLat?: number; nearLon?: number }
): Promise<GeocodeResult> {
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
  const body: RouteAnalyzeRequest = {
    lat_a: params.latA ?? null,
    lon_a: params.lonA ?? null,
    lat_b: params.latB ?? null,
    lon_b: params.lonB ?? null,
    address_a: params.addressA ?? null,
    address_b: params.addressB ?? null,
    waypoints: params.waypoints ?? [],
    routing_profile: params.routingProfile ?? "Mapbox/Traffic",
    depart_at: params.departAt,
    a_y_mps2: params.aY,
  };

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
  };

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
 */
export function simulationWsUrl(wsPath: string): string {
  if (wsPath.startsWith("ws://") || wsPath.startsWith("wss://")) {
    return wsPath;
  }
  const path = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  return `${WS_URL}${path}`;
}

/**
 * Step 4 — POST /api/export → blob download
 */
export async function exportProfile(
  profile: ConsolidatedProfile,
  format: ExportFormat = "csv"
): Promise<{ blob: Blob; filename: string }> {
  const body: ExportRequest = { profile, format };

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      "Cannot reach CycleGen API. Is the backend running on port 8000?"
    );
  }

  if (!res.ok) {
    let detail = `Export failed (${res.status})`;
    try {
      const err = (await res.json()) as { detail?: string };
      if (err.detail) detail = err.detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status);
  }

  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
  const filename =
    match?.[1]?.replace(/['"]/g, "") ||
    `cyclegen_profile.${format === "xml" ? "xml" : "csv"}`;

  const blob = await res.blob();
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
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`);
  } catch {
    throw new ApiError("Cannot reach CycleGen API. Is the backend running?");
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
    throw new ApiError(detail, res.status);
  }
  return res.json() as Promise<T>;
}

/** GET /api/benchmark/sources */
export async function listBenchmarkSources(): Promise<BenchmarkSourceMeta[]> {
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

export { API_URL, WS_URL };
