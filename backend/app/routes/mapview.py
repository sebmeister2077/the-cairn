"""POST /api/map-render — Render a Vintage Story map .db file as a PNG image."""

import os
import tempfile

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

from ..auth import verify_api_key
from ..config import settings
from ..rate_limiter import check_rate_limit
from ..core.mapdb import render_map_png_from_path, get_map_stats_from_path

router = APIRouter()


async def _save_upload_to_temp(db_file: UploadFile) -> str:
    """Stream uploaded DB file to a temp path with a hard size cap."""
    fd, tmp_path = tempfile.mkstemp(suffix=".db")
    try:
        total_size = 0
        with os.fdopen(fd, "wb") as f:
            while True:
                chunk = await db_file.read(8 * 1024 * 1024)
                if not chunk:
                    break
                total_size += len(chunk)
                if total_size > settings.MAX_UPLOAD_SIZE:
                    raise ValueError("File too large")
                f.write(chunk)

        if total_size == 0:
            raise ValueError("Empty upload")

        return tmp_path
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


@router.post("/map-stats")
async def map_stats(
    db_file: UploadFile = File(..., description=".db map database file"),
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)
    tmp_path = None
    try:
        tmp_path = await _save_upload_to_temp(db_file)
        stats = get_map_stats_from_path(tmp_path)
    except ValueError as e:
        detail = "File too large" if str(e) == "File too large" else str(e)
        status = 413 if detail == "File too large" else 400
        return JSONResponse(status_code=status, content={"detail": detail})
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return stats


@router.post("/map-render")
async def map_render(
    db_file: UploadFile = File(..., description=".db map database file"),
    max_dimension: int = Form(4096, description="Max output dimension in pixels"),
    fast_preview: bool = Form(False, description="Use low-detail fast preview rendering"),
    api_key: str = Depends(verify_api_key),
):
    check_rate_limit(api_key)
    tmp_path = None
    clamped_dim = max(256, min(max_dimension, settings.MAP_RENDER_MAX_DIM))

    try:
        tmp_path = await _save_upload_to_temp(db_file)
        png_bytes = render_map_png_from_path(
            tmp_path,
            max_dimension=clamped_dim,
            fast_preview=fast_preview,
        )
    except ValueError as e:
        detail = "File too large" if str(e) == "File too large" else str(e)
        status = 413 if detail == "File too large" else 400
        return JSONResponse(status_code=status, content={"detail": detail})
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Content-Disposition": "inline; filename=map.png"},
    )
