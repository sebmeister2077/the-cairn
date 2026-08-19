"""Map-features contribution ingest — VSProxy → private R2 + rebuild trigger.

POST /api/contribute-map-features — a client-side VSProxy pushes its FULL
combined map export (the ``MapExportDocument``: translocators, traders, rapids,
trader claims, player claims). The server is the only holder of R2 credentials:
it authenticates the contributor, pins the source to the configured game server,
drops implausible features, stores the (filtered) document verbatim as one
private object ``map-features/raw/<key_id>.json.gz``, and signals the debounced
rebuild that union-merges every source and publishes the public per-category
files.

Auth reuses the same per-user API key as the trader-type publisher: a key is
authorised when it is the admin key or carries the ``map_features_publish``
permission — so one key per contributor covers both publishers. There is no
HMAC (parity with ``/trader-claim-types/authoritative``); the server always
recomputes the public artifacts from the stored raw and never trusts them
blindly.

Wire contract (produced by the proxy's ``MapFeaturesContributor.cs``):

* ``POST``; body is the combined ``MapExportDocument`` JSON, **gzipped** on the
  wire with ``Content-Encoding: gzip`` and ``Content-Type: application/json``.
* Headers:
    - ``X-API-Key``       — the contributor key (admin or ``map_features_publish``).
    - ``X-Upstream-Host`` — the game server the proxy is in front of; must match
      the pinned host when pinning is configured.
    - ``X-Actor-Name``    — optional label for logging.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import json
import logging
import zlib
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from ..auth import is_admin_key, verify_api_key, verify_permission
from ..config import settings
from ..core import database
from ..core import map_features_merge, map_features_raw_store, map_features_rebuild

logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["contribute-map-features"])

_PUBLISH_PERMISSION = "map_features_publish"

# Coordinate fields that may appear on a feature; any present point is bounds-checked.
_POINT_FIELDS = ("abs", "center", "min", "max")

# Caps how many requests may simultaneously hold a decoded document in RAM.
# Created lazily inside the running loop (avoids binding to the wrong loop).
_ingest_semaphore: asyncio.Semaphore | None = None


def _get_ingest_semaphore() -> asyncio.Semaphore:
    global _ingest_semaphore
    if _ingest_semaphore is None:
        _ingest_semaphore = asyncio.Semaphore(settings.MAP_FEATURES_MAX_CONCURRENT_INGEST)
    return _ingest_semaphore


def _check_upstream(x_upstream_host: Optional[str]) -> None:
    pinned = (settings.MAP_FEATURES_PINNED_UPSTREAM_HOST or "").strip().lower()
    if not pinned:
        return
    got = (x_upstream_host or "").strip().lower()
    if got and got != pinned:
        raise HTTPException(
            status_code=422,
            detail=f"upstream host {got!r} is not the pinned server {pinned!r}",
        )


def _decompress_gzip_capped(raw: bytes, cap: int) -> bytes:
    """Inflate a gzip stream incrementally, aborting once output exceeds ``cap``.

    Unlike ``gzip.decompress`` this never materialises more than ~``cap`` bytes,
    so a decompression bomb (tiny body -> multi-GB output) is rejected instead of
    OOMing the process."""
    dec = zlib.decompressobj(16 + zlib.MAX_WBITS)  # 16 => gzip header
    out = bytearray()
    to_feed = raw
    try:
        while True:
            piece = dec.decompress(to_feed, 1 << 20)
            to_feed = dec.unconsumed_tail
            if piece:
                out += piece
                if len(out) > cap:
                    raise HTTPException(status_code=413, detail="contribution body too large")
            elif not to_feed:
                break
        out += dec.flush()
    except zlib.error as exc:
        raise HTTPException(status_code=400, detail=f"invalid gzip body: {exc}")
    if len(out) > cap:
        raise HTTPException(status_code=413, detail="contribution body too large")
    return bytes(out)


async def _read_body(request: Request, content_encoding: Optional[str]) -> bytes:
    cap = settings.MAP_FEATURES_MAX_BODY_BYTES
    # Reject before buffering the whole body when the client declares its size.
    clen = request.headers.get("content-length")
    if clen and clen.isdigit() and int(clen) > cap:
        raise HTTPException(status_code=413, detail="contribution body too large")
    raw = await request.body()
    # Bound the compressed payload too (request.body() buffers it entirely).
    if len(raw) > cap:
        raise HTTPException(status_code=413, detail="contribution body too large")
    if content_encoding and "gzip" in content_encoding.lower():
        raw = _decompress_gzip_capped(raw, cap)
    return raw


def _point_ok(pt: Any, cap: float) -> bool:
    if pt is None:
        return True
    if not isinstance(pt, dict):
        return False
    for k in ("x", "y", "z"):
        v = pt.get(k)
        if v is not None and (not isinstance(v, (int, float)) or abs(v) > cap):
            return False
    return True


def _plausible(feat: Any, cap: float) -> bool:
    if not isinstance(feat, dict):
        return False
    return all(_point_ok(feat.get(f), cap) for f in _POINT_FIELDS)


def _filter_document(doc: Dict[str, Any]) -> tuple[Dict[str, Any], int, int]:
    """Keep only plausible features per category; carry envelope metadata."""
    cap = settings.MAP_FEATURES_MAX_WORLD_COORD
    out: Dict[str, Any] = {}
    for meta in ("generatedUtc", "upstream", "worldSpawn"):
        if doc.get(meta) is not None:
            out[meta] = doc[meta]
    received = accepted = 0
    for doc_key, _cat in map_features_merge.CATEGORIES:
        feats = doc.get(doc_key)
        kept: List[Dict[str, Any]] = []
        if isinstance(feats, list):
            for f in feats:
                received += 1
                if _plausible(f, cap):
                    kept.append(f)
                    accepted += 1
        out[doc_key] = kept
    return out, received, accepted


@router.post("/contribute-map-features")
async def receive_map_features(
    request: Request,
    x_api_key: str = Depends(verify_api_key),
    x_upstream_host: Optional[str] = Header(default=None, alias="X-Upstream-Host"),
    x_actor_name: Optional[str] = Header(default=None, alias="X-Actor-Name"),
    content_encoding: Optional[str] = Header(default=None, alias="Content-Encoding"),
) -> Dict[str, Any]:
    """Ingest one contributor's full combined map export; trigger a rebuild."""
    if not (is_admin_key(x_api_key) or verify_permission(x_api_key, _PUBLISH_PERMISSION)):
        raise HTTPException(
            status_code=403, detail="This API key cannot publish map features."
        )
    row = database.get_api_key(x_api_key)
    if not row or row.get("revoked"):
        raise HTTPException(status_code=401, detail="invalid API key")

    _check_upstream(x_upstream_host)

    # Serialise the memory-heavy decode/parse/re-encode so concurrent uploads
    # can't stack multiple decompressed documents in RAM at once.
    async with _get_ingest_semaphore():
        raw = await _read_body(request, content_encoding)
        try:
            doc = json.loads(raw.decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"invalid JSON body: {exc}")
        if not isinstance(doc, dict):
            raise HTTPException(status_code=422, detail="body must be a MapExportDocument object")

        filtered, received, accepted = _filter_document(doc)
        del doc, raw  # release the largest allocations before the R2 upload
        if accepted == 0:
            raise HTTPException(status_code=422, detail="no plausible features in contribution")

        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
            gz.write(json.dumps(filtered, separators=(",", ":")).encode("utf-8"))
        gz_bytes = buf.getvalue()

        key_id = str(row["id"])
        map_features_raw_store.put_raw(key_id, gz_bytes)
        map_features_rebuild.request_rebuild()

        counts = {c: len(filtered.get(k, [])) for k, c in map_features_merge.CATEGORIES}
    logger.info(
        "[map-features-ingest] key=%s actor=%s received=%d accepted=%d bytes=%d rss=%.0fMB %s",
        key_id,
        (x_actor_name or row.get("name") or "-"),
        received,
        accepted,
        len(gz_bytes),
        map_features_rebuild._rss_mb(),
        counts,
    )
    return {
        "status": "ok",
        "received": received,
        "accepted": accepted,
        "rejected": received - accepted,
        "counts": counts,
    }
