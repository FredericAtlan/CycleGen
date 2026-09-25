"""CycleGen FastAPI entrypoint — routers wired as services land."""

from __future__ import annotations

import os
import secrets
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

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

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

_cors_kwargs: dict = {
    "allow_origins": _origins,
    "allow_credentials": True,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
}
# Localhost regex only outside production (or when explicitly enabled).
_cors_localhost_regex = os.getenv(
    "CYCLEGEN_CORS_LOCALHOST_REGEX",
    "1" if os.getenv("ENV", "dev") != "production" else "0",
)
if _cors_localhost_regex == "1":
    _cors_kwargs["allow_origin_regex"] = (
        r"https?://(localhost|127\.0\.0\.1)(:\d+)?"
    )

app.add_middleware(CORSMiddleware, **_cors_kwargs)

# Optional API key (P2). When unset, all routes remain open (local engineering tool).
_API_KEY = (os.getenv("CYCLEGEN_API_KEY") or "").strip()


def _extract_api_key(request: Request) -> str:
    header = (request.headers.get("X-API-Key") or "").strip()
    if header:
        return header
    auth = (request.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    # Browser WebSocket cannot set custom headers reliably — allow ?api_key=.
    return (request.query_params.get("api_key") or "").strip()


class ApiKeyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        if not _API_KEY:
            return await call_next(request)
        path = request.url.path
        if path == "/health" or not path.startswith("/api"):
            return await call_next(request)
        provided = _extract_api_key(request)
        if (
            not provided
            or len(provided) != len(_API_KEY)
            or not secrets.compare_digest(provided, _API_KEY)
        ):
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing or invalid API key"},
            )
        return await call_next(request)


if _API_KEY:
    app.add_middleware(ApiKeyMiddleware)


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
