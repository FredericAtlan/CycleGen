"""Geocoder: Photon first, Nominatim fallback; clean errors otherwise."""

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


def test_photon_answers_first_without_calling_nominatim(monkeypatch):
    monkeypatch.setattr(geocoder, "_curl_json", _curl_html)
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.host)
        assert "github.com" in req.headers["user-agent"]
        return httpx.Response(200, json=PHOTON_OK)

    async def run():
        async with _client(handler) as c:
            return await geocoder.geocode_address("Houdan", client=c)

    hit = asyncio.run(run())
    assert seen == ["photon.komoot.io"]
    assert hit["lat"] == pytest.approx(48.7903)
    assert "78550" in hit["display_name"]


def test_nominatim_fallback_when_photon_down(monkeypatch):
    monkeypatch.setattr(geocoder, "_curl_json", _curl_html)
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.host)
        if "photon" in req.url.host:
            return httpx.Response(502, text="bad gateway")
        return httpx.Response(200, json=[{"lat": "48.79", "lon": "1.60", "display_name": "Houdan, France"}])

    async def run():
        async with _client(handler) as c:
            return await geocoder.geocode_address("Houdan", client=c)

    hit = asyncio.run(run())
    assert seen == ["photon.komoot.io", "nominatim.openstreetmap.org"]
    assert hit["display_name"] == "Houdan, France"


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
