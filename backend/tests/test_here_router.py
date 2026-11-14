"""Unit tests for HERE Flexible Polyline decode + maxSpeed span mapping."""

from __future__ import annotations

import flexpolyline

from app.services.routing.here_router import (
    decode_here_polyline,
    map_maxspeed_spans_to_points,
    parse_here_routes_payload,
)


def test_decode_here_polyline_with_elevation():
    encoded = flexpolyline.encode(
        [(45.62, 6.77, 800.0), (45.63, 6.76, 810.0)],
        third_dim=flexpolyline.ELEVATION,
    )
    pts = decode_here_polyline(encoded)
    assert len(pts) == 2
    assert abs(pts[0][0] - 45.62) < 1e-4
    assert abs(pts[0][2] - 800.0) < 1.0


def test_map_maxspeed_forward_fill():
    # 5 vertices; spans at 0 and 3 only
    spans = [
        {"offset": 0, "maxSpeed": 13.89},  # ~50 km/h
        {"offset": 3, "maxSpeed": 25.0},  # ~90 km/h
    ]
    out = map_maxspeed_spans_to_points(5, spans)
    assert len(out) == 5
    assert abs(out[0] - 13.89) < 1e-3
    assert abs(out[1] - 13.89) < 1e-3
    assert abs(out[2] - 13.89) < 1e-3
    assert abs(out[3] - 25.0) < 1e-3
    assert abs(out[4] - 25.0) < 1e-3


def test_parse_here_multi_section_concat():
    enc0 = flexpolyline.encode(
        [(45.62, 6.77, 800.0), (45.625, 6.76, 805.0)],
        third_dim=flexpolyline.ELEVATION,
    )
    enc1 = flexpolyline.encode(
        [(45.625, 6.76, 805.0), (45.63, 6.75, 810.0)],
        third_dim=flexpolyline.ELEVATION,
    )
    payload = {
        "routes": [
            {
                "sections": [
                    {
                        "polyline": enc0,
                        "summary": {"length": 100.0, "duration": 10.0},
                        "spans": [{"offset": 0, "maxSpeed": 20.0}],
                    },
                    {
                        "polyline": enc1,
                        "summary": {"length": 120.0, "duration": 12.0},
                        "spans": [{"offset": 0, "maxSpeed": 25.0}],
                    },
                ]
            }
        ]
    }
    result = parse_here_routes_payload(payload)
    assert result.traffic_source == "HERE/maxSpeed"
    assert len(result.geometry) == 3  # junction vertex deduped
    assert result.elevations_m is not None
    assert len(result.elevations_m) == 3
    assert result.distance_m == 220.0
    assert len(result.segment_speeds_legal_mps) == 2
    assert result.segment_speeds_traffic_mps == result.segment_speeds_legal_mps
