"""VsAuctionExport webhook receiver.

POST /api/contribute-auctions — ingest a full auction-house snapshot pushed
by the server-side `VsAuctionExport` mod (see
``repos\\VsAuctionExport``).

Wire contract (produced by the mod's ``Net/WebhookClient.cs``):

* Method ``POST``; body is the UTF-8 JSON :class:`SnapshotEnvelope`
  **gzipped** on the wire with ``Content-Encoding: gzip`` and
  ``Content-Type: application/json; charset=utf-8``.
* Headers:
    - ``X-Snapshot-Id``  — opaque id of this snapshot (also inside the body).
    - HMAC mode (default): ``X-Timestamp`` (unix seconds) +
      ``X-Signature: sha256=<hex>`` where the signature is
      ``HMAC-SHA256(secret, f"{timestamp}." + rawJson)`` computed over the
      **uncompressed** JSON bytes.
    - Bearer mode: ``Authorization: Bearer <token>``.
    - None mode: no auth headers (allowed only when the receiver has no
      secret/token configured and ``AUCTION_WEBHOOK_REQUIRE_AUTH`` is off).

**Local-testing behaviour:** this endpoint deliberately does **not** persist
anything to the database or R2. It validates + decodes the payload and then
`console-logs` (via the ``uvicorn.error`` logger, which prints to the
terminal) a summary plus a sample of the decoded auctions. Swap the
``_handle_snapshot`` body for real persistence once the contract is verified.
"""

from __future__ import annotations

import gzip
import hashlib
import hmac
import json
import logging
import time
from typing import Any, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import settings


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["contribute-auctions"])


# --------------------------------------------------------------------------- #
# Payload models — mirror the mod's Dto/AuctionDto.cs so validation matches
# the exact envelope the mod emits. Unknown fields are ignored (forward-compat).
# --------------------------------------------------------------------------- #
class AuctionItem(BaseModel):
    ClassId: int = 0
    Id: int = 0
    StackSize: int = 0
    Code: Optional[str] = None
    Name: Optional[str] = None
    RawHex: Optional[str] = None
    Attributes: Optional[dict[str, str]] = None


class Auction(BaseModel):
    AuctionId: int
    State: str = ""
    MoneyCollected: bool = False
    WithDelivery: bool = False
    Price: Optional[int] = None
    TraderCut: Optional[int] = None
    PostedTotalHours: Optional[float] = None
    ExpireTotalHours: Optional[float] = None
    RetrievableTotalHours: Optional[float] = None
    SellerName: Optional[str] = None
    SellerUid: Optional[str] = None
    SellerEntityId: Optional[int] = None
    BuyerName: Optional[str] = None
    BuyerUid: Optional[str] = None
    SrcX: Optional[float] = None
    SrcY: Optional[float] = None
    SrcZ: Optional[float] = None
    SrcAuctioneerEntityId: Optional[int] = None
    DstX: Optional[float] = None
    DstY: Optional[float] = None
    DstZ: Optional[float] = None
    DstAuctioneerEntityId: Optional[int] = None
    Item: Optional[AuctionItem] = None
    observedUtc: str = ""
    lastObservedUtc: str = ""


class SnapshotEnvelope(BaseModel):
    schemaVersion: int = 1
    serverId: str = ""
    snapshotUtc: str = ""
    snapshotId: str = ""
    count: int = 0
    configFingerprint: str = ""
    auctions: List[Auction] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
def _verify_auth(
    raw_json: bytes,
    x_timestamp: Optional[str],
    x_signature: Optional[str],
    authorization: Optional[str],
) -> None:
    """Authenticate the request against whichever mode is configured.

    Precedence: HMAC secret > bearer token > open (local testing). Raises
    :class:`HTTPException` (401) on any failure.
    """
    secret = settings.AUCTION_WEBHOOK_HMAC_SECRET
    bearer = settings.AUCTION_WEBHOOK_BEARER_TOKEN

    if secret:
        _verify_hmac(raw_json, x_timestamp, x_signature, secret)
        return

    if bearer:
        _verify_bearer(authorization, bearer)
        return

    # No credentials configured. Allow for local testing unless explicitly
    # locked down.
    if settings.AUCTION_WEBHOOK_REQUIRE_AUTH:
        raise HTTPException(status_code=401, detail="auction webhook auth required but not configured")
    logger.warning(
        "[auctions] accepting UNAUTHENTICATED webhook (no secret/token configured; local-test mode)"
    )


def _verify_hmac(raw_json: bytes, x_timestamp: Optional[str], x_signature: Optional[str], secret: str) -> None:
    if not x_timestamp or not x_signature:
        raise HTTPException(status_code=401, detail="missing X-Timestamp / X-Signature")

    # Reject stale timestamps to blunt replay of a captured request.
    try:
        ts = int(x_timestamp)
    except ValueError:
        raise HTTPException(status_code=401, detail="invalid X-Timestamp")
    skew = abs(int(time.time()) - ts)
    if skew > settings.AUCTION_WEBHOOK_MAX_SKEW_SECONDS:
        raise HTTPException(status_code=401, detail="stale X-Timestamp")

    # Signature format: "sha256=<hex>". The mod signs "<ts>." + rawJson.
    provided = x_signature.split("=", 1)[1] if "=" in x_signature else x_signature
    signed = x_timestamp.encode("utf-8") + b"." + raw_json
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided.lower(), expected):
        raise HTTPException(status_code=401, detail="bad signature")


def _verify_bearer(authorization: Optional[str], bearer: str) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):].strip()
    if not hmac.compare_digest(token, bearer):
        raise HTTPException(status_code=401, detail="bad bearer token")


# --------------------------------------------------------------------------- #
# Body decode
# --------------------------------------------------------------------------- #
async def _read_json_body(request: Request, content_encoding: Optional[str]) -> bytes:
    """Return the uncompressed UTF-8 JSON body, honouring gzip.

    Starlette does not transparently decompress request bodies, so we do it
    here. The uncompressed bytes are what the HMAC signature is computed over.
    """
    raw = await request.body()
    if content_encoding and "gzip" in content_encoding.lower():
        try:
            raw = gzip.decompress(raw)
        except (OSError, EOFError, gzip.BadGzipFile) as exc:
            raise HTTPException(status_code=400, detail=f"invalid gzip body: {exc}")

    if len(raw) > settings.AUCTION_WEBHOOK_MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="snapshot body too large")
    return raw


# --------------------------------------------------------------------------- #
# Handler — local test: log instead of persist
# --------------------------------------------------------------------------- #
_SAMPLE_LOG_COUNT = 5


def _handle_snapshot(envelope: SnapshotEnvelope, snapshot_id_header: Optional[str]) -> None:
    """Local-testing sink: console-log the snapshot instead of persisting it.

    Replace this with real DB / R2 persistence once the contract is verified.
    """
    auctions = envelope.auctions
    states: dict[str, int] = {}
    for a in auctions:
        states[a.State] = states.get(a.State, 0) + 1

    logger.info(
        "[auctions] ===== snapshot received (LOCAL TEST — not persisted) =====",
    )
    logger.info(
        "[auctions] serverId=%s snapshotId=%s (header=%s) snapshotUtc=%s schema=%d",
        envelope.serverId,
        envelope.snapshotId,
        snapshot_id_header or "-",
        envelope.snapshotUtc,
        envelope.schemaVersion,
    )
    logger.info(
        "[auctions] declared count=%d received=%d configFingerprint=%s",
        envelope.count,
        len(auctions),
        envelope.configFingerprint,
    )
    logger.info(
        "[auctions] state breakdown: %s",
        ", ".join(f"{k}={v}" for k, v in sorted(states.items())) or "(none)",
    )

    sample = auctions[:_SAMPLE_LOG_COUNT]
    for a in sample:
        item = a.Item
        item_desc = "-"
        if item is not None:
            item_desc = f"{item.Name or item.Code or item.Id} x{item.StackSize}"
        logger.info(
            "[auctions]   #%d state=%s price=%s seller=%s item=%s",
            a.AuctionId,
            a.State,
            a.Price if a.Price is not None else "-",
            a.SellerName or a.SellerUid or "-",
            item_desc,
        )
    if len(auctions) > _SAMPLE_LOG_COUNT:
        logger.info("[auctions]   … and %d more", len(auctions) - _SAMPLE_LOG_COUNT)

    # Full pretty dump for deep inspection during local testing. Kept at
    # DEBUG so it doesn't spam INFO logs unless the developer opts in.
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "[auctions] full payload:\n%s",
            json.dumps(envelope.model_dump(exclude_none=True), indent=2, default=str),
        )

    logger.info("[auctions] ===== end snapshot =====")


@router.post("/contribute-auctions")
async def receive_auction_snapshot(
    request: Request,
    x_snapshot_id: Optional[str] = Header(default=None, alias="X-Snapshot-Id"),
    x_timestamp: Optional[str] = Header(default=None, alias="X-Timestamp"),
    x_signature: Optional[str] = Header(default=None, alias="X-Signature"),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    content_encoding: Optional[str] = Header(default=None, alias="Content-Encoding"),
) -> dict[str, Any]:
    """Receive one auction snapshot from the VsAuctionExport mod.

    On success returns ``200`` with ``{"status": "ok", "received": <n>}``.
    In this local-testing build the payload is logged to the terminal and
    **not** written to any store.
    """
    raw_json = await _read_json_body(request, content_encoding)

    # Auth is verified against the uncompressed JSON bytes (matches the mod).
    _verify_auth(raw_json, x_timestamp, x_signature, authorization)

    try:
        payload = json.loads(raw_json.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid JSON: {exc}")

    try:
        envelope = SnapshotEnvelope.model_validate(payload)
    except Exception as exc:  # pydantic ValidationError → 422-style 400
        raise HTTPException(status_code=400, detail=f"schema validation failed: {exc}")

    _handle_snapshot(envelope, x_snapshot_id)

    return {"status": "ok", "received": len(envelope.auctions)}
