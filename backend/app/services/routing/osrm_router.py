"""OSRM free-flow fallback router (no congestion envelope)."""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

import httpx
import polyline
from fastapi import HTTPException

from app.models.schemas import CycleGenWarning, LatLon
from app.services.routing.base import RouteTrafficResult, TrafficRouter

logger = logging.getLogger(__name__)

OSRM_BASE_URL = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org").rstrip("/")


class OsrmRouter(TrafficRouter):
    def __init__(
        self,
        *,
        base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        request_json=None,
    ) -> None:
        self.base_url = (base_url or OSRM_BASE_URL).rstrip("/")
        self._client = client
        self._request_json = request_json

    async def route(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        *,
        vias: list[tuple[float, float]] | None = None,
        depart_at: datetime,
    ) -> RouteTrafficResult:
        _ = depart_at  # free-flow — depart_at ignored
        points: list[tuple[float, float]] = [start]
        points.extend(vias or [])
        points.append(end)
        raw = await self._fetch(points)
        coords = self._decode(raw)
        if not coords:
            raise HTTPException(status_code=502, detail="OSRM returned empty geometry")
        legal, distances = self._annotations(raw)
        traffic = list(legal)  # free-flow: traffic ≡ legal
        return RouteTrafficResult(
            geometry=[LatLon(lat=c[0], lon=c[1]) for c in coords],
            distance_m=float(raw.get("distance") or 0.0),
            duration_s=float(raw.get("duration") or 0.0),
            segment_speeds_legal_mps=legal,
            segment_speeds_traffic_mps=traffic,
            segment_distances_m=distances,
            traffic_source="osrm_freeflow",
            warnings=[
                CycleGenWarning(
                    code="osrm_freeflow",
                    message="Traffic envelope unavailable — using OSRM free-flow speeds.",
                    s0=0.0,
                    s1=float(raw.get("distance") or 0.0),
                    source="OsrmRouter",
                )
            ],
        )

    async def _fetch(self, points: list[tuple[float, float]]) -> dict[str, Any]:
        if len(points) < 2:
            raise HTTPException(status_code=400, detail="At least two route points required")
        coord_path = ";".join(f"{lon},{lat}" for lat, lon in points)
        url = f"{self.base_url}/route/v1/driving/{coord_path}"
        params = {
            "overview": "full",
            "geometries": "polyline",
            "annotations": "speed,distance",
        }
        if self._request_json is not None:
            payload = await self._request_json("GET", url, params=params, service="OSRM")
        else:
            assert self._client is not None
            resp = await self._client.get(url, params=params)
            resp.raise_for_status()
            payload = resp.json()

        code = payload.get("code")
        if code and str(code).upper() != "OK":
            raise HTTPException(
                status_code=502,
                detail=f"OSRM routing failed: {code}",
            )
        routes = payload.get("routes") or []
        if not routes:
            raise HTTPException(status_code=404, detail="No driving route found")
        return routes[0]

    @staticmethod
    def _decode(route: dict[str, Any]) -> list[list[float]]:
        encoded = route.get("geometry")
        if not encoded:
            return []
        decoded = polyline.decode(encoded)
        return [[float(lat), float(lon)] for lat, lon in decoded]

    @staticmethod
    def _annotations(route: dict[str, Any]) -> tuple[list[float], list[float]]:
        speeds: list[float] = []
        distances: list[float] = []
        for leg in route.get("legs") or []:
            annotation = leg.get("annotation") or {}
            speeds.extend(float(v) if v is not None else 0.0 for v in (annotation.get("speed") or []))
            distances.extend(
                float(v) if v is not None else 0.0 for v in (annotation.get("distance") or [])
            )
        return speeds, distances
