/** Workflow stage for the CycleGen analysis pipeline. */
export type Stage = "route" | "corridor" | "simulating" | "completed";

export type LatLon = {
  lat: number;
  lon: number;
};

export type RoutePoint = LatLon & {
  label?: string;
};

export type RoutingProfile = "Car/OSRM" | "Mapbox/Traffic" | "HERE/ADAS";

export type DriverProfile = "Eco" | "Normal" | "Agressif" | "Sportif";

export const DRIVER_PROFILES: DriverProfile[] = [
  "Eco",
  "Normal",
  "Agressif",
  "Sportif",
];

export type CycleGenWarning = {
  code: string;
  message: string;
  s0: number;
  s1: number;
  source: string;
};

export type WaypointSpec = {
  lat?: number | null;
  lon?: number | null;
  address?: string | null;
  label?: string | null;
  stop_duration_s?: number;
};

/** Client-side waypoint with stable id for React lists. */
export type WaypointDraft = {
  id: string;
  lat: number | null;
  lon: number | null;
  address: string;
  label: string;
  stop_duration_s: number;
};

export type ResolvedViaPoint = {
  index: number;
  lat: number;
  lon: number;
  label: string;
  stop_duration_s: number;
};

export type RoadStructureSegment = {
  kind: "bridge" | "tunnel" | "highway";
  lat0: number;
  lon0: number;
  lat1: number;
  lon1: number;
  highway?: string | null;
  osm_id?: number | null;
};

export type RouteAnalyzeRequest = {
  lat_a?: number | null;
  lon_a?: number | null;
  lat_b?: number | null;
  lon_b?: number | null;
  address_a?: string | null;
  address_b?: string | null;
  waypoints?: WaypointSpec[];
  /**
   * DEPRECATED single-router selector; prefer `routing_profiles` (multi).
   * Kept for backwards compat: server normalizes it into a 1-element list.
   */
  routing_profile?: RoutingProfile | null;
  /** Ordered list of routers to call in parallel (first = primary geometry). */
  routing_profiles?: RoutingProfile[];
  /** Departure timestamp (ISO 8601) for traffic envelope. */
  depart_at: string;
  /** Comfort lateral acceleration for curve speed limit (m/s²). */
  a_y_mps2?: number;
};

/** Canonical router keys mirrored from `backend/app/services/routing/multi.py`. */
export type RouterKey = "here" | "mapbox" | "osrm";

export const ROUTER_LABELS: Record<RouterKey, string> = {
  here: "HERE / ADAS",
  mapbox: "Mapbox / Traffic",
  osrm: "OSRM (free-flow)",
};

export const ROUTER_TO_PROFILE: Record<RouterKey, RoutingProfile> = {
  here: "HERE/ADAS",
  mapbox: "Mapbox/Traffic",
  osrm: "Car/OSRM",
};

export const PROFILE_TO_ROUTER: Record<RoutingProfile, RouterKey> = {
  "HERE/ADAS": "here",
  "Mapbox/Traffic": "mapbox",
  "Car/OSRM": "osrm",
};

export type ElevationSourceKey =
  | "here"
  | "open-meteo"
  | "open-elevation"
  | "opentopodata";

export const ELEVATION_SOURCE_LABELS: Record<ElevationSourceKey, string> = {
  "here": "HERE (polyline 3D)",
  "open-meteo": "DEM Open-Meteo",
  "open-elevation": "Open-Elevation",
  "opentopodata": "OpenTopoData (ASTER 30 m)",
};

export type RouteAnalyzeResponse = {
  geometry: LatLon[];
  distance_m: number;
  duration_s: number;
  segment_speeds_mps: number[];
  segment_distances_m: number[];
  elevations_m: number[];
  traffic_signals: Array<{ lat: number; lon: number; osm_id?: number | null }>;
  bbox: [number, number, number, number];
  origin?: LatLon | null;
  destination?: LatLon | null;
  origin_label?: string | null;
  destination_label?: string | null;
  via_points?: ResolvedViaPoint[];
  traffic_source?: string;
  warnings?: CycleGenWarning[];
  road_structures?: RoadStructureSegment[];
  osm_speed_limits?: Array<{
    lat0: number;
    lon0: number;
    lat1: number;
    lon1: number;
    maxspeed_kmh: number;
    highway?: string | null;
    osm_id?: number | null;
    geometry?: LatLon[];
  }>;
  segment_traffic_speeds_mps?: number[];
  depart_at?: string | null;
  a_y_mps2?: number;
  elevation_source?: string | null;
  /** Ordered list of routers that actually contributed (first = primary geometry). */
  routers_used?: RouterKey[];
  /** Per-router V_legal (m/s) aligned on the primary S-axis. */
  segment_speeds_by_router?: Partial<Record<RouterKey, number[]>>;
  /** Per-router V_traffic (m/s) aligned on the primary S-axis. */
  segment_traffic_speeds_by_router?: Partial<Record<RouterKey, number[]>>;
  /** Per-source Z (m) aligned on the primary S-axis. */
  elevations_by_source?: Partial<Record<ElevationSourceKey, number[]>>;
  /** Per-router outcome tag: 'ok' | 'skipped:no_key' | 'error:...'. */
  router_status?: Partial<Record<RouterKey, string>>;
};

export const MAX_WAYPOINTS = 20;

export type DetectedEventKind = "traffic_signal" | "speed_limit" | "waypoint_stop";

export type DetectedEvent = {
  s_m: number;
  kind: DetectedEventKind;
  label: string;
  value?: number | null;
};

export type ScheduledStop = {
  s_m: number;
  stop_duration_s: number;
  label: string;
  lat?: number | null;
  lon?: number | null;
};

export type FeuMeta = {
  s_m: number;
  highway?: string | null;
  tls_mode?: "green_wave" | "stochastic";
};

/** Piecewise trapezoid slope segment (length ≈ trap_length_m). */
export type SlopeTrapezoid = {
  s0_m: number;
  s1_m: number;
  z0_m: number;
  z1_m: number;
  slope_rad: number;
  slope_pct: number;
};

/** Aggregated 1 km band over trapezoids. */
export type SlopeKmSegment = {
  km_index: number;
  s0_m: number;
  s1_m: number;
  z0_m: number;
  z1_m: number;
  mean_pct: number;
  min_pct: number;
  max_pct: number;
  std_pct: number;
  traps: SlopeTrapezoid[];
};

export type SlopeProfile = {
  trap_length_m: number;
  km_segments: SlopeKmSegment[];
};

export type SpatialCorridor = {
  S: number[];
  V_limite: number[];
  V_limite_legal?: number[];
  V_traffic?: number[];
  V_curve?: number[];
  V_envelope?: number[];
  alpha: number[];
  /** Corrected DEM altitudes (m), when returned by corridor build. */
  elevations_m?: number[];
  /** Trapezoid / 1 km slope profile (corridor build). */
  slope_profile?: SlopeProfile | null;
  S_feux: number[];
  feux_meta?: FeuMeta[];
  events: DetectedEvent[];
  geometry: LatLon[];
  scheduled_stops?: ScheduledStop[];
  traffic_source?: string;
  warnings?: CycleGenWarning[];
  a_y_mps2?: number;
};

export type CorridorBuildRequest = {
  route: RouteAnalyzeResponse;
  smooth_window?: number;
  smooth_polyorder?: number;
  a_y_mps2?: number | null;
  max_grade?: number;
  sg_min_span_m?: number;
  alpha_min_pct?: number | null;
  alpha_max_pct?: number | null;
  /** Trapezoid length L (m) for slope_profile. */
  trap_length_m?: number;
  /** Spatial filter on V_legal. */
  legal_smooth_mode?: "none" | "majority" | "min" | "mean_snap";
  legal_smooth_window_m?: number;
  legal_min_run_m?: number;
  enable_speed_limits?: boolean;
  global_max_speed_kmh?: number;
  include_traffic_in_envelope?: boolean;
  /** Router sources to combine into V_legal (subset of 'here','mapbox','osrm','osm'). */
  speed_sources?: Array<RouterKey | "osm">;
  speed_combine?: "min" | "mean_snap" | "majority";
  /** Elevation sources to combine into Z. */
  elevation_sources?: ElevationSourceKey[];
  elevation_combine?: "mean" | "min" | "max";
  /** Optional hard clamps on V_envelope (km/h). */
  speed_min_kmh?: number | null;
  speed_max_kmh?: number | null;
};

export type CorridorBuildResponse = {
  corridor: SpatialCorridor;
  corridor_id: string;
  v_limite_legal?: number[];
  v_traffic?: number[];
  v_curve?: number[];
  v_envelope?: number[];
  traffic_source?: string;
  warnings?: CycleGenWarning[];
};

/** Step 3 — Simulation */

export type SimEngine = "sumo" | "idm";

export type TlsOverride = "auto" | "green_wave" | "stochastic";

export type SimulateStartRequest = {
  corridor: SpatialCorridor;
  driver_profile?: DriverProfile;
  engine?: SimEngine;
  seed?: number | null;
  max_speed_kmh?: number | null;
  driver_params?: {
    a_max?: number | null;
    b_comf?: number | null;
    speed_factor?: number | null;
    T?: number | null;
    T_h?: number | null;
    s0?: number | null;
    jerk_max?: number | null;
    jerk_brake_max?: number | null;
  } | null;
  driver_zones?: Array<{
    id?: string;
    label?: string;
    s0_m: number;
    s1_m?: number | null;
    a_max?: number | null;
    b_comf?: number | null;
    speed_factor?: number | null;
    a_y_mps2?: number | null;
  }> | null;
  /** Force TLS planning mode when API supports it. */
  tls_override?: TlsOverride | null;
  /** Stochastic Markov a_noise (homologation default: false). */
  enable_markov?: boolean;
};

export type SimulateStartResponse = {
  simulation_id: string;
  engine: SimEngine;
  ws_path: string;
  /** Present when IDM finished inside /start — consolidate via /stop immediately. */
  status?: "running" | "completed" | "failed" | "stopped";
};

export type VehicleSnapshot = {
  id: string;
  lat: number;
  lon: number;
  speed_mps: number;
  is_ego?: boolean;
};

export type SimulationFrame = {
  t: number;
  v: number;
  a: number;
  s: number;
  alpha: number;
  density: number;
  vehicles?: VehicleSnapshot[];
  tls_state?: string | null;
  ego_arrived?: boolean;
};

export type ConsolidatedProfile = {
  time: number[];
  velocity: number[];
  position: number[];
  acceleration: number[];
  slope: number[];
  total_duration_s: number;
  average_speed_kmh: number;
  status: "completed" | "stopped" | "failed";
  traffic_source?: string | null;
  warnings?: CycleGenWarning[];
  /** Optional KPI / safety fields (when backend populates them). */
  n_stops?: number;
  stops?: number;
  rpa?: number;
  max_abs_accel?: number;
  max_abs_accel_g?: number;
  markov_gate_fraction?: number;
  clip_hit_count?: number;
};

/** Scenario batch API — matches backend ScenarioRunRequest / Response. */
export type ScenarioArmRequest = {
  id: string;
  label?: string | null;
  driver_profile?: DriverProfile;
  seed?: number | null;
  tls_override?: TlsOverride;
  max_speed_kmh?: number | null;
  driver_params?: SimulateStartRequest["driver_params"];
};

export type ScenarioRunRequest = {
  corridor: SpatialCorridor;
  arms: ScenarioArmRequest[];
  reference_arm_id?: string | null;
};

export type ScenarioArmKpis = {
  duration_s: number;
  distance_m: number;
  mean_speed_mps: number;
  mean_speed_kmh: number;
  stops: number;
  stop_time_ratio: number;
  mean_abs_accel: number;
  p95_abs_accel: number;
  rpa: number;
  max_abs_accel: number;
  max_abs_accel_g: number;
  markov_gate_fraction: number;
  clip_hit_count: number;
};

export type ScenarioArmResult = {
  id: string;
  label: string;
  profile: ConsolidatedProfile;
  kpis: ScenarioArmKpis;
  time: number[];
  velocity: number[];
};

export type ScenarioRunResponse = {
  arms: ScenarioArmResult[];
  reference_id: string;
  deltas?: Record<string, Record<string, number>>;
  warnings?: string[];
};

export type SimulateStopResponse = {
  simulation_id: string;
  profile: ConsolidatedProfile;
};

/** Step 4 — Export */

export type ExportFormat = "csv" | "xml";

export type ExportRequest = {
  profile: ConsolidatedProfile;
  format?: ExportFormat;
};

/** Benchmark & Validation */

export type BenchmarkSourceFamily =
  | "regulatory"
  | "ved"
  | "geolife"
  | "demo"
  | "oem"
  | "alpine";

export type BenchmarkSourceMeta = {
  id: string;
  name: string;
  license: string;
  has_geo: boolean;
  n_points: number;
  duration_s: number;
  family?: BenchmarkSourceFamily | string;
  source?: string | null;
  added_at?: string | null;
  stats?: Record<string, unknown> | null;
  zones?: Array<Record<string, unknown>> | null;
  zone_split?: Record<string, unknown> | null;
  vehicle?: Record<string, unknown> | null;
  citation?: string | null;
  url?: string | null;
};

export type BenchmarkSourceSeries = {
  id: string;
  name: string;
  has_geo: boolean;
  time: number[];
  velocity: number[];
  lat?: number[] | null;
  lon?: number[] | null;
  position?: number[] | null;
  slope?: number[] | null;
  acceleration?: number[] | null;
  a_lat?: number[] | null;
  zones?: Array<Record<string, unknown>> | null;
  stats?: Record<string, unknown> | null;
  source?: string | null;
  added_at?: string | null;
  zone_split?: Record<string, unknown> | null;
  citation?: string | null;
  url?: string | null;
  license?: string | null;
};

export type BenchmarkAlign = "time" | "distance";

export type BenchmarkKpis = {
  rmse_v: number;
  mae_v: number;
  bias_v: number;
  delta_duration_pct: number;
  delta_duration_s: number;
  delta_distance_pct: number;
  delta_distance_m: number;
  stops_gen: number;
  stops_ref: number;
  stop_time_ratio_gen: number;
  stop_time_ratio_ref: number;
  mean_abs_accel_gen: number;
  mean_abs_accel_ref: number;
  p95_abs_accel_gen: number;
  p95_abs_accel_ref: number;
};

export type BenchmarkRunRequest = {
  profile?: ConsolidatedProfile | null;
  reference_id: string;
  align?: BenchmarkAlign;
  simulation_id?: string | null;
};

export type BenchmarkRunResponse = {
  reference_id: string;
  align: BenchmarkAlign;
  ref_has_geo: boolean;
  times: number[];
  v_gen: number[];
  v_ref: number[];
  s_gen?: number[] | null;
  s_ref?: number[] | null;
  lat_ref?: number[] | null;
  lon_ref?: number[] | null;
  kpis: BenchmarkKpis;
  recalibration_hints: string[];
  warnings: string[];
};

/** Default map center — midway between Richebourg and Houdan (Yvelines). */
export const DEFAULT_CENTER: [number, number] = [48.808, 1.618];
export const DEFAULT_ZOOM = 12;

export const DEFAULT_DEPARTURE_LABEL = "Richebourg";
export const DEFAULT_DESTINATION_LABEL = "Houdan";
