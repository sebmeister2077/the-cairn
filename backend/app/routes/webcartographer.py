"""Proxy endpoint for fetching GeoJSON files from WebCartographer hosts.

WebCartographer's integrated webserver serves PNG tiles + geojson exports
(``${baseUrl}/data/geojson/translocators.geojson`` and
``landmarks.geojson``) but does not send ``Access-Control-Allow-Origin``
headers, so the frontend can't ``fetch()`` them cross-origin. PNG tiles
still load via ``<img>`` (which bypasses CORS), but the geojson must come
through here so the browser sees our own permissive CORS response.

This endpoint blindly accepts any user-supplied http(s) base URL by design
— the WC user already picked / typed it in the map source switcher, and
we don't maintain a curated allowlist. We do sanitise scheme + netloc, cap
the response size, and only ever fetch the two well-known geojson paths.
"""

from __future__ import annotations

import base64
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["webcartographer"])

_KIND_TO_PATH: dict[str, str] = {
    "translocators": "data/geojson/translocators.geojson",
    "landmarks": "data/geojson/landmarks.geojson",
}

_EMPTY_FEATURE_COLLECTION = {"type": "FeatureCollection", "features": []}
_REQUEST_TIMEOUT_S = 20.0
_MAX_BYTES = 32 * 1024 * 1024  # 32 MiB cap on upstream response.

# WebCartographer tile pyramid bounds (must stay in sync with the frontend
# ``src/lib/tops-map-view/wc-tiles.ts`` constants). Zoom 0 is the coarsest
# (512 blocks/pixel) and zoom 9 the finest (1 block/pixel); the finest level
# has ``ceil(1_024_000 / 256) = 4000`` tiles per side. We validate against the
# finest level's bound at every zoom — a cheap over-approximation that keeps
# the proxy from being used to probe arbitrary upstream paths.
_TILE_MAX_ZOOM = 9
_TILE_MAX_INDEX = 4000
_TILE_EXTENSIONS = {"png", "webp"}
_MAX_TILE_BYTES = 4 * 1024 * 1024  # 4 MiB cap on a single tile.
# Max tiles the batch endpoint will fetch in one request. The sailboat route
# planner prefetches a square block of tiles around each search frontier, so a
# 5×5 (=25) block fits comfortably; the cap bounds upstream fan-out / memory.
_TILE_BATCH_MAX = 64
# Upstream tiles are fetched concurrently (urllib is blocking) to collapse many
# round-trips into one batch response. Keep the fan-out modest per request.
_TILE_BATCH_CONCURRENCY = 8
_TILE_CONTENT_TYPES = {"png": "image/png", "webp": "image/webp"}
# WC hosts sit behind Cloudflare / generic WAFs that 403/502 the default
# ``Python-urllib/<ver>`` user agent. Mimic a real browser so the upstream
# treats us like any other client — we're acting as a CORS proxy on the
# user's behalf, not as a scraper.
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CairnMapProxy/1.0"
)


@router.get("/webcartographer/geojson")
def fetch_webcartographer_geojson(
    base_url: str = Query(..., min_length=1, max_length=500),
    kind: Literal["translocators", "landmarks"] = Query(...),
) -> JSONResponse:
    parsed = urllib.parse.urlparse(base_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="invalid base_url")

    base = f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"
    target = f"{base}/{_KIND_TO_PATH[kind]}"

    req = urllib.request.Request(
        target,
        headers={
            "Accept": "application/geo+json, application/json",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": _USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_S) as resp:  # noqa: S310 - scheme validated above
            raw = resp.read(_MAX_BYTES + 1)
            upstream_last_modified = resp.headers.get("Last-Modified")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # Many WC hosts simply don't export one of the files; treat as empty.
            return JSONResponse(
                _EMPTY_FEATURE_COLLECTION,
                headers={"Cache-Control": "public, max-age=300"},
            )
        logger.warning("WC geojson fetch failed: HTTP %s for %s", e.code, target)
        raise HTTPException(status_code=502, detail=f"upstream returned {e.code}")
    except urllib.error.URLError as e:
        logger.warning("WC geojson fetch error: %r for %s", e.reason, target)
        raise HTTPException(status_code=502, detail="upstream unreachable")
    except TimeoutError:
        raise HTTPException(status_code=504, detail="upstream timed out")
    except Exception as e:  # noqa: BLE001 - we explicitly want to log + 502 the fallthrough
        logger.exception("WC geojson fetch unexpected error for %s: %s", target, e)
        raise HTTPException(status_code=502, detail="upstream fetch failed")

    if len(raw) > _MAX_BYTES:
        raise HTTPException(status_code=502, detail="upstream geojson too large")

    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=502, detail="upstream returned invalid JSON")

    # Forward upstream Last-Modified so the frontend can use it as a freshness
    # cutoff (e.g. when merging in user-contributed TLs added after the last
    # WC snapshot regen). CORS-exposed in main.py so the browser can read it.
    headers: dict[str, str] = {"Cache-Control": "public, max-age=1800"}
    if upstream_last_modified:
        headers["Last-Modified"] = upstream_last_modified
    return JSONResponse(data, headers=headers)


@router.get("/webcartographer/tile")
def fetch_webcartographer_tile(
    base_url: str = Query(..., min_length=1, max_length=500),
    z: int = Query(..., ge=0, le=_TILE_MAX_ZOOM),
    x: int = Query(..., ge=0, le=_TILE_MAX_INDEX),
    y: int = Query(..., ge=0, le=_TILE_MAX_INDEX),
    ext: str = Query("png", min_length=2, max_length=4),
) -> Response:
    """Proxy a single WebCartographer tile with permissive CORS.

    WC hosts serve ``${baseUrl}/data/world/{z}/{x}_{y}.{ext}`` without
    ``Access-Control-Allow-Origin``. ``<img>`` loads bypass CORS, but the
    sailboat route planner needs to *read back* tile pixels
    (``canvas.getImageData``) to detect water, which taints on a cross-origin
    image. Routing the bytes through here (same-origin, CORS-exposed in
    main.py) yields a readable, untainted image.

    Only the well-known ``data/world`` path is ever fetched; z/x/y are range
    validated above and ``ext`` is restricted to png/webp.
    """
    ext = ext.lower()
    if ext not in _TILE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="invalid tile extension")

    base = _resolve_base_url(base_url)
    raw, upstream_last_modified, upstream_ct = _fetch_tile_raw(base, z, x, y, ext)

    content_type = _TILE_CONTENT_TYPES.get(ext, "application/octet-stream")
    if upstream_ct and upstream_ct.startswith("image/"):
        content_type = upstream_ct
    headers = {"Cache-Control": "public, max-age=1800"}
    if upstream_last_modified:
        headers["Last-Modified"] = upstream_last_modified
    return Response(content=raw, media_type=content_type, headers=headers)


class _TileBatchRequest(BaseModel):
    base_url: str = Field(..., min_length=1, max_length=500)
    z: int = Field(..., ge=0, le=_TILE_MAX_ZOOM)
    ext: str = Field(default="png", min_length=2, max_length=4)
    # Each entry is an ``[x, y]`` tile coordinate pair.
    coords: list[tuple[int, int]] = Field(..., min_length=1, max_length=_TILE_BATCH_MAX)


@router.post("/webcartographer/tiles")
def fetch_webcartographer_tiles(payload: _TileBatchRequest) -> JSONResponse:
    """Proxy many WebCartographer tiles in one request with permissive CORS.

    The sailboat route planner prefetches a square block of tiles around each
    search frontier; fetching them one HTTP round-trip at a time dominates the
    wall-clock cost. This endpoint accepts a batch of ``[x, y]`` coordinates,
    fetches the upstream tiles concurrently, and returns them base64-encoded in
    a single JSON response:

    ``{"tiles": [{"x", "y", "found", "data"?, "error"?}, ...]}``

    ``found: false`` with no ``error`` means the upstream returned 404 (a
    genuinely empty pyramid cell → "no data"); ``error: true`` means the fetch
    failed for another reason, so the client can fall back to an individual
    retry rather than treating the tile as empty.
    """
    ext = payload.ext.lower()
    if ext not in _TILE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="invalid tile extension")

    base = _resolve_base_url(payload.base_url)

    # Validate ranges + dedupe so a repeated coord doesn't trigger a duplicate
    # upstream fetch.
    coords: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for pair in payload.coords:
        x, y = int(pair[0]), int(pair[1])
        if not (0 <= x <= _TILE_MAX_INDEX and 0 <= y <= _TILE_MAX_INDEX):
            raise HTTPException(status_code=400, detail="tile coordinate out of range")
        key = (x, y)
        if key in seen:
            continue
        seen.add(key)
        coords.append(key)

    def _work(xy: tuple[int, int]) -> dict[str, object]:
        x, y = xy
        try:
            raw, _lm, _ct = _fetch_tile_raw(base, payload.z, x, y, ext)
        except HTTPException as he:
            if he.status_code == 404:
                return {"x": x, "y": y, "found": False}
            return {"x": x, "y": y, "found": False, "error": True}
        return {
            "x": x,
            "y": y,
            "found": True,
            "data": base64.b64encode(raw).decode("ascii"),
        }

    workers = max(1, min(_TILE_BATCH_CONCURRENCY, len(coords)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        tiles = list(pool.map(_work, coords))

    return JSONResponse({"tiles": tiles}, headers={"Cache-Control": "public, max-age=1800"})


def _resolve_base_url(base_url: str) -> str:
    """Validate a user-supplied base URL and normalise it to ``scheme://netloc/path``."""
    parsed = urllib.parse.urlparse(base_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="invalid base_url")
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"


def _fetch_tile_raw(
    base: str, z: int, x: int, y: int, ext: str
) -> tuple[bytes, str | None, str | None]:
    """Fetch one upstream tile's bytes. Raises ``HTTPException`` on any failure
    (404 → status 404, which callers may translate into a "no data" marker)."""
    target = f"{base}/data/world/{z}/{x}_{y}.{ext}"
    req = urllib.request.Request(
        target,
        headers={
            "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": _USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_S) as resp:  # noqa: S310 - scheme validated above
            raw = resp.read(_MAX_TILE_BYTES + 1)
            upstream_last_modified = resp.headers.get("Last-Modified")
            upstream_ct = resp.headers.get("Content-Type")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # Sparse WC pyramids have empty cells everywhere; surface the 404
            # so the frontend treats the tile as "no data / not water".
            raise HTTPException(status_code=404, detail="tile not found")
        logger.warning("WC tile fetch failed: HTTP %s for %s", e.code, target)
        raise HTTPException(status_code=502, detail=f"upstream returned {e.code}")
    except urllib.error.URLError as e:
        logger.warning("WC tile fetch error: %r for %s", e.reason, target)
        raise HTTPException(status_code=502, detail="upstream unreachable")
    except TimeoutError:
        raise HTTPException(status_code=504, detail="upstream timed out")
    except Exception as e:  # noqa: BLE001 - log + 502 the fallthrough
        logger.exception("WC tile fetch unexpected error for %s: %s", target, e)
        raise HTTPException(status_code=502, detail="upstream fetch failed")

    if len(raw) > _MAX_TILE_BYTES:
        raise HTTPException(status_code=502, detail="upstream tile too large")

    return raw, upstream_last_modified, upstream_ct
