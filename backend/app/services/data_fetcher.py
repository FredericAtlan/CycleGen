"""Spatial data acquisition — OSRM route, Overpass signals, Open-Elevation."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from typing import Any
from urllib.parse import urlencode

import httpx
import polyline
from fastapi import HTTPException

from app.models.schemas import (
    CycleGenWarning,
    LatLon,
    OsmSpeedLimitSegment,
    ResolvedViaPoint,
    RoadStructureSegment,
    RouteAnalyzeResponse,
    RoutingProfile,
    TrafficSignalPoint,
)
from app.services.osm_maxspeed import parse_osm_maxspeed_kmh, snap_kmh_to_posted
from app.services.routing import (
    HereRouter,
    MapboxRouter,
    OsrmRouter,
    analyze_multi_router,
)
from app.services.secrets_redact import redact_secrets

logger = logging.getLogger(__name__)

OSRM_BASE_URL = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org").rstrip("/")
OVERPASS_URL = os.getenv("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
OPEN_ELEVATION_URL = os.getenv(
    "OPEN_ELEVATION_URL", "https://api.open-elevation.com/api/v1/lookup"
)
OPEN_METEO_ELEVATION_URL = os.getenv(
    "OPEN_METEO_ELEVATION_URL", "https://api.open-meteo.com/v1/elevation"
)

BBOX_PADDING_DEG = 0.01
ELEVATION_CHUNK_SIZE = 100
# Long mountain routes (e.g. Großglockner ~3k pts) thrash public elevation APIs → 429 → flat z.
# Sample a dense-enough spine then interpolate back to full resolution.
ELEVATION_MAX_SAMPLES = int(os.getenv("CYCLEGEN_ELEVATION_MAX_SAMPLES", "250"))
ELEVATION_CHUNK_PAUSE_S = float(os.getenv("CYCLEGEN_ELEVATION_CHUNK_PAUSE_S", "0.12"))
ELEVATION_RETRIES = int(os.getenv("CYCLEGEN_ELEVATION_RETRIES", "3"))
OPENTOPODATA_URL = os.getenv(
    "OPENTOPODATA_URL", "https://api.opentopodata.org/v1/aster30m"
)
HTTP_TIMEOUT = httpx.Timeout(45.0, connect=10.0)
# Soft Overpass / optional geospatial: fail fast (no multi-minute curl hang).
SOFT_HTTP_TIMEOUT = httpx.Timeout(18.0, connect=6.0)
CURL_MAX_TIME_S = int(os.getenv("CYCLEGEN_CURL_MAX_TIME_S", "20"))
OSM_MAXSPEED_ENABLED = os.getenv("CYCLEGEN_OSM_MAXSPEED", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)


def _elevation_sample_indices(n: int, max_samples: int) -> list[int]:
    """Uniform indices including endpoints; preserves order without duplicates."""
    if n <= 0:
        return []
    if n <= max_samples:
        return list(range(n))
    idxs = {0, n - 1}
    for k in range(1, max_samples - 1):
        idxs.add(round(k * (n - 1) / (max_samples - 1)))
    return sorted(idxs)


def _interpolate_elevations(
    n: int, sample_idx: list[int], sample_z: list[float]
) -> list[float]:
    """Linear interpolate sparse elevation samples onto full point index."""
    if n <= 0:
        return []
    if not sample_idx or len(sample_idx) != len(sample_z):
        return [0.0] * n
    if len(sample_idx) == 1:
        return [float(sample_z[0])] * n
    out = [0.0] * n
    j = 0
    for i in range(n):
        while j + 1 < len(sample_idx) and sample_idx[j + 1] < i:
            j += 1
        i0 = sample_idx[j]
        if j + 1 >= len(sample_idx) or i0 >= i:
            out[i] = float(sample_z[j])
            continue
        i1 = sample_idx[j + 1]
        z0 = float(sample_z[j])
        z1 = float(sample_z[j + 1])
        t = (i - i0) / (i1 - i0) if i1 != i0 else 0.0
        out[i] = z0 + t * (z1 - z0)
    return out


async def _curl_json(
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    data: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
) -> Any:
    """Fallback HTTPS via system curl (works when OpenSSL/httpx handshake fails)."""
    curl = shutil.which("curl")
    if not curl:
        raise RuntimeError("curl not found for HTTPS fallback")
    full_url = f"{url}?{urlencode(params)}" if params else url
    cmd = [
        curl,
        "-sS",
        "--max-time",
        str(CURL_MAX_TIME_S),
        "-X",
        method.upper(),
        "-H",
        "Accept: application/json",
        "-H",
        "User-Agent: CycleGen/0.1 (engineering; contact=local)",
        full_url,
    ]
    if json_body is not None:
        cmd.extend(["-H", "Content-Type: application/json", "--data-binary", json.dumps(json_body)])
    elif data is not None:
        cmd.extend(["-H", "Content-Type: application/x-www-form-urlencoded", "--data-binary", urlencode(data)])
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(stderr.decode() or f"curl exit {proc.returncode}")
    return json.loads(stdout.decode())


class SpatialDataAcquisition:
    """Fetch geometry, speeds, elevations and traffic signals for a driving route."""

    def __init__(
        self,
        *,
        osrm_base_url: str | None = None,
        overpass_url: str | None = None,
        open_elevation_url: str | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.osrm_base_url = (osrm_base_url or OSRM_BASE_URL).rstrip("/")
        self.overpass_url = overpass_url or OVERPASS_URL
        self.open_elevation_url = open_elevation_url or OPEN_ELEVATION_URL
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> SpatialDataAcquisition:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=HTTP_TIMEOUT)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("SpatialDataAcquisition requires an active httpx client")
        return self._client

    async def _request_json(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        data: dict[str, str] | None = None,
        json_body: dict[str, Any] | None = None,
        service: str = "upstream",
        soft_fail: bool = False,
        timeout: httpx.Timeout | None = None,
    ) -> Any:
        from app.services.connection_log import normalize_provider, record

        provider = normalize_provider(service)
        t0 = time.perf_counter()
        record(
            provider=provider,
            phase="start",
            method=method,
            url=url,
            params=params,
            detail=f"Connexion {provider}",
        )
        req_timeout = timeout or (SOFT_HTTP_TIMEOUT if soft_fail else HTTP_TIMEOUT)
        try:
            resp = await self.client.request(
                method,
                url,
                params=params,
                data=data,
                json=json_body,
                headers={"User-Agent": "CycleGen/0.1 (engineering; contact=local)"},
                timeout=req_timeout,
            )
            if resp.status_code in {406, 429, 502, 503, 504}:
                raise httpx.RequestError(
                    f"HTTP {resp.status_code}",
                    request=resp.request,
                )
            resp.raise_for_status()
            data_out = resp.json()
            elapsed = int((time.perf_counter() - t0) * 1000)
            size_hint = None
            try:
                raw = resp.content
                if raw is not None:
                    n = len(raw)
                    size_hint = (
                        f"{n} o"
                        if n < 1024
                        else f"{n / 1024:.1f} Ko"
                        if n < 1024 * 1024
                        else f"{n / (1024 * 1024):.2f} Mo"
                    )
            except Exception:  # noqa: BLE001
                size_hint = None
            record(
                provider=provider,
                phase="ok",
                method=method,
                url=url,
                params=params,
                status=resp.status_code,
                duration_ms=elapsed,
                bytes_hint=size_hint,
                detail=f"Réponse {provider}",
            )
            return data_out
        except httpx.HTTPStatusError as exc:
            elapsed = int((time.perf_counter() - t0) * 1000)
            record(
                provider=provider,
                phase="error",
                method=method,
                url=url,
                params=params,
                status=exc.response.status_code,
                duration_ms=elapsed,
                detail=f"HTTP {exc.response.status_code}",
            )
            if soft_fail:
                logger.warning("%s soft-fail HTTP %s", service, exc.response.status_code)
                return {}
            raise HTTPException(
                status_code=502,
                detail=f"{service} upstream error: HTTP {exc.response.status_code}",
            ) from exc
        except (httpx.RequestError, ValueError) as exc:
            # Soft optional services: never chain into curl (can hang minutes).
            if soft_fail:
                elapsed = int((time.perf_counter() - t0) * 1000)
                record(
                    provider=provider,
                    phase="error",
                    method=method,
                    url=url,
                    params=params,
                    duration_ms=elapsed,
                    detail=f"soft-fail {type(exc).__name__}",
                )
                logger.warning(
                    "%s soft-fail (%s) — skipping curl fallback",
                    service,
                    type(exc).__name__,
                )
                return {}
            logger.warning("%s httpx failed (%s); trying curl fallback", service, type(exc).__name__)
            record(
                provider=provider,
                phase="info",
                method=method,
                url=url,
                params=params,
                detail="httpx échec → fallback curl",
            )
            try:
                data_out = await _curl_json(
                    method, url, params=params, data=data, json_body=json_body
                )
                elapsed = int((time.perf_counter() - t0) * 1000)
                record(
                    provider=provider,
                    phase="ok",
                    method=method,
                    url=url,
                    params=params,
                    status="curl",
                    duration_ms=elapsed,
                    detail=f"Réponse {provider} (curl)",
                )
                return data_out
            except Exception as curl_exc:  # noqa: BLE001
                elapsed = int((time.perf_counter() - t0) * 1000)
                record(
                    provider=provider,
                    phase="error",
                    method=method,
                    url=url,
                    params=params,
                    duration_ms=elapsed,
                    detail=(
                        f"{redact_secrets(exc)} (curl: {redact_secrets(curl_exc)})"
                    ),
                )
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"{service} request failed: "
                        f"{redact_secrets(exc)} (curl: {redact_secrets(curl_exc)})"
                    ),
                ) from curl_exc

    async def get_route_data(
        self,
        lat_a: float,
        lon_a: float,
        lat_b: float,
        lon_b: float,
        *,
        vias: list[tuple[float, float]] | None = None,
        via_meta: list[ResolvedViaPoint] | None = None,
        origin_label: str | None = None,
        destination_label: str | None = None,
        depart_at=None,
        a_y_mps2: float = 2.5,
        routing_profile: RoutingProfile | str | None = None,
        routing_profiles: list[RoutingProfile | str] | None = None,
    ) -> RouteAnalyzeResponse:
        from datetime import datetime, timezone

        owns = self._client is None
        if owns:
            self._client = httpx.AsyncClient(timeout=HTTP_TIMEOUT)
        from app.services.connection_log import (
            begin_connection_log,
            clear_connection_log,
            get_connection_log,
            record,
        )

        begin_connection_log()
        try:
            if depart_at is None:
                depart_at = datetime.now(timezone.utc)

            def _normalize_profiles(
                explicit: list[RoutingProfile | str] | None,
                singular: RoutingProfile | str | None,
            ) -> list[RoutingProfile]:
                seen: set[RoutingProfile] = set()
                out: list[RoutingProfile] = []
                candidates: list[RoutingProfile | str] = []
                if explicit:
                    candidates.extend(explicit)
                if singular is not None:
                    candidates.append(singular)
                for raw in candidates:
                    if raw is None:
                        continue
                    prof: RoutingProfile
                    if isinstance(raw, RoutingProfile):
                        prof = raw
                    else:
                        try:
                            prof = RoutingProfile(raw)
                        except ValueError:
                            continue
                    if prof in seen:
                        continue
                    seen.add(prof)
                    out.append(prof)
                return out

            profiles = _normalize_profiles(routing_profiles, routing_profile)
            if profiles:
                record(
                    provider="CycleGen",
                    phase="info",
                    detail=(
                        "Routeurs demandés : "
                        + " → ".join(p.value for p in profiles)
                    ),
                )
            else:
                record(
                    provider="CycleGen",
                    phase="info",
                    detail="Aucun routeur UI — chaîne défaut HERE → Mapbox → OSRM",
                )

            multi = await analyze_multi_router(
                start=(lat_a, lon_a),
                end=(lat_b, lon_b),
                vias=vias,
                depart_at=depart_at,
                requested_profiles=profiles or None,
                client=self.client,
                request_json=self._request_json,
                osrm_base_url=self.osrm_base_url,
            )
            traffic = multi.primary

            coords = [[p.lat, p.lon] for p in traffic.geometry]
            if not coords:
                raise HTTPException(
                    status_code=502,
                    detail="Router returned an empty route geometry",
                )

            # Guardrail: ambiguous geocodes can produce multi-hundred-km routes
            # that wedge Overpass / elevation. Reject early with a clear error.
            # Point budget must allow dense Mapbox/OSRM geometry (~10–15 m/pt):
            # e.g. 40 km ≈ 3k pts, 120 km ≈ 8–10k pts.
            max_km = float(os.getenv("CYCLEGEN_MAX_ROUTE_KM", "120"))
            max_pts = int(os.getenv("CYCLEGEN_MAX_ROUTE_POINTS", "12000"))
            if traffic.distance_m > max_km * 1000.0 or len(coords) > max_pts:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Route too long for interactive analysis "
                        f"({traffic.distance_m / 1000.0:.0f} km, {len(coords)} points). "
                        f"Limit is {max_km:.0f} km / {max_pts} points — "
                        "check that A/B resolve to the intended places "
                        "(e.g. « Richebourg, Yvelines » near Houdan)."
                    ),
                )

            bbox = self._compute_bbox(coords)
            # Parallel Overpass — soft-fail, short timeout (no curl hang).
            if OSM_MAXSPEED_ENABLED:
                signals, structures, speed_limits = await asyncio.gather(
                    self._fetch_traffic_signals(bbox),
                    self._fetch_road_structures(bbox),
                    self._fetch_osm_maxspeed(bbox),
                )
            else:
                signals, structures = await asyncio.gather(
                    self._fetch_traffic_signals(bbox),
                    self._fetch_road_structures(bbox),
                )
                speed_limits = []

            # Elevation sources: HERE if it delivered a usable Z, otherwise DEM.
            elevations_by_source: dict[str, list[float]] = {
                k: list(v) for k, v in multi.elevations_by_source.items() if v
            }
            here_elev = elevations_by_source.get("here")
            if (
                here_elev
                and len(here_elev) == len(coords)
                and any(e != 0.0 for e in here_elev)
            ):
                elevations = list(here_elev)
                elevation_source = "here"
            else:
                elevations = await self._fetch_elevations(coords)
                elevation_source = "dem"
                if any(e != 0.0 for e in elevations):
                    # Tag by the concrete provider when we know it (Open-Meteo
                    # always first in the fallback chain).
                    elevations_by_source.setdefault("open-meteo", list(elevations))

            warnings = list(multi.warnings)
            if not any(e != 0.0 for e in elevations):
                warnings.append(
                    CycleGenWarning(
                        code="elevation_flat",
                        message="Elevation unavailable or flat — slope may be unreliable.",
                        s0=0.0,
                        s1=traffic.distance_m,
                        source="elevation",
                    )
                )

            return RouteAnalyzeResponse(
                geometry=traffic.geometry,
                distance_m=traffic.distance_m,
                duration_s=traffic.duration_s,
                segment_speeds_mps=traffic.segment_speeds_legal_mps,
                segment_distances_m=traffic.segment_distances_m,
                elevations_m=elevations,
                traffic_signals=signals,
                bbox=bbox,
                origin=LatLon(lat=lat_a, lon=lon_a),
                destination=LatLon(lat=lat_b, lon=lon_b),
                origin_label=origin_label,
                destination_label=destination_label,
                via_points=list(via_meta or []),
                traffic_source=traffic.traffic_source,
                warnings=warnings,
                road_structures=structures,
                osm_speed_limits=speed_limits,
                segment_traffic_speeds_mps=traffic.segment_speeds_traffic_mps,
                depart_at=depart_at,
                elevation_source=elevation_source,
                a_y_mps2=a_y_mps2,
                routers_used=list(multi.routers_used),
                segment_speeds_by_router={
                    k: list(v) for k, v in multi.legal_by_router.items()
                },
                segment_traffic_speeds_by_router={
                    k: list(v) for k, v in multi.traffic_by_router.items()
                },
                elevations_by_source=elevations_by_source,
                router_status=dict(multi.router_status),
                connection_log=[e.to_dict() for e in get_connection_log()],
            )
        finally:
            clear_connection_log()
            if owns and self._client is not None:
                await self._client.aclose()
                self._client = None

    async def _fetch_osrm_route(
        self,
        points: list[tuple[float, float]],
    ) -> dict[str, Any]:
        if len(points) < 2:
            raise HTTPException(status_code=400, detail="At least two route points required")
        # OSRM coordinates are lon,lat
        coord_path = ";".join(f"{lon},{lat}" for lat, lon in points)
        url = f"{self.osrm_base_url}/route/v1/driving/{coord_path}"
        params = {
            "overview": "full",
            "geometries": "polyline",
            "annotations": "speed,distance",
        }
        payload = await self._request_json(
            "GET", url, params=params, service="OSRM"
        )

        code = payload.get("code")
        if code and str(code).upper() != "OK":
            raise HTTPException(
                status_code=502,
                detail=f"OSRM routing failed: {code} — {payload.get('message', '')}".strip(),
            )

        routes = payload.get("routes") or []
        if not routes:
            raise HTTPException(
                status_code=404,
                detail="No driving route found between the given points",
            )
        return routes[0]

    @staticmethod
    def _decode_geometry(route: dict[str, Any]) -> list[list[float]]:
        encoded = route.get("geometry")
        if not encoded:
            return []
        try:
            # polyline.decode → list of (lat, lon)
            decoded = polyline.decode(encoded)
        except Exception as exc:  # noqa: BLE001 — library raises varied errors
            raise HTTPException(
                status_code=502,
                detail=f"Failed to decode OSRM polyline: {exc}",
            ) from exc
        return [[float(lat), float(lon)] for lat, lon in decoded]

    @staticmethod
    def _extract_annotations(route: dict[str, Any]) -> tuple[list[float], list[float]]:
        speeds: list[float] = []
        distances: list[float] = []
        for leg in route.get("legs") or []:
            annotation = leg.get("annotation") or {}
            leg_speeds = annotation.get("speed") or []
            leg_distances = annotation.get("distance") or []
            speeds.extend(float(v) if v is not None else 0.0 for v in leg_speeds)
            distances.extend(float(v) if v is not None else 0.0 for v in leg_distances)
        return speeds, distances

    @staticmethod
    def _compute_bbox(
        coords: list[list[float]],
        padding: float = BBOX_PADDING_DEG,
    ) -> tuple[float, float, float, float]:
        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]
        south = min(lats) - padding
        north = max(lats) + padding
        west = min(lons) - padding
        east = max(lons) + padding
        return (south, west, north, east)

    async def _fetch_traffic_signals(
        self,
        bbox: tuple[float, float, float, float],
    ) -> list[TrafficSignalPoint]:
        south, west, north, east = bbox
        # Overpass bbox order: south,west,north,east
        query = (
            "[out:json][timeout:20];\n"
            f'node["highway"="traffic_signals"]({south},{west},{north},{east});\n'
            "out body;"
        )
        payload = await self._request_json(
            "POST",
            self.overpass_url,
            data={"data": query},
            service="Overpass",
            soft_fail=True,
        )

        signals: list[TrafficSignalPoint] = []
        for el in payload.get("elements") or []:
            if el.get("type") != "node":
                continue
            lat = el.get("lat")
            lon = el.get("lon")
            if lat is None or lon is None:
                continue
            signals.append(
                TrafficSignalPoint(
                    lat=float(lat),
                    lon=float(lon),
                    osm_id=int(el["id"]) if el.get("id") is not None else None,
                    highway=None,
                )
            )
        return signals

    async def _fetch_road_structures(
        self,
        bbox: tuple[float, float, float, float],
    ) -> list[RoadStructureSegment]:
        """Overpass: bridge/tunnel ways + highway class for TLS conditional logic."""
        south, west, north, east = bbox
        query = (
            "[out:json][timeout:20];\n"
            "(\n"
            f'  way["bridge"]({south},{west},{north},{east});\n'
            f'  way["tunnel"]({south},{west},{north},{east});\n'
            f'  way["highway"]({south},{west},{north},{east});\n'
            ");\n"
            "out geom;"
        )
        payload = await self._request_json(
            "POST",
            self.overpass_url,
            data={"data": query},
            service="Overpass",
            soft_fail=True,
        )
        out: list[RoadStructureSegment] = []
        for el in payload.get("elements") or []:
            if el.get("type") != "way":
                continue
            tags = el.get("tags") or {}
            geom = el.get("geometry") or []
            if len(geom) < 2:
                continue
            a, b = geom[0], geom[-1]
            hw = tags.get("highway")
            osm_id = int(el["id"]) if el.get("id") is not None else None
            if tags.get("bridge") and tags.get("bridge") not in ("no", "false"):
                out.append(
                    RoadStructureSegment(
                        kind="bridge",
                        lat0=float(a["lat"]),
                        lon0=float(a["lon"]),
                        lat1=float(b["lat"]),
                        lon1=float(b["lon"]),
                        highway=hw,
                        osm_id=osm_id,
                    )
                )
            if tags.get("tunnel") and tags.get("tunnel") not in ("no", "false"):
                out.append(
                    RoadStructureSegment(
                        kind="tunnel",
                        lat0=float(a["lat"]),
                        lon0=float(a["lon"]),
                        lat1=float(b["lat"]),
                        lon1=float(b["lon"]),
                        highway=hw,
                        osm_id=osm_id,
                    )
                )
            if hw:
                out.append(
                    RoadStructureSegment(
                        kind="highway",
                        lat0=float(a["lat"]),
                        lon0=float(a["lon"]),
                        lat1=float(b["lat"]),
                        lon1=float(b["lon"]),
                        highway=hw,
                        osm_id=osm_id,
                    )
                )
        return out

    async def _fetch_osm_maxspeed(
        self,
        bbox: tuple[float, float, float, float],
    ) -> list[OsmSpeedLimitSegment]:
        """Overpass: highway ways with posted / zone maxspeed tags."""
        south, west, north, east = bbox
        # Single compact query (maxspeed OR zone tags) — timeout 15 s server-side.
        query = (
            "[out:json][timeout:15];\n"
            "(\n"
            f'  way["highway"]["maxspeed"]({south},{west},{north},{east});\n'
            f'  way["highway"]["maxspeed:type"]({south},{west},{north},{east});\n'
            f'  way["highway"]["source:maxspeed"]({south},{west},{north},{east});\n'
            f'  way["highway"]["zone:maxspeed"]({south},{west},{north},{east});\n'
            ");\n"
            "out geom;"
        )
        payload = await self._request_json(
            "POST",
            self.overpass_url,
            data={"data": query},
            service="Overpass",
            soft_fail=True,
        )
        out: list[OsmSpeedLimitSegment] = []
        seen: set[int] = set()
        for el in payload.get("elements") or []:
            if el.get("type") != "way":
                continue
            tags = el.get("tags") or {}
            kmh = parse_osm_maxspeed_kmh(tags)
            if kmh is None:
                continue
            kmh = snap_kmh_to_posted(kmh)
            geom = el.get("geometry") or []
            if len(geom) < 2:
                continue
            osm_id = int(el["id"]) if el.get("id") is not None else None
            if osm_id is not None:
                if osm_id in seen:
                    continue
                seen.add(osm_id)
            # Densify: keep endpoints + up to 18 intermediate vertices.
            idxs = [0]
            if len(geom) > 2:
                step = max(1, (len(geom) - 1) // 18)
                idxs.extend(range(step, len(geom) - 1, step))
            idxs.append(len(geom) - 1)
            # unique ordered
            seen_i: set[int] = set()
            ordered: list[int] = []
            for i in idxs:
                if i not in seen_i:
                    seen_i.add(i)
                    ordered.append(i)
            pts = [
                LatLon(lat=float(geom[i]["lat"]), lon=float(geom[i]["lon"]))
                for i in ordered
            ]
            a, b = pts[0], pts[-1]
            out.append(
                OsmSpeedLimitSegment(
                    lat0=a.lat,
                    lon0=a.lon,
                    lat1=b.lat,
                    lon1=b.lon,
                    maxspeed_kmh=kmh,
                    highway=tags.get("highway"),
                    osm_id=osm_id,
                    geometry=pts,
                )
            )
        return out

    async def _fetch_elevations(self, coords: list[list[float]]) -> list[float]:
        """Fetch elevations; never block Analyze — fall back to flat 0.0 if APIs fail."""
        if not coords:
            return []

        n = len(coords)
        max_samples = max(16, ELEVATION_MAX_SAMPLES)
        sample_idx = _elevation_sample_indices(n, max_samples)
        sample_coords = [coords[i] for i in sample_idx]
        if len(sample_coords) < n:
            logger.info(
                "Elevation subsample %d → %d points (then interpolate)",
                n,
                len(sample_coords),
            )

        sample_z = await self._fetch_elevations_open_meteo(sample_coords)
        if sample_z is None:
            sample_z = await self._fetch_elevations_open_elevation(sample_coords)
        if sample_z is None:
            sample_z = await self._fetch_elevations_opentopodata(sample_coords)
        if sample_z is None:
            logger.warning(
                "Elevation APIs unavailable — using flat profile (0.0) for %d points",
                n,
            )
            return [0.0] * n

        if len(sample_idx) == n:
            return sample_z
        return _interpolate_elevations(n, sample_idx, sample_z)

    async def lookup_elevations(
        self, points: list[tuple[float, float]]
    ) -> list[float | None]:
        """Lookup DEM elevations for sparse lat/lon points (A/B UI, etc.).

        Returns ``None`` per point when all elevation providers fail.
        """
        if not points:
            return []
        coords = [[float(lat), float(lon)] for lat, lon in points]
        sample_z = await self._fetch_elevations_open_meteo(coords)
        if sample_z is None:
            sample_z = await self._fetch_elevations_open_elevation(coords)
        if sample_z is None:
            sample_z = await self._fetch_elevations_opentopodata(coords)
        if sample_z is None:
            return [None] * len(points)
        return [float(z) if z is not None else None for z in sample_z]

    async def _fetch_elevations_open_meteo(
        self, coords: list[list[float]]
    ) -> list[float] | None:
        for attempt in range(max(1, ELEVATION_RETRIES)):
            elevations: list[float] = []
            try:
                for i in range(0, len(coords), ELEVATION_CHUNK_SIZE):
                    if i > 0 and ELEVATION_CHUNK_PAUSE_S > 0:
                        await asyncio.sleep(ELEVATION_CHUNK_PAUSE_S)
                    chunk = coords[i : i + ELEVATION_CHUNK_SIZE]
                    params = {
                        "latitude": ",".join(f"{lat:.6f}" for lat, _ in chunk),
                        "longitude": ",".join(f"{lon:.6f}" for _, lon in chunk),
                    }
                    payload = await self._request_json(
                        "GET",
                        OPEN_METEO_ELEVATION_URL,
                        params=params,
                        service="Open-Meteo-Elevation",
                        soft_fail=True,
                    )
                    values = (
                        payload.get("elevation") if isinstance(payload, dict) else None
                    )
                    if not isinstance(values, list) or len(values) != len(chunk):
                        raise RuntimeError(
                            f"Open-Meteo elevation mismatch (expected {len(chunk)}, "
                            f"got {len(values) if isinstance(values, list) else type(values)})"
                        )
                    elevations.extend(
                        float(v) if v is not None else 0.0 for v in values
                    )
                return elevations
            except Exception as exc:  # noqa: BLE001
                wait = 0.6 * (2**attempt)
                logger.warning(
                    "Open-Meteo elevation attempt %d/%d failed: %s — retry in %.1fs",
                    attempt + 1,
                    ELEVATION_RETRIES,
                    exc,
                    wait,
                )
                if attempt + 1 >= ELEVATION_RETRIES:
                    return None
                await asyncio.sleep(wait)
        return None

    async def _fetch_elevations_open_elevation(
        self, coords: list[list[float]]
    ) -> list[float] | None:
        for attempt in range(max(1, ELEVATION_RETRIES)):
            elevations: list[float] = []
            try:
                for i in range(0, len(coords), ELEVATION_CHUNK_SIZE):
                    if i > 0 and ELEVATION_CHUNK_PAUSE_S > 0:
                        await asyncio.sleep(ELEVATION_CHUNK_PAUSE_S)
                    chunk = coords[i : i + ELEVATION_CHUNK_SIZE]
                    locations = [
                        {"latitude": lat, "longitude": lon} for lat, lon in chunk
                    ]
                    payload = await self._request_json(
                        "POST",
                        self.open_elevation_url,
                        json_body={"locations": locations},
                        service="Open-Elevation",
                        soft_fail=True,
                    )
                    results = (
                        payload.get("results") if isinstance(payload, dict) else None
                    )
                    if not isinstance(results, list) or len(results) != len(chunk):
                        raise RuntimeError(
                            f"Open-Elevation mismatch (expected {len(chunk)}, "
                            f"got {len(results) if isinstance(results, list) else type(results)})"
                        )
                    for item in results:
                        elev = item.get("elevation") if isinstance(item, dict) else None
                        elevations.append(float(elev) if elev is not None else 0.0)
                return elevations
            except Exception as exc:  # noqa: BLE001
                wait = 0.6 * (2**attempt)
                logger.warning(
                    "Open-Elevation attempt %d/%d failed: %s — retry in %.1fs",
                    attempt + 1,
                    ELEVATION_RETRIES,
                    exc,
                    wait,
                )
                if attempt + 1 >= ELEVATION_RETRIES:
                    return None
                await asyncio.sleep(wait)
        return None

    async def _fetch_elevations_opentopodata(
        self, coords: list[list[float]]
    ) -> list[float] | None:
        """ASTER 30m DEM via OpenTopoData (100 locs/req) — alpine fallback."""
        chunk_size = 100
        for attempt in range(max(1, ELEVATION_RETRIES)):
            elevations: list[float] = []
            try:
                for i in range(0, len(coords), chunk_size):
                    if i > 0 and ELEVATION_CHUNK_PAUSE_S > 0:
                        await asyncio.sleep(ELEVATION_CHUNK_PAUSE_S)
                    chunk = coords[i : i + chunk_size]
                    locations = "|".join(f"{lat:.6f},{lon:.6f}" for lat, lon in chunk)
                    payload = await self._request_json(
                        "GET",
                        OPENTOPODATA_URL,
                        params={"locations": locations},
                        service="OpenTopoData",
                        soft_fail=True,
                    )
                    results = (
                        payload.get("results") if isinstance(payload, dict) else None
                    )
                    if not isinstance(results, list) or len(results) != len(chunk):
                        raise RuntimeError(
                            f"OpenTopoData mismatch (expected {len(chunk)}, "
                            f"got {len(results) if isinstance(results, list) else type(results)})"
                        )
                    for item in results:
                        elev = item.get("elevation") if isinstance(item, dict) else None
                        elevations.append(float(elev) if elev is not None else 0.0)
                return elevations
            except Exception as exc:  # noqa: BLE001
                wait = 0.8 * (2**attempt)
                logger.warning(
                    "OpenTopoData attempt %d/%d failed: %s — retry in %.1fs",
                    attempt + 1,
                    ELEVATION_RETRIES,
                    exc,
                    wait,
                )
                if attempt + 1 >= ELEVATION_RETRIES:
                    return None
                await asyncio.sleep(wait)
        return None
