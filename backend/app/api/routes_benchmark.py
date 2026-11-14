"""Benchmark & validation API — list corpus + run comparison."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    BenchmarkRunRequest,
    BenchmarkRunResponse,
    BenchmarkSourceMeta,
    BenchmarkSourceSeries,
)
from app.services.benchmark_loader import list_sources, load_reference
from app.services.benchmark_metrics import compute_comparison
from app.services.simulation_manager import get_simulation

router = APIRouter(prefix="/benchmark", tags=["Benchmark"])


@router.get("/sources", response_model=list[BenchmarkSourceMeta])
def get_benchmark_sources() -> list[BenchmarkSourceMeta]:
    try:
        return [BenchmarkSourceMeta(**s) for s in list_sources()]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/sources/{source_id}", response_model=BenchmarkSourceSeries)
def get_benchmark_source(source_id: str) -> BenchmarkSourceSeries:
    """Return a reference series without requiring a generated CycleGen profile."""
    meta = next((s for s in list_sources() if s["id"] == source_id), None)
    ref = load_reference(source_id)
    if meta is None or ref is None:
        raise HTTPException(
            status_code=404,
            detail=f"Reference '{source_id}' not found or unreadable.",
        )
    return BenchmarkSourceSeries(
        id=source_id,
        name=str(meta.get("name") or source_id),
        has_geo=bool(ref.get("has_geo")),
        time=list(ref["time"]),
        velocity=list(ref["velocity"]),
        lat=ref.get("lat"),
        lon=ref.get("lon"),
        position=ref.get("position"),
        slope=ref.get("slope"),
        acceleration=ref.get("acceleration"),
        a_lat=ref.get("a_lat"),
        zones=meta.get("zones"),
        stats=meta.get("stats"),
        source=meta.get("source"),
        added_at=meta.get("added_at"),
        zone_split=meta.get("zone_split"),
        citation=meta.get("citation"),
        url=meta.get("url"),
        license=meta.get("license"),
    )


@router.post("/run", response_model=BenchmarkRunResponse)
def run_benchmark(payload: BenchmarkRunRequest) -> BenchmarkRunResponse:
    profile = payload.profile
    if profile is None and payload.simulation_id:
        record = get_simulation(payload.simulation_id)
        if record is None or record.profile is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Simulation '{payload.simulation_id}' not found in memory "
                    "or has no profile — pass profile in the body instead."
                ),
            )
        profile = record.profile

    if profile is None:
        raise HTTPException(
            status_code=422,
            detail="Provide profile (ConsolidatedProfile) or a live simulation_id.",
        )

    ref_data = load_reference(payload.reference_id)
    if not ref_data:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Reference '{payload.reference_id}' not found or unreadable."
            ),
        )

    try:
        result = compute_comparison(
            profile.model_dump(),
            ref_data,
            align=payload.align,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Metric computation failed: {exc}"
        ) from exc

    return BenchmarkRunResponse(
        reference_id=payload.reference_id,
        align=result.get("align", payload.align),
        ref_has_geo=bool(result.get("ref_has_geo")),
        times=result["times"],
        v_gen=result["v_gen"],
        v_ref=result["v_ref"],
        s_gen=result.get("s_gen"),
        s_ref=result.get("s_ref"),
        lat_ref=result.get("lat_ref"),
        lon_ref=result.get("lon_ref"),
        kpis=result["kpis"],
        recalibration_hints=result.get("recalibration_hints") or [],
        warnings=result.get("warnings") or [],
    )
