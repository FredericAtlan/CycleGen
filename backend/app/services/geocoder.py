"""Nominatim geocoding (OpenStreetMap) — address → lat/lon."""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import HTTPException

from app.services.data_fetcher import _curl_json

logger = logging.getLogger(__name__)

NOMINATIM_URL = os.getenv(
    "NOMINATIM_URL", "https://nominatim.openstreetmap.org/search"
).rstrip("/")


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math

    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


async def geocode_address(
    query: str,
    *,
    client: httpx.AsyncClient | None = None,
    near_lat: float | None = None,
    near_lon: float | None = None,
    countrycodes: str | None = None,
) -> dict[str, Any]:
    """Return {lat, lon, display_name} for the best Nominatim match.

    When ``near_lat``/``near_lon`` are set, prefer candidates close to that
    point (fixes ambiguous place names like « Richebourg » near Houdan).
    """
    q = (query or "").strip()
    if len(q) < 2:
        raise HTTPException(status_code=400, detail="Address query is too short")

    cc = (countrycodes if countrycodes is not None else os.getenv("GEOCODE_COUNTRYCODES", "fr")).strip()
    params: dict[str, str] = {
        "q": q,
        "format": "json",
        "limit": "5",
        "addressdetails": "0",
    }
    if cc:
        params["countrycodes"] = cc
    if near_lat is not None and near_lon is not None:
        # Prefer results near the sibling endpoint (~±0.6° ≈ 50–60 km).
        pad = 0.6
        params["viewbox"] = (
            f"{near_lon - pad},{near_lat + pad},{near_lon + pad},{near_lat - pad}"
        )
        params["bounded"] = "0"

    headers = {
        "User-Agent": "CycleGen/0.1 (engineering; contact=local)",
        "Accept": "application/json",
    }

    owns = client is None
    if owns:
        client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
    assert client is not None
    try:
        try:
            resp = await client.get(NOMINATIM_URL, params=params, headers=headers)
            if resp.status_code in {406, 429, 502, 503, 504}:
                raise httpx.RequestError(f"HTTP {resp.status_code}", request=resp.request)
            resp.raise_for_status()
            payload = resp.json()
        except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            logger.warning("Nominatim httpx failed (%s); curl fallback", exc)
            payload = await _curl_json("GET", NOMINATIM_URL, params=params)
    finally:
        if owns:
            await client.aclose()

    if not isinstance(payload, list) or not payload:
        raise HTTPException(
            status_code=404,
            detail=f"No location found for address: {q}",
        )

    scored: list[tuple[float, dict[str, Any]]] = []
    for hit in payload:
        try:
            lat = float(hit["lat"])
            lon = float(hit["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if near_lat is not None and near_lon is not None:
            score = _haversine_km(near_lat, near_lon, lat, lon)
        else:
            # Without bias, keep Nominatim order (importance-ish).
            score = float(len(scored))
        scored.append((score, hit))

    if not scored:
        raise HTTPException(
            status_code=502,
            detail="Geocoder returned an invalid coordinate payload",
        )

    scored.sort(key=lambda x: x[0])
    hit = scored[0][1]
    lat = float(hit["lat"])
    lon = float(hit["lon"])
    display = str(hit.get("display_name") or q)
    return {"lat": lat, "lon": lon, "display_name": display, "query": q}
