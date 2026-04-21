"""FastAPI application entry point."""

from contextlib import asynccontextmanager
import logging
from time import perf_counter

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .auth import verify_api_key_info
from .config import settings
from .core.database import init_db, ensure_schema, close_db
from .routes import extract, import_wp, delete, commands, mapview
from .routes import contribute_r2 as contribute
from .routes import tops_map_r2 as tops_map
from .routes import admin


logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    startup_started = perf_counter()
    logger.info("Startup begin")

    # Startup: initialise Supabase connection pool + schema
    step_started = perf_counter()
    init_db()
    logger.info("Startup step init_db completed in %.3fs", perf_counter() - step_started)

    step_started = perf_counter()
    ensure_schema()
    logger.info("Startup step ensure_schema completed in %.3fs", perf_counter() - step_started)
    logger.info("Startup complete in %.3fs", perf_counter() - startup_started)

    try:
        yield
    finally:
        shutdown_started = perf_counter()
        close_db()
        logger.info("Shutdown close_db completed in %.3fs", perf_counter() - shutdown_started)


app = FastAPI(
    title="Vintage Story Waypoint Tools",
    version="1.0.0",
    description="Web API for extracting, importing, deleting, and generating commands for Vintage Story waypoints.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_origin_regex=settings.ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(extract.router, prefix="/api")
app.include_router(import_wp.router, prefix="/api")
app.include_router(delete.router, prefix="/api")
app.include_router(commands.router, prefix="/api")
app.include_router(mapview.router, prefix="/api")
app.include_router(tops_map.router, prefix="/api")
app.include_router(contribute.router, prefix="/api")
app.include_router(admin.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/me")
async def me(info: dict = Depends(verify_api_key_info)):
    """Return capabilities for the currently authenticated API key."""
    can_contribute = info.get("permissions") == "contribute"
    return {
        "is_admin": bool(info.get("is_admin")),
        "can_contribute": can_contribute,
    }
