"""CycleGen FastAPI entrypoint — routers wired as services land."""

from __future__ import annotations

import os
from pathlib import Path

# Load repo / backend .env before routing modules read MAPBOX_ACCESS_TOKEN.
try:
    from dotenv import load_dotenv

    _backend_dir = Path(__file__).resolve().parents[1]
    _repo_root = _backend_dir.parent
    load_dotenv(_repo_root / ".env")
    load_dotenv(_backend_dir / ".env", override=True)
except ImportError:
    pass

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="CycleGen API",
    description="Synthetic driving-cycle generation (OSRM → spatial corridor → SUMO/IDM)",
    version="0.1.0",
)

_origins = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001",
    ).split(",")
    if o.strip()
]
# Never fall back to "*" with credentials — empty env ⇒ localhost only.
if not _origins:
    _origins = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "cyclegen-api"}


# Routers are registered by domain agents (routes_route, routes_corridor, …).
try:
    from app.api.routes_route import router as route_router

    app.include_router(route_router, prefix="/api")
except ImportError:
    pass

try:
    from app.api.routes_corridor import router as corridor_router

    app.include_router(corridor_router, prefix="/api")
except ImportError:
    pass

try:
    from app.api.routes_simulate import router as simulate_router

    app.include_router(simulate_router, prefix="/api")
except ImportError:
    pass

try:
    from app.api.routes_export import router as export_router

    app.include_router(export_router, prefix="/api")
except ImportError:
    pass

try:
    from app.api.routes_benchmark import router as benchmark_router

    app.include_router(benchmark_router, prefix="/api")
except ImportError:
    pass

try:
    from app.api.routes_scenario import router as scenario_router

    app.include_router(scenario_router, prefix="/api")
except ImportError:
    pass

try:
    from app.api.routes_calibrate import router as calibrate_router

    app.include_router(calibrate_router, prefix="/api")
except ImportError:
    pass
