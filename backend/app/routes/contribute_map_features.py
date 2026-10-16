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

* ``POST``; body is JSON, **gzipped** on the wire with ``Content-Encoding: gzip``
  and ``Content-Type: application/json``. Two payload kinds, distinguished by a
  top-level ``type`` field:
    - **full** (``type`` absent or ``"full"``) — a complete ``MapExportDocument``.
      Treated as a REPLACE: a new base is written, the contributor's delta log is
      cleared, ``epoch`` is bumped and ``version`` reset to 0. (The only shape old
      clients send.)
    - **delta** (``type: "delta"``) — an append-only change set
      (``upserts`` + ``removals``) against the ``(baseEpoch, baseVersion)`` the
      client believes the server holds. Appended as one tiny object; a handshake
      mismatch answers ``409`` and the client resends a full snapshot. The server
      never parses the stored full document in the request path.
* Headers:
    - ``X-API-Key``       — the contributor key (admin or ``map_features_publish``).
    - ``X-Upstream-Host`` — the game server the proxy is in front of; must match
      the pinned host when pinning is configured.
    - ``X-Actor-Name``    — optional label for logging.
    - ``If-None-Match``   — the content hash AFTER applying; lets the server 304 an
      unchanged re-upload before it is decoded.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import json
import logging
import zlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from ..auth import is_admin_key, verify_api_key, verify_permission
from ..config import settings
from ..core import database
from ..core import map_features_merge, map_features_raw_store, map_features_rebuild

logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["contribute-map-features"])

_PUBLISH_PERMISSION = "map_features_publish"

# Capability flag returned by /status. Old clients ignore it; new clients use
# ``protocol >= 2`` to decide they may send append-only delta uploads instead of
# a full snapshot every time.
PROTOCOL_VERSION = 2

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


def _normalize_etag(value: Optional[str]) -> str:
    """Strip an optional weak-validator prefix and surrounding quotes/whitespace
    so ``W/"abc"`` and ``abc`` compare equal to the stored hash."""
    if not value:
        return ""
    v = value.strip()
    if v.startswith("W/"):
        v = v[2:].strip()
    return v.strip('"').strip()


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


def _filter_upserts(upserts: Any) -> tuple[Dict[str, Any], int, int]:
    """Keep only plausible upserted features per category (same bounds check as a
    full document). Removals are not bounds-checked — they only carry identity."""
    cap = settings.MAP_FEATURES_MAX_WORLD_COORD
    out: Dict[str, Any] = {}
    received = accepted = 0
    if not isinstance(upserts, dict):
        return out, 0, 0
    for doc_key, _cat in map_features_merge.CATEGORIES:
        feats = upserts.get(doc_key)
        if not isinstance(feats, list):
            continue
        kept: List[Dict[str, Any]] = []
        for f in feats:
            received += 1
            if _plausible(f, cap):
                kept.append(f)
                accepted += 1
        if kept:
            out[doc_key] = kept
    return out, received, accepted


def _sanitize_removals(removals: Any) -> tuple[Dict[str, Any], int]:
    """Pass through removal entries per category, keeping only well-formed ones.

    Feature categories carry identity objects (``{abs}`` / ``{entityId}`` /
    ``{center}``); ``playerClaims`` carries bare ``playerUid`` strings (or
    identity objects). Returns ``(removals, count)``."""
    out: Dict[str, Any] = {}
    count = 0
    if not isinstance(removals, dict):
        return out, 0
    for doc_key, _cat in map_features_merge.CATEGORIES:
        feats = removals.get(doc_key)
        if not isinstance(feats, list):
            continue
        kept: List[Any] = []
        for f in feats:
            if doc_key == "playerClaims":
                if isinstance(f, str) and f:
                    kept.append(f)
                elif isinstance(f, dict) and f.get("playerUid"):
                    kept.append(f)
            elif isinstance(f, dict):
                kept.append(f)
        if kept:
            out[doc_key] = kept
            count += len(kept)
    return out, count


@router.post("/contribute-map-features")
async def receive_map_features(
    request: Request,
    x_api_key: str = Depends(verify_api_key),
    x_upstream_host: Optional[str] = Header(default=None, alias="X-Upstream-Host"),
    x_actor_name: Optional[str] = Header(default=None, alias="X-Actor-Name"),
    content_encoding: Optional[str] = Header(default=None, alias="Content-Encoding"),
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
) -> Any:
    """Ingest one contributor's full combined map export; trigger a rebuild."""
    if not (is_admin_key(x_api_key) or verify_permission(x_api_key, _PUBLISH_PERMISSION)):
        raise HTTPException(
            status_code=403, detail="This API key cannot publish map features."
        )
    row = database.get_api_key(x_api_key)
    if not row or row.get("revoked"):
        raise HTTPException(status_code=401, detail="invalid API key")

    _check_upstream(x_upstream_host)

    key_id = str(row["id"])
    client_hash = _normalize_etag(if_none_match)
    # Fast path: the proxy re-uploads its full export ~1/min even when nothing
    # changed. If the contributor's declared content hash matches what we last
    # stored for this key, skip the whole decode/parse/re-encode — the body is
    # never read, so the big transient allocations never happen.
    if client_hash:
        prev = database.get_map_features_contrib_state(key_id)
        if prev and prev.get("hash") == client_hash:
            logger.debug(
                "[map-features-ingest] key=%s unchanged (304) hash=%s",
                key_id,
                client_hash[:12],
            )
            return Response(status_code=304)

    # Serialise the memory-heavy decode/parse/re-encode so concurrent uploads
    # can't stack multiple decompressed documents in RAM at once.
    async with _get_ingest_semaphore():
        raw = await _read_body(request, content_encoding)
        try:
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"invalid JSON body: {exc}")
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=422, detail="body must be a JSON object"
            )

        now_iso = datetime.now(timezone.utc).isoformat()
        is_delta = payload.get("type") == "delta"
        if is_delta:
            result = _ingest_delta(key_id, payload, client_hash, now_iso)
        else:
            result = _ingest_full(key_id, payload, client_hash, now_iso)
        del payload, raw  # release the largest allocations before returning

    actor = x_actor_name or row.get("name") or None
    # Don't audit the upload itself — the proxy re-uploads ~1/min so almost every
    # one changes nothing. Instead remember this contributor so a later *published*
    # change can be attributed to it (see map_features_rebuild).
    map_features_rebuild.note_contributor(key_id, actor)
    # Hand the freed parse buffers back to the OS (glibc keeps them in-arena).
    map_features_rebuild._malloc_trim()
    logger.info(
        "[map-features-ingest] key=%s actor=%s %s rss=%.0fMB",
        key_id,
        actor or "-",
        result.pop("_log", ""),
        map_features_rebuild._rss_mb(),
    )
    return result


def _as_int(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _str_or_none(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and v else None


def _ingest_full(
    key_id: str, doc: Dict[str, Any], client_hash: str, now_iso: str
) -> Dict[str, Any]:
    """Store a full combined export as the contributor's new base — a REPLACE:
    drop any existing delta stream, bump ``epoch`` and reset ``version`` to 0."""
    filtered, received, accepted = _filter_document(doc)
    if accepted == 0:
        raise HTTPException(status_code=422, detail="no plausible features in contribution")

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        gz.write(json.dumps(filtered, separators=(",", ":")).encode("utf-8"))
    gz_bytes = buf.getvalue()

    map_features_raw_store.put_raw(key_id, gz_bytes)
    map_features_raw_store.delete_deltas(key_id)
    result_hash = client_hash or _str_or_none(doc.get("resultHash"))
    epoch = database.replace_map_features_contrib_state(key_id, result_hash, now_iso)
    map_features_rebuild.request_rebuild()

    counts = {c: len(filtered.get(k, [])) for k, c in map_features_merge.CATEGORIES}
    return {
        "status": "ok",
        "type": "full",
        "received": received,
        "accepted": accepted,
        "rejected": received - accepted,
        "counts": counts,
        "protocol": PROTOCOL_VERSION,
        "epoch": epoch,
        "version": 0,
        "_log": f"full received={received} accepted={accepted} bytes={len(gz_bytes)} epoch={epoch}",
    }


def _ingest_delta(
    key_id: str, payload: Dict[str, Any], client_hash: str, now_iso: str
) -> Dict[str, Any]:
    """Append one delta object on top of the contributor's base, guarded by the
    ``(epoch, version)`` handshake. A mismatch (or no base yet) answers 409 so the
    client resends a full snapshot."""
    state = database.get_map_features_contrib_state(key_id)
    base_epoch = _as_int(payload.get("baseEpoch"))
    base_version = _as_int(payload.get("baseVersion"))
    if (
        state is None
        or base_epoch is None
        or base_version is None
        or base_epoch != state.get("epoch")
        or base_version != state.get("version")
    ):
        raise HTTPException(
            status_code=409, detail="resync required — send a full snapshot"
        )
    epoch = int(state.get("epoch") or 0)

    upserts, up_received, up_accepted = _filter_upserts(payload.get("upserts"))
    removals, rem_count = _sanitize_removals(payload.get("removals"))
    if up_accepted == 0 and rem_count == 0:
        raise HTTPException(status_code=422, detail="delta carries no changes")

    result_hash = _str_or_none(payload.get("resultHash")) or client_hash
    delta_obj: Dict[str, Any] = {"type": "delta"}
    for meta in ("generatedUtc", "upstream", "worldSpawn"):
        if payload.get(meta) is not None:
            delta_obj[meta] = payload[meta]
    if result_hash:
        delta_obj["resultHash"] = result_hash
    delta_obj["upserts"] = upserts
    delta_obj["removals"] = removals

    new_version = base_version + 1
    # Crash-safe order: write the delta object FIRST, then commit the version with
    # an optimistic update. If the commit loses the race the object is orphaned
    # (seq > committed version) and reconstruction ignores it.
    map_features_raw_store.put_delta(key_id, new_version, delta_obj)
    committed = database.bump_map_features_contrib_version(
        key_id, base_version, new_version, result_hash, now_iso, epoch
    )
    if not committed:
        raise HTTPException(
            status_code=409, detail="resync required — send a full snapshot"
        )
    map_features_rebuild.request_rebuild()

    return {
        "status": "ok",
        "type": "delta",
        "upserts": up_accepted,
        "removals": rem_count,
        "rejected": up_received - up_accepted,
        "protocol": PROTOCOL_VERSION,
        "epoch": epoch,
        "version": new_version,
        "_log": f"delta upserts={up_accepted} removals={rem_count} v={epoch}.{new_version}",
    }


@router.get("/contribute-map-features/status")
async def map_features_status(
    x_api_key: str = Depends(verify_api_key),
) -> Dict[str, Any]:
    """Report the last contribution this key successfully stored.

    A client preflights this before (re)building its export: when ``lastHash``
    already equals the client's current content hash, nothing changed and the
    upload is skipped entirely. ``lastReceivedUtc`` is the UTC time that stored
    content was last accepted (unchanged re-uploads 304 and do not advance it).

    ``protocol`` is the delta-upload capability flag (>= 2 means the server
    accepts append-only delta payloads); ``epoch``/``version`` are the handshake
    cursor a client sends its next delta against."""
    if not (is_admin_key(x_api_key) or verify_permission(x_api_key, _PUBLISH_PERMISSION)):
        raise HTTPException(
            status_code=403, detail="This API key cannot publish map features."
        )
    row = database.get_api_key(x_api_key)
    if not row or row.get("revoked"):
        raise HTTPException(status_code=401, detail="invalid API key")
    state = database.get_map_features_contrib_state(str(row["id"])) or {}
    return {
        "lastReceivedUtc": state.get("receivedUtc"),
        "lastHash": state.get("hash"),
        "protocol": PROTOCOL_VERSION,
        "epoch": int(state.get("epoch") or 0),
        "version": int(state.get("version") or 0),
    }
