"""Geocoder: Nominatim rate-limited → Photon fallback; clean errors otherwise."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from app.services import geocoder

PHOTON_OK = {
    "features": [
        {
            "geometry": {"coordinates": [-0.5, 40.0]},
            "properties": {"name": "Houdan", "countrycode": "ES"},
        },
        {
            "geometry": {"coordinates": [1.6006, 48.7903]},
            "properties": {"name": "Houdan", "postcode": "78550", "countrycode": "FR", "country": "France"},
        },
    ]
}


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _no_throttle(monkeypatch):
    monkeypatch.setattr(geocoder, "_geocode_last_mono", 0.0)
    monkeypatch.setattr(geocoder, "_GEOCODE_MIN_INTERVAL_S", 0.0)


def _curl_html(*_a, **_k):
    async def boom():
        raise RuntimeError("curl: non-JSON response")

    return boom()


def test_photon_fallback_when_nominatim_rate_limited(monkeypatch):
    monkeypatch.setattr(geocoder, "_curl_json", _curl_html)
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.host)
        assert "github.com" in req.headers["user-agent"]
        if "nominatim" in req.url.host:
            return httpx.Response(429, text="<html>Too many requests</html>")
        return httpx.Response(200, json=PHOTON_OK)

    async def run():
        async with _client(handler) as c:
            return await geocoder.geocode_address("Houdan", client=c)

    hit = asyncio.run(run())
    assert seen == ["nominatim.openstreetmap.org", "photon.komoot.io"]
    assert hit["lat"] == pytest.approx(48.7903)
    assert "78550" in hit["display_name"]


def test_clean_503_when_every_geocoder_fails(monkeypatch):
    monkeypatch.setattr(geocoder, "_curl_json", _curl_html)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    async def run():
        async with _client(handler) as c:
            return await geocoder.geocode_address("Houdan", client=c)

    with pytest.raises(HTTPException) as err:
        asyncio.run(run())
    assert err.value.status_code == 503


def test_throttle_waits_instead_of_rejecting(monkeypatch):
    monkeypatch.setattr(geocoder, "_GEOCODE_MIN_INTERVAL_S", 0.05)

    async def run():
        await geocoder._throttle_geocode()
        await geocoder._throttle_geocode()

    asyncio.run(run())  # second call waits ~50 ms, no 429
