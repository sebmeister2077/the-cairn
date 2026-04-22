"""GET /api/tops-map-* — Serve the global server map from R2 (globalservermap.db)."""

import os
import tempfile

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.mapdb import render_map_png, get_map_stats
from ..core import r2_storage, database as db

router = APIRouter()


def _read_db() -> bytes:
    """Download globalservermap.db from R2."""
    return r2_storage.download_bytes(r2_storage.COMBINED_DB_KEY)


@router.get("/tops-map-stats")
async def tops_map_stats(api_key: str = Depends(verify_api_key)):
    check_rate_limit(api_key)
    stats = db.get_tops_map_stats()
    if not stats:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "TOPS map stats cache is not ready. Run pregenerate_tops_map_cache.py first.",
            },
        )
    cache_key = r2_storage.tops_map_cache_key(r2_storage.TOPS_MAP_CACHE_DIM)
    signed_url = r2_storage.generate_presigned_download_url(
        cache_key,
        expires_seconds=24 * 60 * 60,
    )
    return {**stats, "image_signed_url": signed_url or None}


@router.get("/tops-map-render")
async def tops_map_render(
    max_dimension: int = 4096,
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)
    clamped_dim = max(256, min(max_dimension, 16384))

    # For the default viewer image, prefer serving a pre-generated cached PNG.
    if clamped_dim == r2_storage.TOPS_MAP_CACHE_DIM:
        cache_key = r2_storage.tops_map_cache_key(clamped_dim)
        if r2_storage.object_exists(cache_key):
            cached_png = r2_storage.download_bytes(cache_key)
            return Response(
                content=cached_png,
                media_type="image/png",
                headers={
                    "Content-Disposition": "inline; filename=tops-map.png",
                    "X-Map-Cache": "hit",
                },
            )

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
        headers={
            "Content-Disposition": "inline; filename=tops-map.png",
            "X-Map-Cache": "miss",
        },
    )
