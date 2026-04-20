"""FastAPI application entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .core.database import init_db, ensure_schema, close_db
from .routes import extract, import_wp, delete, commands, mapview
from .routes import contribute_r2 as contribute
from .routes import tops_map_r2 as tops_map


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialise Supabase connection pool + schema
    init_db()
    ensure_schema()
    yield
    # Shutdown: close connections
    close_db()


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


@app.get("/api/health")
async def health():
    return {"status": "ok"}
