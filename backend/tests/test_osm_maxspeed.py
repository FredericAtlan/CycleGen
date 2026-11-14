"""Tests for OSM maxspeed parsing and corridor overlay."""

from __future__ import annotations

import unittest

from app.models.schemas import LatLon, OsmSpeedLimitSegment
from app.services.osm_maxspeed import (
    overlay_osm_maxspeed,
    parse_osm_maxspeed_kmh,
)
from app.services.spatial_processor import project_point_onto_polyline_ortho


class TestParseOsmMaxspeed(unittest.TestCase):
    def test_numeric(self) -> None:
        self.assertEqual(parse_osm_maxspeed_kmh({"maxspeed": "50"}), 50.0)
        self.assertEqual(parse_osm_maxspeed_kmh({"maxspeed": "70 km/h"}), 70.0)

    def test_fr_urban_zone(self) -> None:
        self.assertEqual(
            parse_osm_maxspeed_kmh({"maxspeed": "FR:urban"}), 50.0
        )
        self.assertEqual(
            parse_osm_maxspeed_kmh({"source:maxspeed": "FR:urban"}), 50.0
        )
        self.assertEqual(
            parse_osm_maxspeed_kmh({"zone:maxspeed": "FR:30"}), None
        )
        self.assertEqual(
            parse_osm_maxspeed_kmh({"zone:maxspeed": "FR:zone30"}), 30.0
        )

    def test_multi_take_min(self) -> None:
        self.assertEqual(parse_osm_maxspeed_kmh({"maxspeed": "50;70"}), 50.0)


class TestOverlayOsmMaxspeed(unittest.TestCase):
    def test_village_plaque_lowers_legal(self) -> None:
        # Straight northbound ~1 km
        geometry = [
            LatLon(lat=45.60 + i * 0.0002, lon=6.77) for i in range(50)
        ]
        S = [i * 22.0 for i in range(50)]  # ~22 m spacing
        V_legal = [80.0 / 3.6] * 50
        # Fake OSM 50 km/h covering mid corridor (~s 400–600)
        mid = geometry[25]
        seg = OsmSpeedLimitSegment(
            lat0=geometry[20].lat,
            lon0=geometry[20].lon,
            lat1=geometry[30].lat,
            lon1=geometry[30].lon,
            maxspeed_kmh=50.0,
            geometry=[geometry[20], mid, geometry[30]],
        )
        out, warnings = overlay_osm_maxspeed(
            S,
            geometry,
            V_legal,
            [seg],
            project_fn=project_point_onto_polyline_ortho,
            max_lateral_m=35.0,
        )
        self.assertTrue(any(w.code == "osm_maxspeed_overlay" for w in warnings))
        # Mid points should be ~50 km/h
        mid_v = out[25] * 3.6
        self.assertAlmostEqual(mid_v, 50.0, delta=1.0)
        # Ends stay ~80
        self.assertGreater(out[2] * 3.6, 70.0)
        self.assertGreater(out[47] * 3.6, 70.0)


if __name__ == "__main__":
    unittest.main()
