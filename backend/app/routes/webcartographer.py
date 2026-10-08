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

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response


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

    parsed = urllib.parse.urlparse(base_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="invalid base_url")

    base = f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"
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

    content_type = _TILE_CONTENT_TYPES.get(ext, "application/octet-stream")
    if upstream_ct and upstream_ct.startswith("image/"):
        content_type = upstream_ct
    headers = {"Cache-Control": "public, max-age=1800"}
    if upstream_last_modified:
        headers["Last-Modified"] = upstream_last_modified
    return Response(content=raw, media_type=content_type, headers=headers)
