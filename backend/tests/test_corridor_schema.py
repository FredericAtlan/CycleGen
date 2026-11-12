"""Pydantic bounds on SpatialCorridor and related simulate lists."""

from __future__ import annotations

import unittest

from pydantic import ValidationError

from app.models.schemas import (
    BenchmarkKpis,
    BenchmarkRunResponse,
    CalibrationRecommendation,
    ConsolidatedProfile,
    CycleGenWarning,
    DriverProfile,
    DetectedEvent,
    LatLon,
    N90CalibrateResponse,
    ScheduledStop,
    ScenarioRunResponse,
    SimulateStartRequest,
    SpatialCorridor,
    _MAX_CORRIDOR_EVENTS,
    _MAX_CORRIDOR_LIGHTS,
    _MAX_DRIVER_ZONES,
    _MAX_PROFILE_POINTS,
    _MAX_ROUTE_WARNINGS,
    _MAX_SCHEDULED_STOPS,
    _MAX_WARNING_CODE,
    _MAX_WARNING_MESSAGE,
    _MAX_WARNING_SOURCE,
)


def _corridor_payload(n: int) -> dict:
    S = [float(i) * 5.0 for i in range(n)]
    V = [20.0] * n
    return {
        "S": S,
        "V_limite": V,
        "V_envelope": V,
        "alpha": [0.0] * n,
        "S_feux": [],
        "events": [],
        "geometry": [LatLon(lat=45.0, lon=6.0).model_dump() for _ in range(n)],
    }


class TestCorridorSchema(unittest.TestCase):
    def test_spatial_corridor_accepts_max_profile_points(self) -> None:
        SpatialCorridor.model_validate(_corridor_payload(_MAX_PROFILE_POINTS))

    def test_spatial_corridor_rejects_oversized_s(self) -> None:
        with self.assertRaises(ValidationError):
            SpatialCorridor.model_validate(
                _corridor_payload(_MAX_PROFILE_POINTS + 1)
            )

    def test_spatial_corridor_rejects_too_many_events(self) -> None:
        n = 10
        payload = _corridor_payload(n)
        payload["events"] = [
            DetectedEvent(s_m=float(i), kind="speed_limit", label="x").model_dump()
            for i in range(_MAX_CORRIDOR_EVENTS + 1)
        ]
        with self.assertRaises(ValidationError):
            SpatialCorridor.model_validate(payload)

    def test_spatial_corridor_rejects_too_many_lights(self) -> None:
        n = 10
        payload = _corridor_payload(n)
        payload["S_feux"] = [float(i) for i in range(_MAX_CORRIDOR_LIGHTS + 1)]
        with self.assertRaises(ValidationError):
            SpatialCorridor.model_validate(payload)

    def test_spatial_corridor_rejects_too_many_warnings(self) -> None:
        n = 10
        payload = _corridor_payload(n)
        payload["warnings"] = [
            CycleGenWarning(code="x", message="m").model_dump()
            for _ in range(_MAX_ROUTE_WARNINGS + 1)
        ]
        with self.assertRaises(ValidationError):
            SpatialCorridor.model_validate(payload)

    def test_cycle_gen_warning_rejects_oversized_code_and_message(self) -> None:
        with self.assertRaises(ValidationError):
            CycleGenWarning(code="c" * (_MAX_WARNING_CODE + 1), message="ok")
        with self.assertRaises(ValidationError):
            CycleGenWarning(code="ok", message="m" * (_MAX_WARNING_MESSAGE + 1))

    def test_cycle_gen_warning_rejects_oversized_source(self) -> None:
        with self.assertRaises(ValidationError):
            CycleGenWarning(
                code="ok",
                message="m",
                source="s" * (_MAX_WARNING_SOURCE + 1),
            )

    def test_scenario_run_response_rejects_oversized_warning_string(self) -> None:
        with self.assertRaises(ValidationError):
            ScenarioRunResponse(
                arms=[],
                reference_id="ref",
                warnings=["w" * (_MAX_WARNING_MESSAGE + 1)],
            )

    def test_benchmark_run_response_rejects_oversized_warning_string(self) -> None:
        kpis = BenchmarkKpis(
            rmse_v=0.0,
            mae_v=0.0,
            bias_v=0.0,
            delta_duration_pct=0.0,
            delta_duration_s=0.0,
            delta_distance_pct=0.0,
            delta_distance_m=0.0,
            stops_gen=0,
            stops_ref=0,
            stop_time_ratio_gen=0.0,
            stop_time_ratio_ref=0.0,
            mean_abs_accel_gen=0.0,
            mean_abs_accel_ref=0.0,
            p95_abs_accel_gen=0.0,
            p95_abs_accel_ref=0.0,
        )
        with self.assertRaises(ValidationError):
            BenchmarkRunResponse(
                reference_id="ref",
                ref_has_geo=False,
                times=[0.0],
                v_gen=[1.0],
                v_ref=[1.0],
                kpis=kpis,
                warnings=["w" * (_MAX_WARNING_MESSAGE + 1)],
            )

    def test_n90_calibrate_response_rejects_oversized_warning_string(self) -> None:
        rec = CalibrationRecommendation(
            driver_profile=DriverProfile.NORMAL,
            speed_factor=1.0,
            a_max=1.0,
            b_comf=2.0,
            T=1.5,
            T_h=0.5,
            s0=2.0,
            jerk_max=2.0,
            jerk_brake_max=3.0,
        )
        with self.assertRaises(ValidationError):
            N90CalibrateResponse(
                reference_id="avl_n90_bcb",
                corridor_id="corr",
                n_arms=0,
                best_arm_id="a0",
                recommended=rec,
                arms=[],
                written_json="{}",
                written_markdown="#",
                warnings=["w" * (_MAX_WARNING_MESSAGE + 1)],
            )

    def test_consolidated_profile_rejects_too_many_warnings(self) -> None:
        n = 5
        with self.assertRaises(ValidationError):
            ConsolidatedProfile(
                time=[float(i) for i in range(n)],
                velocity=[1.0] * n,
                position=[float(i) for i in range(n)],
                acceleration=[0.0] * n,
                slope=[0.0] * n,
                total_duration_s=float(n - 1),
                average_speed_kmh=3.6,
                warnings=[
                    CycleGenWarning(code="x", message="m")
                    for _ in range(_MAX_ROUTE_WARNINGS + 1)
                ],
            )

    def test_spatial_corridor_rejects_too_many_scheduled_stops(self) -> None:
        n = 10
        payload = _corridor_payload(n)
        payload["scheduled_stops"] = [
            ScheduledStop(s_m=float(i), stop_duration_s=30.0, label="s").model_dump()
            for i in range(_MAX_SCHEDULED_STOPS + 1)
        ]
        with self.assertRaises(ValidationError):
            SpatialCorridor.model_validate(payload)

    def test_scheduled_stop_rejects_excessive_dwell(self) -> None:
        with self.assertRaises(ValidationError):
            ScheduledStop(s_m=100.0, stop_duration_s=7200.1, label="long")

    def test_simulate_start_rejects_too_many_driver_zones(self) -> None:
        corr = SpatialCorridor.model_validate(_corridor_payload(20))
        zones = [
            {"label": f"z{i}", "s0_m": float(i * 10), "s1_m": float(i * 10 + 5)}
            for i in range(_MAX_DRIVER_ZONES + 1)
        ]
        with self.assertRaises(ValidationError):
            SimulateStartRequest(
                corridor=corr,
                driver_zones=zones,  # type: ignore[arg-type]
            )


if __name__ == "__main__":
    unittest.main()
