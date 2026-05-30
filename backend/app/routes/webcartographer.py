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
from fastapi.responses import JSONResponse


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["webcartographer"])

_KIND_TO_PATH: dict[str, str] = {
    "translocators": "data/geojson/translocators.geojson",
    "landmarks": "data/geojson/landmarks.geojson",
}

_EMPTY_FEATURE_COLLECTION = {"type": "FeatureCollection", "features": []}
_REQUEST_TIMEOUT_S = 20.0
_MAX_BYTES = 32 * 1024 * 1024  # 32 MiB cap on upstream response.


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
        headers={"Accept": "application/geo+json, application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_S) as resp:  # noqa: S310 - scheme validated above
            raw = resp.read(_MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # Many WC hosts simply don't export one of the files; treat as empty.
            return JSONResponse(
                _EMPTY_FEATURE_COLLECTION,
                headers={"Cache-Control": "public, max-age=300"},
            )
        logger.warning("WC geojson fetch failed: %s %s", e.code, target)
        raise HTTPException(status_code=502, detail=f"upstream returned {e.code}")
    except urllib.error.URLError as e:
        logger.warning("WC geojson fetch error: %s %s", e.reason, target)
        raise HTTPException(status_code=502, detail="upstream unreachable")
    except TimeoutError:
        raise HTTPException(status_code=504, detail="upstream timed out")

    if len(raw) > _MAX_BYTES:
        raise HTTPException(status_code=502, detail="upstream geojson too large")

    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=502, detail="upstream returned invalid JSON")

    return JSONResponse(data, headers={"Cache-Control": "public, max-age=1800"})
