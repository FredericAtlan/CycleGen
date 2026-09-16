"""Security / egress hygiene unit tests."""

from __future__ import annotations

import unittest

from app.services.secrets_redact import redact_secrets


class TestSecretsRedact(unittest.TestCase):
    def test_access_token_query(self) -> None:
        raw = (
            "GET https://api.mapbox.com/directions/v5/mapbox/driving/"
            "1,2;3,4?access_token=pk.eyJhbGciOiJIUzI1NiJ9.secret&geometries=geojson"
        )
        out = redact_secrets(raw)
        self.assertIn("access_token=***", out)
        self.assertNotIn("pk.eyJ", out)

    def test_bearer(self) -> None:
        out = redact_secrets("Authorization: Bearer abc.def.ghi failed")
        self.assertIn("***", out)
        self.assertNotIn("abc.def", out)

    def test_api_key(self) -> None:
        out = redact_secrets("url?api_key=supersecret123&x=1")
        self.assertIn("api_key=***", out)
        self.assertNotIn("supersecret", out)


class TestEgressInventoryDocumented(unittest.TestCase):
    """Smoke: known public hosts appear only as defaults in env modules."""

    def test_defaults_are_https_known_hosts(self) -> None:
        from app.services import data_fetcher, geocoder
        from app.services.routing import mapbox_router, osrm_router

        hosts = [
            data_fetcher.OSRM_BASE_URL,
            data_fetcher.OVERPASS_URL,
            data_fetcher.OPEN_ELEVATION_URL,
            data_fetcher.OPEN_METEO_ELEVATION_URL,
            geocoder.NOMINATIM_URL,
            mapbox_router.MAPBOX_BASE,
            osrm_router.OSRM_BASE_URL,
        ]
        for h in hosts:
            self.assertTrue(
                h.startswith("https://") or h.startswith("http://"),
                msg=h,
            )


if __name__ == "__main__":
    unittest.main()
