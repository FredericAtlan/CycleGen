"""Route acquisition API — geocode + POST /route/analyze."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    ElevationLookupRequest,
    ElevationLookupResponse,
    GeocodeRequest,
    GeocodeResponse,
    ResolvedViaPoint,
    RouteAnalyzeRequest,
    RouteAnalyzeResponse,
    WaypointSpec,
)
from app.services.data_fetcher import SpatialDataAcquisition
from app.services.geocoder import geocode_address

router = APIRouter(tags=["route"])

MAX_VIA = 20


async def _elevation_for(lat: float, lon: float) -> float | None:
    async with SpatialDataAcquisition() as acquisition:
        zs = await acquisition.lookup_elevations([(lat, lon)])
    return zs[0] if zs else None


async def _resolve_endpoint(
    *,
    lat: float | None,
    lon: float | None,
    address: str | None,
    role: str,
    near: tuple[float, float] | None = None,
) -> tuple[float, float, str]:
    if lat is not None and lon is not None:
        label = (address or "").strip() or f"{lat:.5f}, {lon:.5f}"
        return float(lat), float(lon), label
    if address and address.strip():
        hit = await geocode_address(
            address.strip(),
            near_lat=near[0] if near else None,
            near_lon=near[1] if near else None,
        )
        return float(hit["lat"]), float(hit["lon"]), str(hit["display_name"])
    raise HTTPException(
        status_code=400,
        detail=f"{role}: provide coordinates or an address",
    )


async def _resolve_waypoint(wp: WaypointSpec, index: int) -> ResolvedViaPoint:
    if wp.lat is not None and wp.lon is not None:
        label = (wp.label or wp.address or f"Stop {index + 1}").strip()
        return ResolvedViaPoint(
            index=index,
            lat=float(wp.lat),
            lon=float(wp.lon),
            label=label,
            stop_duration_s=float(wp.stop_duration_s or 0.0),
        )
    if wp.address and wp.address.strip():
        hit = await geocode_address(wp.address.strip())
        label = (wp.label or hit["display_name"]).strip()
        return ResolvedViaPoint(
            index=index,
            lat=float(hit["lat"]),
            lon=float(hit["lon"]),
            label=label,
            stop_duration_s=float(wp.stop_duration_s or 0.0),
        )
    raise HTTPException(
        status_code=400,
        detail=f"Waypoint {index + 1}: provide coordinates or an address",
    )


@router.post("/geocode", response_model=GeocodeResponse)
async def geocode(body: GeocodeRequest) -> GeocodeResponse:
    """Resolve a free-text address to coordinates (Nominatim / OSM)."""
    hit = await geocode_address(
        body.query,
        near_lat=body.near_lat,
        near_lon=body.near_lon,
    )
    lat = float(hit["lat"])
    lon = float(hit["lon"])
    elev = await _elevation_for(lat, lon)
    return GeocodeResponse(
        lat=lat,
        lon=lon,
        display_name=str(hit["display_name"]),
        query=str(hit["query"]),
        elevation_m=elev,
    )


@router.post("/elevation", response_model=ElevationLookupResponse)
async def lookup_elevation(body: ElevationLookupRequest) -> ElevationLookupResponse:
    """DEM altitude (m) for one or more lat/lon points (Open-Meteo / fallbacks)."""
    pts = [(float(p.lat), float(p.lon)) for p in body.points]
    async with SpatialDataAcquisition() as acquisition:
        zs = await acquisition.lookup_elevations(pts)
    return ElevationLookupResponse(elevations_m=zs)


@router.post("/route/analyze", response_model=RouteAnalyzeResponse)
async def analyze_route(body: RouteAnalyzeRequest) -> RouteAnalyzeResponse:
    """Fetch OSRM geometry (A → vias → B), elevations and nearby traffic signals."""
    if len(body.waypoints) > MAX_VIA:
        raise HTTPException(
            status_code=400,
            detail=f"At most {MAX_VIA} intermediate waypoints are allowed",
        )

    has_a = body.lat_a is not None and body.lon_a is not None
    has_b = body.lat_b is not None and body.lon_b is not None

    # Resolve the known endpoint first so the other address can be biased
    # (e.g. « Richebourg » near Houdan → Yvelines, not Pas-de-Calais).
    if has_b and not has_a:
        lat_b, lon_b, label_b = await _resolve_endpoint(
            lat=body.lat_b,
            lon=body.lon_b,
            address=body.address_b,
            role="Destination (B)",
        )
        lat_a, lon_a, label_a = await _resolve_endpoint(
            lat=body.lat_a,
            lon=body.lon_a,
            address=body.address_a,
            role="Departure (A)",
            near=(lat_b, lon_b),
        )
    elif has_a and not has_b:
        lat_a, lon_a, label_a = await _resolve_endpoint(
            lat=body.lat_a,
            lon=body.lon_a,
            address=body.address_a,
            role="Departure (A)",
        )
        lat_b, lon_b, label_b = await _resolve_endpoint(
            lat=body.lat_b,
            lon=body.lon_b,
            address=body.address_b,
            role="Destination (B)",
            near=(lat_a, lon_a),
        )
    else:
        # Both coords or both addresses: resolve B then bias A toward B.
        lat_b, lon_b, label_b = await _resolve_endpoint(
            lat=body.lat_b,
            lon=body.lon_b,
            address=body.address_b,
            role="Destination (B)",
        )
        lat_a, lon_a, label_a = await _resolve_endpoint(
            lat=body.lat_a,
            lon=body.lon_a,
            address=body.address_a,
            role="Departure (A)",
            near=(lat_b, lon_b),
        )

    via_meta: list[ResolvedViaPoint] = []
    vias: list[tuple[float, float]] = []
    for i, wp in enumerate(body.waypoints):
        resolved = await _resolve_waypoint(wp, i)
        via_meta.append(resolved)
        vias.append((resolved.lat, resolved.lon))

    async with SpatialDataAcquisition() as acquisition:
        return await acquisition.get_route_data(
            lat_a=lat_a,
            lon_a=lon_a,
            lat_b=lat_b,
            lon_b=lon_b,
            vias=vias,
            via_meta=via_meta,
            origin_label=label_a,
            destination_label=label_b,
            depart_at=body.depart_at,
            a_y_mps2=body.a_y_mps2,
            routing_profile=body.routing_profile,
            routing_profiles=list(body.routing_profiles or []),
        )
