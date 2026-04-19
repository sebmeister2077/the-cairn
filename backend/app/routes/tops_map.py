"""GET /api/tops-map-* — Serve the global server map from contribute-data/globalservermap.db."""

from pathlib import Path

from fastapi import APIRouter, Depends, Form
from fastapi.responses import JSONResponse, Response

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..config import settings
from ..core.mapdb import render_map_png, get_map_stats

router = APIRouter()

_DB_PATH = Path(settings.CONTRIBUTE_DATA_DIR) / "globalservermap.db"


def _read_db() -> bytes:
    if not _DB_PATH.exists():
        raise FileNotFoundError("Global server map database not found")
    return _DB_PATH.read_bytes()


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
