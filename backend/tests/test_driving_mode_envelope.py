"""Envelope driving-mode flags (legal / traffic / global Vmax)."""

from __future__ import annotations

from app.models.schemas import LatLon, RouteAnalyzeResponse
from app.services.spatial_processor import build_spatial_corridor


def _toy_route(n: int = 20) -> RouteAnalyzeResponse:
    geom = [LatLon(lat=45.62 + i * 0.001, lon=6.77 - i * 0.001) for i in range(n)]
    segs = [50.0] * (n - 1)
    legal = [50.0 / 3.6] * (n - 1)  # 50 km/h
    traffic = [30.0 / 3.6] * (n - 1)  # congested
    elev = [800.0 + i * 0.5 for i in range(n)]
    return RouteAnalyzeResponse(
        geometry=geom,
        distance_m=sum(segs),
        duration_s=100.0,
        segment_speeds_mps=legal,
        segment_distances_m=segs,
        elevations_m=elev,
        traffic_signals=[],
        bbox=(45.6, 6.7, 45.7, 6.8),
        segment_traffic_speeds_mps=traffic,
        traffic_source="test",
        elevation_source="here",
    )


def test_envelope_respects_global_max_and_disables_legal():
    route = _toy_route()
    c = build_spatial_corridor(
        route,
        enable_speed_limits=False,
        global_max_speed_kmh=40.0,
        include_traffic_in_envelope=False,
        a_y_mps2=2.5,
    )
    assert c.V_envelope
    # Without legal, cap at 40 km/h (plus curve) — must not exceed ~40
    assert max(c.V_envelope) <= 40.0 / 3.6 + 0.5


def test_envelope_excludes_traffic_when_flag_false():
    route = _toy_route()
    with_traffic = build_spatial_corridor(
        route,
        enable_speed_limits=True,
        global_max_speed_kmh=130.0,
        include_traffic_in_envelope=True,
        a_y_mps2=2.5,
    )
    without = build_spatial_corridor(
        route,
        enable_speed_limits=True,
        global_max_speed_kmh=130.0,
        include_traffic_in_envelope=False,
        a_y_mps2=2.5,
    )
    # With congestion (30) in min, envelope should be slower on average
    assert sum(with_traffic.V_envelope) < sum(without.V_envelope)
