"""CycleGen FastAPI entrypoint — routers wired as services land."""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="CycleGen API",
    description="Synthetic driving-cycle generation (OSRM → spatial corridor → SUMO/IDM)",
    version="0.1.0",
)

_origins = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
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
