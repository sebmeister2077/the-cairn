"""FastAPI application entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routes import extract, import_wp, delete, commands, mapview

app = FastAPI(
    title="Vintage Story Waypoint Tools",
    version="1.0.0",
    description="Web API for extracting, importing, deleting, and generating commands for Vintage Story waypoints.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(extract.router, prefix="/api")
app.include_router(import_wp.router, prefix="/api")
app.include_router(delete.router, prefix="/api")
app.include_router(commands.router, prefix="/api")
app.include_router(mapview.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
