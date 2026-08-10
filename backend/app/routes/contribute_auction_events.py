"""Auction contribution ingest — VsClayProxy → private R2 + rebuild trigger.

POST /api/contribute-auction-events — a client-side VsClayProxy pushes its FULL
cumulative ``auction-events.jsonl`` (one collapsed record per AuctionId). The
server is the only holder of R2 credentials: it authenticates the contributor,
pins the source to the configured game server, drops implausible records, stores
the (filtered) file verbatim as one private object ``auction/raw/<key_id>.jsonl.gz``,
and signals the debounced rebuild that recomputes + publishes the public data.

Wire contract (produced by the proxy's ``AuctionContributor.cs``):

* ``POST``; body is the UTF-8 JSONL contribution, **gzipped** on the wire with
  ``Content-Encoding: gzip`` and ``Content-Type: application/x-ndjson``.
* Headers:
    - ``X-API-Key``    — identifies the contributor key (must be an enabled,
      non-revoked auction contributor).
    - ``X-Timestamp``  — unix seconds; rejected if too far from server time.
    - ``X-Signature``  — ``sha256=<hex>`` = HMAC-SHA256(key's secret,
      ``f"{ts}." + rawJsonl``) over the **uncompressed** bytes. The secret is
      per-key and secret; a public value (upstream host / server id) is NEVER
      used as the key.
    - ``X-Snapshot-Id`` — opaque nonce; replays within the skew window are
      rejected.
    - ``X-Upstream-Host`` — the game server the proxy is in front of; must match
      the pinned host when pinning is configured.
    - ``X-Server-Fingerprint`` — optional JSON describing the observed server
      (stored for audit).
"""

from __future__ import annotations

import gzip
import hashlib
import hmac
import io
import json
import logging
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request

from ..config import settings
from ..core import auction_raw_store, database
from ..core import auction_rebuild

logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["contribute-auction-events"])

_VALID_STATES = {"", "Active", "Sold", "SoldRetrieved", "Expired"}

# Bounded nonce cache (X-Snapshot-Id) for replay protection within the skew
# window. Timestamp-skew already caps how long a captured request stays valid;
# this stops re-posting the exact same signed body inside that window.
_SEEN_NONCES: "OrderedDict[str, float]" = OrderedDict()
_NONCE_CACHE_MAX = 4096


def _remember_nonce(nonce: str) -> bool:
    """Return False if the nonce was already seen (a replay); True otherwise."""
    now = time.time()
    ttl = 2 * max(1, settings.AUCTION_WEBHOOK_MAX_SKEW_SECONDS)
    # Evict expired entries lazily.
    for key in list(_SEEN_NONCES.keys()):
        if now - _SEEN_NONCES[key] > ttl:
            _SEEN_NONCES.pop(key, None)
        else:
            break
    if nonce in _SEEN_NONCES:
        return False
    _SEEN_NONCES[nonce] = now
    while len(_SEEN_NONCES) > _NONCE_CACHE_MAX:
        _SEEN_NONCES.popitem(last=False)
    return True


def _resolve_contributor(x_api_key: Optional[str]) -> Dict[str, Any]:
    if not x_api_key:
        raise HTTPException(status_code=401, detail="missing X-API-Key")
    row = database.get_api_key(x_api_key)
    if not row or row.get("revoked"):
        raise HTTPException(status_code=401, detail="invalid API key")
    if not row.get("auction_contributor"):
        raise HTTPException(
            status_code=403, detail="key is not an auction contributor"
        )
    if not (row.get("auction_hmac_secret") or "").strip():
        raise HTTPException(
            status_code=403, detail="contributor key has no signing secret configured"
        )
    return row


def _verify_signature(
    raw_jsonl: bytes,
    secret: str,
    x_timestamp: Optional[str],
    x_signature: Optional[str],
    x_snapshot_id: Optional[str],
) -> None:
    if not x_timestamp or not x_signature:
        raise HTTPException(status_code=401, detail="missing X-Timestamp / X-Signature")
    try:
        ts = int(x_timestamp)
    except ValueError:
        raise HTTPException(status_code=401, detail="invalid X-Timestamp")
    if abs(int(time.time()) - ts) > settings.AUCTION_WEBHOOK_MAX_SKEW_SECONDS:
        raise HTTPException(status_code=401, detail="stale X-Timestamp")

    provided = x_signature.split("=", 1)[1] if "=" in x_signature else x_signature
    signed = x_timestamp.encode("utf-8") + b"." + raw_jsonl
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided.lower(), expected):
        raise HTTPException(status_code=401, detail="bad signature")

    if x_snapshot_id and not _remember_nonce(x_snapshot_id):
        raise HTTPException(status_code=401, detail="replayed X-Snapshot-Id")


def _check_upstream(x_upstream_host: Optional[str]) -> None:
    pinned = (settings.AUCTION_PINNED_UPSTREAM_HOST or "").strip().lower()
    if not pinned:
        return
    got = (x_upstream_host or "").strip().lower()
    if got and got != pinned:
        raise HTTPException(
            status_code=422,
            detail=f"upstream host {got!r} is not the pinned server {pinned!r}",
        )


async def _read_body(request: Request, content_encoding: Optional[str]) -> bytes:
    raw = await request.body()
    if content_encoding and "gzip" in content_encoding.lower():
        try:
            raw = gzip.decompress(raw)
        except (OSError, EOFError, gzip.BadGzipFile) as exc:
            raise HTTPException(status_code=400, detail=f"invalid gzip body: {exc}")
    if len(raw) > settings.AUCTION_WEBHOOK_MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="contribution body too large")
    return raw


def _plausible(rec: Dict[str, Any]) -> bool:
    """Cheap sanity gate anchored to the pinned world; drops obvious garbage."""
    if not isinstance(rec, dict) or not isinstance(rec.get("AuctionId"), int):
        return False
    if rec.get("State") not in _VALID_STATES:
        return False
    price = rec.get("Price")
    if price is not None and (not isinstance(price, (int, float)) or price < 0):
        return False
    cap = settings.AUCTION_MAX_WORLD_COORD
    for k in ("SrcX", "SrcZ", "DstX", "DstZ"):
        v = rec.get(k)
        if v is not None and (not isinstance(v, (int, float)) or abs(v) > cap):
            return False
    item = rec.get("Item")
    if item is not None:
        if not isinstance(item, dict):
            return False
        ss = item.get("StackSize")
        if ss is not None and (not isinstance(ss, (int, float)) or ss < 0):
            return False
    return True


@router.post("/contribute-auction-events")
async def receive_auction_events(
    request: Request,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    x_timestamp: Optional[str] = Header(default=None, alias="X-Timestamp"),
    x_signature: Optional[str] = Header(default=None, alias="X-Signature"),
    x_snapshot_id: Optional[str] = Header(default=None, alias="X-Snapshot-Id"),
    x_upstream_host: Optional[str] = Header(default=None, alias="X-Upstream-Host"),
    x_server_fingerprint: Optional[str] = Header(
        default=None, alias="X-Server-Fingerprint"
    ),
    content_encoding: Optional[str] = Header(default=None, alias="Content-Encoding"),
) -> Dict[str, Any]:
    """Ingest one contributor's full auction-events file; trigger a rebuild."""
    row = _resolve_contributor(x_api_key)
    raw_jsonl = await _read_body(request, content_encoding)
    _verify_signature(
        raw_jsonl, row["auction_hmac_secret"], x_timestamp, x_signature, x_snapshot_id
    )
    _check_upstream(x_upstream_host)

    received = 0
    accepted: List[Dict[str, Any]] = []
    for line in raw_jsonl.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        received += 1
        try:
            rec = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if _plausible(rec):
            accepted.append(rec)

    if not accepted:
        raise HTTPException(status_code=422, detail="no plausible records in contribution")

    fingerprint: Optional[dict] = None
    if x_server_fingerprint:
        try:
            fingerprint = json.loads(x_server_fingerprint)
        except (json.JSONDecodeError, ValueError):
            fingerprint = {"raw": x_server_fingerprint[:256]}
    if x_upstream_host:
        fingerprint = {**(fingerprint or {}), "upstreamHost": x_upstream_host}

    # Store the filtered contribution as one gzipped private object.
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        for rec in accepted:
            gz.write((json.dumps(rec, separators=(",", ":")) + "\n").encode("utf-8"))
    gz_bytes = buf.getvalue()

    key_id = str(row["id"])
    auction_raw_store.put_raw(key_id, gz_bytes)
    try:
        database.update_auction_source_stats(
            key_id,
            id_count=len(accepted),
            size_bytes=len(gz_bytes),
            fingerprint=fingerprint,
        )
    except Exception as exc:  # noqa: BLE001 — telemetry must not fail ingest
        logger.warning("[auction-ingest] stat update failed (non-fatal): %s", exc)

    auction_rebuild.request_rebuild()
    logger.info(
        "[auction-ingest] key=%s label=%s received=%d accepted=%d rejected=%d bytes=%d",
        key_id,
        row.get("auction_label") or row.get("name") or "-",
        received,
        len(accepted),
        received - len(accepted),
        len(gz_bytes),
    )
    return {
        "status": "ok",
        "received": received,
        "accepted": len(accepted),
        "rejected": received - len(accepted),
        "id_count": len(accepted),
    }
