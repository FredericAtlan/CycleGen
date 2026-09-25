"""Shared Pydantic DTOs — single source of truth for API contracts."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class DriverProfile(str, Enum):
    ECO = "Eco"
    NORMAL = "Normal"
    AGRESSIF = "Agressif"
    SPORTIF = "Sportif"
    # AVL Route Studio XSPACE fingerprints (batch Sep 2026).
    PRUDENT = "Prudent"
    DYNAMIQUE = "Dynamique"


class RoutingProfile(str, Enum):
    CAR_OSRM = "Car/OSRM"
    MAPBOX_TRAFFIC = "Mapbox/Traffic"
    HERE_ADAS = "HERE/ADAS"


# ---------------------------------------------------------------------------
# Shared audit / imputation
# ---------------------------------------------------------------------------


class CycleGenWarning(BaseModel):
    """Documented imputation or scientific correction along the corridor."""

    code: str
    message: str
    s0: float = 0.0
    s1: float = 0.0
    source: str = "pipeline"


# ---------------------------------------------------------------------------
# Step 1 — Route acquisition
# ---------------------------------------------------------------------------


class WaypointSpec(BaseModel):
    """Intermediate stop between A and B (geocode via address if lat/lon missing)."""

    lat: float | None = None
    lon: float | None = None
    address: str | None = None
    label: str | None = None
    stop_duration_s: float = Field(
        0.0, ge=0.0, le=7200.0, description="Dwell time at this stop (seconds)"
    )


class RouteAnalyzeRequest(BaseModel):
    lat_a: float | None = Field(None, description="Departure latitude (or use address_a)")
    lon_a: float | None = Field(None, description="Departure longitude")
    lat_b: float | None = Field(None, description="Destination latitude (or use address_b)")
    lon_b: float | None = Field(None, description="Destination longitude")
    address_a: str | None = Field(None, description="Departure address (Nominatim)")
    address_b: str | None = Field(None, description="Destination address (Nominatim)")
    waypoints: list[WaypointSpec] = Field(
        default_factory=list,
        max_length=20,
        description="Intermediate stops (max 20), each with optional stop_duration_s",
    )
    routing_profile: RoutingProfile | None = Field(
        default=None,
        description=(
            "DEPRECATED single-router selector. Prefer `routing_profiles` "
            "(multi). Kept for backwards compat: normalized into a 1-element list."
        ),
    )
    routing_profiles: list[RoutingProfile] = Field(
        default_factory=list,
        description=(
            "Ordered list of routers to call in parallel. The first element "
            "dictates the primary geometry (S-axis); others are projected "
            "onto it via nearest-S. Empty = auto-detect configured routers."
        ),
    )
    depart_at: datetime = Field(
        ...,
        description="Departure timestamp (required for traffic envelope; local or UTC).",
    )
    a_y_mps2: float = Field(
        2.5,
        ge=0.5,
        le=6.0,
        description="Comfort lateral acceleration for curve speed limit (m/s²).",
    )


class GeocodeRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=300)
    near_lat: float | None = None
    near_lon: float | None = None


class GeocodeResponse(BaseModel):
    lat: float
    lon: float
    display_name: str
    query: str
    # DEM altitude (m). Null if elevation lookup failed.
    elevation_m: float | None = None


class LatLon(BaseModel):
    lat: float
    lon: float


class ElevationLookupRequest(BaseModel):
    points: list[LatLon] = Field(..., min_length=1, max_length=20)


class ElevationLookupResponse(BaseModel):
    elevations_m: list[float | None]


class TrafficSignalPoint(BaseModel):
    lat: float
    lon: float
    osm_id: int | None = None
    highway: str | None = None


class RoadStructureSegment(BaseModel):
    """OSM bridge/tunnel (or highway class) interval projected later onto S."""

    kind: Literal["bridge", "tunnel", "highway"]
    lat0: float
    lon0: float
    lat1: float
    lon1: float
    highway: str | None = None
    osm_id: int | None = None


class OsmSpeedLimitSegment(BaseModel):
    """OSM posted maxspeed way (endpoints + optional densified geom)."""

    lat0: float
    lon0: float
    lat1: float
    lon1: float
    maxspeed_kmh: float = Field(..., gt=0, le=160)
    highway: str | None = None
    osm_id: int | None = None
    geometry: list[LatLon] = Field(
        default_factory=list,
        description="Optional way vertices for robust projection onto the route.",
    )


class ResolvedViaPoint(BaseModel):
    """Waypoint after geocoding, ordered along the trip (excludes A/B)."""

    index: int
    lat: float
    lon: float
    label: str
    stop_duration_s: float


class RouteAnalyzeResponse(BaseModel):
    geometry: list[LatLon]
    distance_m: float
    duration_s: float
    segment_speeds_mps: list[float]
    segment_distances_m: list[float]
    elevations_m: list[float]
    traffic_signals: list[TrafficSignalPoint]
    bbox: tuple[float, float, float, float]  # south, west, north, east
    origin: LatLon | None = None
    destination: LatLon | None = None
    origin_label: str | None = None
    destination_label: str | None = None
    via_points: list[ResolvedViaPoint] = Field(default_factory=list)
    traffic_source: str = "osrm_freeflow"
    warnings: list[CycleGenWarning] = Field(default_factory=list)
    road_structures: list[RoadStructureSegment] = Field(default_factory=list)
    osm_speed_limits: list[OsmSpeedLimitSegment] = Field(
        default_factory=list,
        description="OSM maxspeed ways for posted V_legal enrichment.",
    )
    segment_traffic_speeds_mps: list[float] = Field(
        default_factory=list,
        description="Per-segment traffic flow speeds (Mapbox); empty if free-flow fallback",
    )
    depart_at: datetime | None = None
    a_y_mps2: float = 2.5
    elevation_source: str | None = Field(
        default=None,
        description="DEM provider tag: here | open-meteo | open-elevation | …",
    )
    routers_used: list[str] = Field(
        default_factory=list,
        description=(
            "Ordered list of routers that actually contributed data (first = "
            "primary geometry). Excludes routers that failed or were skipped."
        ),
    )
    segment_speeds_by_router: dict[str, list[float]] = Field(
        default_factory=dict,
        description=(
            "V_legal per router aligned on the primary S-axis (m/s per vertex). "
            "Keys: 'here' | 'mapbox' | 'osrm'. Missing / failed routers omit "
            "their entry."
        ),
    )
    segment_traffic_speeds_by_router: dict[str, list[float]] = Field(
        default_factory=dict,
        description=(
            "V_traffic per router aligned on the primary S-axis (m/s per vertex). "
            "For HERE/OSRM this typically mirrors the legal speed (free-flow)."
        ),
    )
    elevations_by_source: dict[str, list[float]] = Field(
        default_factory=dict,
        description=(
            "Per-source elevation vector aligned on the primary S-axis (m per "
            "vertex). Keys: 'here' | 'open-meteo' | 'open-elevation' | "
            "'opentopodata'."
        ),
    )
    router_status: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Per-router outcome tag: 'ok' | 'skipped:no_key' | 'error:<msg>'."
        ),
    )
    connection_log: list[dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "Upstream hops during this request (HERE, Mapbox, OSRM, Overpass…). "
            "Each entry: provider, phase, host, url (secrets redacted), status, "
            "duration_ms — for the Studio API console."
        ),
    )


# ---------------------------------------------------------------------------
# Step 2 — Spatial corridor
# ---------------------------------------------------------------------------


class SlopeTrapezoid(BaseModel):
    s0_m: float
    s1_m: float
    z0_m: float
    z1_m: float
    slope_rad: float
    slope_pct: float  # 100 * (z1 - z0) / (s1 - s0)


class SlopeKmSegment(BaseModel):
    km_index: int  # 0-based
    s0_m: float
    s1_m: float
    z0_m: float
    z1_m: float
    mean_pct: float  # whole-km grade: 100 * (z1 - z0) / (s1 - s0)
    min_pct: float  # min of trap slope_pct in km
    max_pct: float
    std_pct: float  # sample std of trap slope_pct (0 if <2 traps)
    traps: list[SlopeTrapezoid]


class SlopeProfile(BaseModel):
    trap_length_m: float
    km_segments: list[SlopeKmSegment]


class CorridorBuildRequest(BaseModel):
    """Either pass a prior route payload or reuse analyze fields inline."""

    route: RouteAnalyzeResponse
    smooth_window: int = Field(
        11, ge=5, description="Savitzky-Golay odd window (raised to ≥ sg_min_span_m)"
    )
    smooth_polyorder: int = Field(3, ge=2)
    a_y_mps2: float | None = Field(
        None, ge=0.5, le=6.0, description="Override lateral comfort accel (m/s²)"
    )
    max_grade: float = Field(
        0.15,
        ge=0.01,
        le=20.0,
        description="Max |dz/ds| before elevation clamp (0.15 ≈ 15% grade; large = almost off).",
    )
    sg_min_span_m: float = Field(
        150.0,
        ge=5.0,
        le=500.0,
        description="Spatial MA window (m) on DEM altitude Z before slope.",
    )
    trap_length_m: float = Field(
        50.0,
        ge=10.0,
        le=500.0,
        description="Trapezoid / palier length along s (m) for slope α.",
    )
    alpha_min_pct: float | None = Field(
        None,
        ge=-200.0,
        le=200.0,
        description="Optional hard floor on resulting slope (%% grade). None = no floor.",
    )
    alpha_max_pct: float | None = Field(
        None,
        ge=-200.0,
        le=200.0,
        description="Optional hard ceiling on resulting slope (%% grade). None = no ceiling.",
    )
    legal_smooth_mode: Literal["none", "majority", "min", "mean_snap"] = Field(
        "majority",
        description="Spatial filter on V_legal: none | majority | min | mean_snap.",
    )
    legal_smooth_window_m: float = Field(
        250.0,
        ge=0.0,
        le=1000.0,
        description="Spatial window (m) for V_legal filter along S.",
    )
    legal_min_run_m: float = Field(
        120.0,
        ge=0.0,
        le=500.0,
        description="Min plateau length (m) before a posted-limit change is kept.",
    )
    enable_speed_limits: bool = Field(
        True,
        description="If True, V_legal enters V_cible; else free-flow geometry + Vmax only.",
    )
    global_max_speed_kmh: float = Field(
        130.0,
        ge=30.0,
        le=300.0,
        description="Hard vehicle / scenario speed cap (km/h) applied in the envelope min.",
    )
    include_traffic_in_envelope: bool = Field(
        False,
        description="If True, V_traffic (congestion) enters V_cible. Homologation = False.",
    )
    speed_sources: list[str] = Field(
        default_factory=lambda: ["here", "mapbox", "osrm", "osm"],
        description=(
            "Which V_legal sources to combine into the working legal envelope. "
            "Options: 'here', 'mapbox', 'osrm', 'osm'. Ignored keys are dropped."
        ),
    )
    speed_combine: Literal["min", "mean_snap", "majority"] = Field(
        "min",
        description=(
            "How to combine per-router V_legal series before the spatial "
            "filter. 'min' is the safest (respects the most binding source)."
        ),
    )
    elevation_sources: list[str] = Field(
        default_factory=lambda: ["here", "open-meteo", "open-elevation", "opentopodata"],
        description=(
            "Which Z sources feed the corridor elevation vector. If several "
            "are available they are combined via `elevation_combine`."
        ),
    )
    elevation_combine: Literal["mean", "min", "max"] = Field(
        "mean",
        description="Aggregation across enabled elevation sources.",
    )
    speed_min_kmh: float | None = Field(
        default=None,
        ge=0.0,
        le=300.0,
        description="Optional hard floor on V_envelope (km/h). None = no floor.",
    )
    speed_max_kmh: float | None = Field(
        default=None,
        ge=0.0,
        le=300.0,
        description=(
            "Optional hard ceiling on V_envelope (km/h). Distinct from the "
            "physical vehicle Vmax (see `global_max_speed_kmh`)."
        ),
    )


class DetectedEvent(BaseModel):
    s_m: float
    kind: Literal["traffic_signal", "speed_limit", "waypoint_stop"]
    label: str
    value: float | None = None


class ScheduledStop(BaseModel):
    s_m: float
    stop_duration_s: float
    label: str
    lat: float | None = None
    lon: float | None = None


class FeuMeta(BaseModel):
    """Traffic light with OSM class for conditional green-wave logic."""

    s_m: float
    highway: str | None = None
    tls_mode: Literal["green_wave", "stochastic"] = "stochastic"


class SpatialCorridor(BaseModel):
    S: list[float]
    V_limite: list[float] = Field(
        ...,
        description="Backward-compatible alias of V_envelope (solver / SUMO).",
    )
    V_limite_legal: list[float] = Field(default_factory=list)
    V_traffic: list[float] = Field(default_factory=list)
    V_curve: list[float] = Field(default_factory=list)
    V_envelope: list[float] = Field(default_factory=list)
    alpha: list[float]
    elevations_m: list[float] = Field(
        default_factory=list,
        description="Corrected DEM altitudes (m) after bridge/tunnel + grade clamp.",
    )
    S_feux: list[float]
    feux_meta: list[FeuMeta] = Field(default_factory=list)
    events: list[DetectedEvent]
    geometry: list[LatLon]
    scheduled_stops: list[ScheduledStop] = Field(default_factory=list)
    traffic_source: str = "osrm_freeflow"
    warnings: list[CycleGenWarning] = Field(default_factory=list)
    a_y_mps2: float = 2.5
    slope_profile: SlopeProfile | None = None

    @model_validator(mode="after")
    def _parallel_arrays_match(self) -> SpatialCorridor:
        n = len(self.S)
        required = {
            "alpha": self.alpha,
            "V_limite": self.V_limite,
        }
        for name, arr in required.items():
            if len(arr) != n:
                raise ValueError(
                    f"SpatialCorridor.{name} length {len(arr)} != len(S)={n}"
                )
        # Optional parallel series: empty means "absent"; non-empty must match S.
        optional = {
            "V_limite_legal": self.V_limite_legal,
            "V_traffic": self.V_traffic,
            "V_curve": self.V_curve,
            "V_envelope": self.V_envelope,
            "elevations_m": self.elevations_m,
            "geometry": self.geometry,
        }
        for name, arr in optional.items():
            if arr and len(arr) != n:
                raise ValueError(
                    f"SpatialCorridor.{name} length {len(arr)} != len(S)={n}"
                )
        return self


class CorridorBuildResponse(BaseModel):
    corridor: SpatialCorridor
    corridor_id: str
    # Explicit top-level mirrors (Gemini W1) for API consumers / OpenAPI clarity
    v_limite_legal: list[float] = Field(default_factory=list)
    v_traffic: list[float] = Field(default_factory=list)
    v_curve: list[float] = Field(default_factory=list)
    v_envelope: list[float] = Field(default_factory=list)
    traffic_source: str = "osrm_freeflow"
    warnings: list[CycleGenWarning] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Step 3 — Simulation
# ---------------------------------------------------------------------------


class DriverParamOverrides(BaseModel):
    a_max: float | None = Field(default=None, ge=0.2, le=12.0)
    b_comf: float | None = Field(default=None, ge=0.5, le=15.0)
    speed_factor: float | None = Field(default=None, ge=0.4, le=1.5)
    T: float | None = Field(
        default=None,
        ge=0.3,
        le=4.0,
        description="IDM desired time headway (s). Higher = more anticipative.",
    )
    T_h: float | None = Field(
        default=None,
        ge=0.5,
        le=12.0,
        description="Scan horizon time (s). D_horizon = v · T_h.",
    )
    s0: float | None = Field(
        default=None,
        ge=0.5,
        le=10.0,
        description="Minimum bumper gap at full stop (m).",
    )
    jerk_max: float | None = Field(
        default=None,
        ge=0.0,
        le=20.0,
        description="Max |da/dt| when accelerating (m/s³). 0 disables. AVL comfort ≈ 1.",
    )
    jerk_brake_max: float | None = Field(
        default=None,
        ge=0.0,
        le=20.0,
        description="Max |da/dt| when braking (m/s³). Defaults to jerk_max if omitted.",
    )


class DriverZoneSpec(BaseModel):
    """Driver IDM params that apply on a distance interval [s0_m, s1_m)."""

    id: str = "z"
    label: str = ""
    s0_m: float = Field(0.0, ge=0.0)
    s1_m: float | None = Field(
        default=None,
        ge=0.0,
        description="Exclusive end abscissa (m). None = until corridor end.",
    )
    a_max: float | None = Field(default=None, ge=0.2, le=12.0)
    b_comf: float | None = Field(default=None, ge=0.5, le=15.0)
    speed_factor: float | None = Field(default=None, ge=0.4, le=1.5)
    a_y_mps2: float | None = Field(
        default=None,
        ge=0.5,
        le=12.0,
        description="Optional lateral comfort hint for this zone (envelope rebuild is global).",
    )


class SimulateStartRequest(BaseModel):
    corridor: SpatialCorridor
    driver_profile: DriverProfile = DriverProfile.NORMAL
    engine: Literal["sumo", "idm"] = "sumo"
    seed: int | None = None
    max_speed_kmh: float | None = Field(
        default=None,
        ge=1,
        le=300,
        description="Hard vehicle speed cap (km/h). None = road limit × speed_factor only.",
    )
    driver_params: DriverParamOverrides | None = Field(
        default=None,
        description="Optional IDM overrides (a_max, b_comf, speed_factor).",
    )
    driver_zones: list[DriverZoneSpec] | None = Field(
        default=None,
        description=(
            "Optional distance-based driver params. When set, IDM picks "
            "a_max / b_comf / speed_factor from the zone containing ego s."
        ),
    )
    tls_cycle_s: float = Field(90.0, ge=30.0, le=180.0)
    tls_green_s: float = Field(35.0, ge=5.0, le=120.0)
    tls_override: Literal["auto", "green_wave", "stochastic"] = Field(
        default="auto",
        description="Force all lights to green_wave / stochastic, or auto (honor feux_meta).",
    )
    enable_markov: bool = Field(
        False,
        description=(
            "If False (homologation default), IDM a_noise = 0 and no stochastic "
            "Markov injection. Deterministic envelope / TLS virtual leaders stay on."
        ),
    )


class SimulateStartResponse(BaseModel):
    simulation_id: str
    engine: Literal["sumo", "idm"]
    ws_path: str
    ws_token: str = Field(
        ...,
        description=(
            "One-time access token for the WebSocket stream. "
            "Pass as query param ``?token=`` on ``ws_path``."
        ),
    )
    # IDM finishes inside /start; client can POST /stop immediately for the full profile.
    status: Literal["running", "completed", "failed", "stopped"] = "running"


class VehicleSnapshot(BaseModel):
    id: str
    lat: float
    lon: float
    speed_mps: float
    is_ego: bool = False


class SimulationFrame(BaseModel):
    t: float
    v: float
    a: float
    s: float
    alpha: float
    density: float
    vehicles: list[VehicleSnapshot] = Field(default_factory=list)
    tls_state: str | None = None


# Soft pydantic ceiling aligned with CYCLEGEN_MAX_ROUTE_POINTS default (export also validates).
_MAX_PROFILE_POINTS = 12_000


class ConsolidatedProfile(BaseModel):
    time: list[float] = Field(..., max_length=_MAX_PROFILE_POINTS)
    velocity: list[float] = Field(..., max_length=_MAX_PROFILE_POINTS)
    position: list[float] = Field(..., max_length=_MAX_PROFILE_POINTS)
    acceleration: list[float] = Field(..., max_length=_MAX_PROFILE_POINTS)
    slope: list[float] = Field(..., max_length=_MAX_PROFILE_POINTS)
    total_duration_s: float
    average_speed_kmh: float
    status: Literal["completed", "stopped", "failed"] = "completed"
    traffic_source: str | None = None
    warnings: list[CycleGenWarning] = Field(default_factory=list)
    # Safety / audit (IDM); optional for SUMO / legacy
    max_abs_accel: float | None = None
    max_abs_accel_g: float | None = None
    markov_gate_fraction: float | None = None
    clip_hit_count: int | None = None
    rpa: float | None = None
    stops: int | None = None
    stop_time_ratio: float | None = None


class ScenarioArmRequest(BaseModel):
    id: str
    label: str | None = None
    driver_profile: DriverProfile = DriverProfile.NORMAL
    seed: int | None = None
    tls_override: Literal["auto", "green_wave", "stochastic"] = "auto"
    max_speed_kmh: float | None = Field(default=None, ge=1, le=300)
    driver_params: DriverParamOverrides | None = None


class ScenarioRunRequest(BaseModel):
    corridor: SpatialCorridor
    arms: list[ScenarioArmRequest] = Field(..., min_length=1, max_length=8)
    reference_arm_id: str | None = None


class ScenarioArmKpis(BaseModel):
    duration_s: float
    distance_m: float
    mean_speed_mps: float
    mean_speed_kmh: float
    stops: int
    stop_time_ratio: float
    mean_abs_accel: float
    p95_abs_accel: float
    rpa: float
    max_abs_accel: float
    max_abs_accel_g: float
    markov_gate_fraction: float
    clip_hit_count: int


class ScenarioArmResult(BaseModel):
    id: str
    label: str
    profile: ConsolidatedProfile
    kpis: ScenarioArmKpis
    time: list[float]
    velocity: list[float]


class ScenarioRunResponse(BaseModel):
    arms: list[ScenarioArmResult]
    reference_id: str
    deltas: dict[str, dict[str, float]] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class SimulateStopResponse(BaseModel):
    simulation_id: str
    profile: ConsolidatedProfile


# ---------------------------------------------------------------------------
# Step 4 — Export
# ---------------------------------------------------------------------------


class ExportRequest(BaseModel):
    profile: ConsolidatedProfile
    format: Literal["csv", "xml"] = "csv"


class ExportResponse(BaseModel):
    filename: str
    content_type: str
    # Body returned as StreamingResponse; this DTO documents the contract.


# ---------------------------------------------------------------------------
# Benchmark & Validation
# ---------------------------------------------------------------------------


class BenchmarkSourceMeta(BaseModel):
    id: str
    name: str
    license: str
    has_geo: bool
    n_points: int
    duration_s: float
    family: str = "regulatory"
    source: str | None = None
    added_at: str | None = None
    stats: dict[str, Any] | None = None
    zones: list[dict[str, Any]] | None = None
    zone_split: dict[str, Any] | None = None
    vehicle: dict[str, Any] | None = None
    citation: str | None = None
    url: str | None = None


class BenchmarkSourceSeries(BaseModel):
    id: str
    name: str
    has_geo: bool
    time: list[float]
    velocity: list[float]
    lat: list[float] | None = None
    lon: list[float] | None = None
    position: list[float] | None = None
    slope: list[float] | None = None
    acceleration: list[float] | None = None
    a_lat: list[float] | None = None
    zones: list[dict[str, Any]] | None = None
    stats: dict[str, Any] | None = None
    source: str | None = None
    added_at: str | None = None
    zone_split: dict[str, Any] | None = None
    citation: str | None = None
    url: str | None = None
    license: str | None = None

class BenchmarkRunRequest(BaseModel):
    profile: ConsolidatedProfile | None = None
    reference_id: str
    align: Literal["time", "distance"] = "time"
    simulation_id: str | None = None


class BenchmarkKpis(BaseModel):
    rmse_v: float
    mae_v: float
    bias_v: float
    delta_duration_pct: float
    delta_duration_s: float
    delta_distance_pct: float
    delta_distance_m: float
    stops_gen: int
    stops_ref: int
    stop_time_ratio_gen: float
    stop_time_ratio_ref: float
    mean_abs_accel_gen: float
    mean_abs_accel_ref: float
    p95_abs_accel_gen: float
    p95_abs_accel_ref: float


class BenchmarkRunResponse(BaseModel):
    reference_id: str
    align: Literal["time", "distance"] = "time"
    ref_has_geo: bool
    times: list[float]
    v_gen: list[float]
    v_ref: list[float]
    s_gen: list[float] | None = None
    s_ref: list[float] | None = None
    lat_ref: list[float] | None = None
    lon_ref: list[float] | None = None
    kpis: BenchmarkKpis
    recalibration_hints: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Calibration — POST /calibrate/n90
# ---------------------------------------------------------------------------


class CalibrationArm(BaseModel):
    """Single grid combination + its scored KPIs against the AVL N90 reference."""

    id: str
    driver_profile: DriverProfile = DriverProfile.NORMAL
    speed_factor: float
    a_max: float
    b_comf: float
    T: float
    T_h: float
    s0: float
    jerk_max: float
    jerk_brake_max: float
    rmse_v: float
    rmse_a: float
    delta_duration_s: float
    delta_duration_pct: float
    delta_distance_m: float
    p95_abs_jerk: float | None = None
    score: float


class CalibrationRecommendation(BaseModel):
    """Recommended DriverPhysics — plug-and-play into IDMSolver overrides."""

    driver_profile: DriverProfile
    speed_factor: float
    a_max: float
    b_comf: float
    T: float
    T_h: float
    s0: float
    jerk_max: float
    jerk_brake_max: float


class N90CalibrateRequest(BaseModel):
    corridor_id: str = Field(
        ...,
        description=(
            "Corridor UUID returned by /corridor/build. Should match the N90 "
            "geometry Bourg-St-Maurice → Albertville."
        ),
    )
    reference_id: str = Field(
        "avl_n90_bcb",
        description="Benchmark corpus id for the AVL N90 reference (default avl_n90_bcb).",
    )
    driver_profile: DriverProfile = DriverProfile.NORMAL
    seed: int | None = 42
    # Weights: score = RMSE_v + λ·RMSE_a + μ·|ΔT_total_pct|
    lambda_a: float = Field(
        4.0, ge=0.0, le=50.0, description="Weight on RMSE_a (m/s²) in the objective."
    )
    mu_dt: float = Field(
        0.08,
        ge=0.0,
        le=5.0,
        description="Weight on |ΔT_total_pct| in the objective.",
    )
    # Grid overrides — omit to use compact defaults (per-axis max 32).
    a_max_grid: list[float] | None = Field(default=None, max_length=32)
    b_comf_grid: list[float] | None = Field(default=None, max_length=32)
    T_grid: list[float] | None = Field(default=None, max_length=32)
    T_h_grid: list[float] | None = Field(default=None, max_length=32)
    s0_grid: list[float] | None = Field(default=None, max_length=32)
    jerk_max_grid: list[float] | None = Field(default=None, max_length=32)
    jerk_brake_max_grid: list[float] | None = Field(default=None, max_length=32)
    speed_factor_grid: list[float] | None = Field(default=None, max_length=32)
    max_arms: int = Field(
        96,
        ge=1,
        le=1024,
        description="Cap on grid combinations evaluated (safety net for CPU).",
    )


class N90CalibrateResponse(BaseModel):
    reference_id: str
    corridor_id: str
    n_arms: int
    best_arm_id: str
    recommended: CalibrationRecommendation
    arms: list[CalibrationArm]
    written_json: str
    written_markdown: str
    warnings: list[str] = Field(default_factory=list)
