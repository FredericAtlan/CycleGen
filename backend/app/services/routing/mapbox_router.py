"""Mapbox Directions driving-traffic router (macroscopic congestion envelope)."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import HTTPException

from app.models.schemas import CycleGenWarning, LatLon
from app.services.routing.base import RouteTrafficResult, TrafficRouter
from app.services.routing.osrm_router import OsrmRouter
from app.services.secrets_redact import redact_secrets

logger = logging.getLogger(__name__)

MAPBOX_BASE = os.getenv(
    "MAPBOX_DIRECTIONS_URL", "https://api.mapbox.com/directions/v5"
).rstrip("/")


def _mapbox_token() -> str:
    return os.getenv("MAPBOX_ACCESS_TOKEN", "").strip()


class MapboxRouter(TrafficRouter):
    def __init__(
        self,
        *,
        token: str | None = None,
        client: httpx.AsyncClient | None = None,
        request_json=None,
        fallback: OsrmRouter | None = None,
    ) -> None:
        self.token = (token if token is not None else _mapbox_token()).strip()
        self._client = client
        self._request_json = request_json
        self._fallback = fallback

    async def route(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        *,
        vias: list[tuple[float, float]] | None = None,
        depart_at: datetime,
    ) -> RouteTrafficResult:
        # Re-read env so a token added to .env is picked up without full process recreate
        # when callers construct a fresh router; keep self.token if explicitly injected.
        token = self.token or _mapbox_token()
        if not token:
            if self._fallback is None:
                raise HTTPException(
                    status_code=503,
                    detail="MAPBOX_ACCESS_TOKEN missing and no OSRM fallback configured",
                )
            return await self._fallback.route(
                start, end, vias=vias, depart_at=depart_at
            )

        try:
            return await self._route_mapbox(
                start, end, vias=vias, depart_at=depart_at, token=token
            )
        except Exception as exc:  # noqa: BLE001
            safe = redact_secrets(exc)
            logger.warning("Mapbox routing failed (%s) — falling back to OSRM", safe)
            if self._fallback is None:
                raise
            result = await self._fallback.route(
                start, end, vias=vias, depart_at=depart_at
            )
            result.warnings.insert(
                0,
                CycleGenWarning(
                    code="mapbox_fallback",
                    message=f"Mapbox error ({safe}); using OSRM free-flow.",
                    s0=0.0,
                    s1=result.distance_m,
                    source="MapboxRouter",
                ),
            )
            return result

    async def _route_mapbox(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        *,
        vias: list[tuple[float, float]] | None,
        depart_at: datetime,
        token: str,
    ) -> RouteTrafficResult:
        points: list[tuple[float, float]] = [start]
        points.extend(vias or [])
        points.append(end)
        coord_path = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
        url = f"{MAPBOX_BASE}/mapbox/driving-traffic/{coord_path}"
        depart = depart_at if depart_at.tzinfo else depart_at.replace(tzinfo=timezone.utc)
        params = {
            "access_token": token,
            "geometries": "geojson",
            "overview": "full",
            "annotations": "duration,distance,speed,congestion",
            "steps": "false",
            "depart_at": depart.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M"),
        }
        if self._request_json is not None:
            payload = await self._request_json(
                "GET", url, params=params, service="Mapbox"
            )
        else:
            assert self._client is not None
            resp = await self._client.get(url, params=params)
            if resp.status_code >= 400:
                raise HTTPException(
                    status_code=502, detail=f"Mapbox HTTP {resp.status_code}: {resp.text[:200]}"
                )
            payload = resp.json()

        routes = payload.get("routes") or []
        if not routes:
            msg = payload.get("message") or "No Mapbox route"
            raise HTTPException(status_code=404, detail=str(msg))

        route = routes[0]
        coords = self._geojson_coords(route)
        legal, traffic, distances = self._segment_speeds(route)
        return RouteTrafficResult(
            geometry=[LatLon(lat=c[0], lon=c[1]) for c in coords],
            distance_m=float(route.get("distance") or 0.0),
            duration_s=float(route.get("duration") or 0.0),
            segment_speeds_legal_mps=legal,
            segment_speeds_traffic_mps=traffic,
            segment_distances_m=distances,
            traffic_source="mapbox_traffic",
            warnings=[],
        )

    @staticmethod
    def _geojson_coords(route: dict[str, Any]) -> list[list[float]]:
        geom = route.get("geometry") or {}
        raw = geom.get("coordinates") or []
        return [[float(lat), float(lon)] for lon, lat in raw]

    @staticmethod
    def _segment_speeds(
        route: dict[str, Any],
    ) -> tuple[list[float], list[float], list[float]]:
        legal: list[float] = []
        traffic: list[float] = []
        distances: list[float] = []

        for leg in route.get("legs") or []:
            annotation = leg.get("annotation") or {}
            dist = [float(x) for x in (annotation.get("distance") or [])]
            speed = annotation.get("speed")
            duration = annotation.get("duration") or []

            if speed and len(speed) == len(dist):
                leg_legal = [float(v) if v is not None else 0.0 for v in speed]
            else:
                leg_legal = []
                for i, d in enumerate(dist):
                    dur = float(duration[i]) if i < len(duration) and duration[i] else 0.0
                    leg_legal.append(d / dur if dur > 1e-3 else 0.0)

            leg_traffic: list[float] = []
            for i, d in enumerate(dist):
                if i < len(duration) and duration[i] and float(duration[i]) > 1e-3:
                    v_t = d / float(duration[i])
                else:
                    v_t = leg_legal[i] if i < len(leg_legal) else 0.0
                leg_traffic.append(max(0.0, float(v_t)))

            legal.extend(leg_legal)
            traffic.extend(leg_traffic)
            distances.extend(dist)

        if legal:
            traffic = [min(t, l) if l > 0 else t for t, l in zip(traffic, legal)]
        return legal, traffic, distances
