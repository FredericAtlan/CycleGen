"""Shared Pydantic DTOs — single source of truth for API contracts."""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class DriverProfile(str, Enum):
    ECO = "Eco"
    NORMAL = "Normal"
    AGRESSIF = "Agressif"


class RoutingProfile(str, Enum):
    CAR_OSRM = "Car/OSRM"


# ---------------------------------------------------------------------------
# Step 1 — Route acquisition
# ---------------------------------------------------------------------------


class RouteAnalyzeRequest(BaseModel):
    lat_a: float = Field(..., description="Departure latitude")
    lon_a: float = Field(..., description="Departure longitude")
    lat_b: float = Field(..., description="Destination latitude")
    lon_b: float = Field(..., description="Destination longitude")
    routing_profile: RoutingProfile = RoutingProfile.CAR_OSRM


class LatLon(BaseModel):
    lat: float
    lon: float


class TrafficSignalPoint(BaseModel):
    lat: float
    lon: float
    osm_id: int | None = None


class RouteAnalyzeResponse(BaseModel):
    geometry: list[LatLon]
    distance_m: float
    duration_s: float
    segment_speeds_mps: list[float]
    segment_distances_m: list[float]
    elevations_m: list[float]
    traffic_signals: list[TrafficSignalPoint]
    bbox: tuple[float, float, float, float]  # south, west, north, east


# ---------------------------------------------------------------------------
# Step 2 — Spatial corridor
# ---------------------------------------------------------------------------


class CorridorBuildRequest(BaseModel):
    """Either pass a prior route payload or reuse analyze fields inline."""

    route: RouteAnalyzeResponse
    smooth_window: int = Field(11, ge=5, description="Savitzky-Golay window (odd)")
    smooth_polyorder: int = Field(3, ge=2)


class DetectedEvent(BaseModel):
    s_m: float
    kind: Literal["traffic_signal", "speed_limit"]
    label: str
    value: float | None = None


class SpatialCorridor(BaseModel):
    S: list[float]
    V_limite: list[float]
    alpha: list[float]
    S_feux: list[float]
    events: list[DetectedEvent]
    geometry: list[LatLon]


class CorridorBuildResponse(BaseModel):
    corridor: SpatialCorridor
    corridor_id: str


# ---------------------------------------------------------------------------
# Step 3 — Simulation
# ---------------------------------------------------------------------------


class SimulateStartRequest(BaseModel):
    corridor: SpatialCorridor
    driver_profile: DriverProfile = DriverProfile.NORMAL
    engine: Literal["sumo", "idm"] = "sumo"
    seed: int | None = None


class SimulateStartResponse(BaseModel):
    simulation_id: str
    engine: Literal["sumo", "idm"]
    ws_path: str


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


class ConsolidatedProfile(BaseModel):
    time: list[float]
    velocity: list[float]
    position: list[float]
    acceleration: list[float]
    slope: list[float]
    total_duration_s: float
    average_speed_kmh: float
    status: Literal["completed", "stopped"] = "completed"


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
