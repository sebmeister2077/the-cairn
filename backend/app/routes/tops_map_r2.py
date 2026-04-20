"""GET /api/tops-map-* — Serve the global server map from R2 (globalservermap.db)."""

import os
import tempfile

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.mapdb import render_map_png, get_map_stats
from ..core import r2_storage

router = APIRouter()


def _read_db() -> bytes:
    """Download globalservermap.db from R2."""
    return r2_storage.download_bytes(r2_storage.COMBINED_DB_KEY)


@router.get("/tops-map-stats")
async def tops_map_stats(api_key: str = Depends(verify_api_key)):
    check_rate_limit(api_key)
    try:
        db_bytes = _read_db()
        stats = get_map_stats(db_bytes)
    except FileNotFoundError as e:
        return JSONResponse(status_code=404, content={"detail": str(e)})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})
    return stats


@router.get("/tops-map-render")
async def tops_map_render(
    max_dimension: int = 4096,
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)
    clamped_dim = max(256, min(max_dimension, 16384))
    try:
        db_bytes = _read_db()
        png_bytes = render_map_png(db_bytes, max_dimension=clamped_dim)
    except FileNotFoundError as e:
        return JSONResponse(status_code=404, content={"detail": str(e)})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Content-Disposition": "inline; filename=tops-map.png"},
    )
