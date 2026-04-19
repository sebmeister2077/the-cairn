"""POST /api/map-render — Render a Vintage Story map .db file as a PNG image."""

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.mapdb import render_map_png, get_map_stats

router = APIRouter()


@router.post("/map-stats")
async def map_stats(
    db_file: UploadFile = File(..., description=".db map database file"),
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)
    db_bytes = await db_file.read()

    try:
        stats = get_map_stats(db_bytes)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    return stats


@router.post("/map-render")
async def map_render(
    db_file: UploadFile = File(..., description=".db map database file"),
    max_dimension: int = Form(4096, description="Max output dimension in pixels (capped at 16384)"),
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)
    db_bytes = await db_file.read()
    clamped_dim = max(256, min(max_dimension, 16384))

    try:
        png_bytes = render_map_png(db_bytes, max_dimension=clamped_dim)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Content-Disposition": "inline; filename=map.png"},
    )
