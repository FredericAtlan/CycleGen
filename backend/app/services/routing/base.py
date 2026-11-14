"""Abstract traffic routing interface (macroscopic speed envelope)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime

from app.models.schemas import CycleGenWarning, LatLon


@dataclass
class RouteTrafficResult:
    geometry: list[LatLon]
    distance_m: float
    duration_s: float
    segment_speeds_legal_mps: list[float]
    segment_speeds_traffic_mps: list[float]
    segment_distances_m: list[float]
    traffic_source: str
    warnings: list[CycleGenWarning] = field(default_factory=list)
    # Optional 3D elevations from router (e.g. HERE Flexible Polyline).
    elevations_m: list[float] | None = None


class TrafficRouter(ABC):
    """Macroscopic router providing geometry + legal/traffic speeds."""

    @abstractmethod
    async def route(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        *,
        vias: list[tuple[float, float]] | None = None,
        depart_at: datetime,
    ) -> RouteTrafficResult:
        ...
