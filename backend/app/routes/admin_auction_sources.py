"""Admin management of auction contributor keys + manual rebuild / revoke.

All routes require the ADMIN_API_KEY via ``require_admin``. Contributor keys are
ordinary ``api_keys`` rows flagged ``auction_contributor``; each carries a
per-key ``auction_hmac_secret`` used to sign contributions. Revoking a key (and
optionally purging its private R2 object) excludes it from the next rebuild, so
its data is re-derived out of the public artifacts without touching anyone else.
"""

from __future__ import annotations

import logging
import secrets
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import require_admin
from ..core import auction_raw_store, auction_rebuild
from ..core import database as db

logger = logging.getLogger("uvicorn.error")
router = APIRouter()


class CreateSourceBody(BaseModel):
    name: str
    label: Optional[str] = None
    trusted: bool = False


class UpdateSourceBody(BaseModel):
    trusted: Optional[bool] = None
    label: Optional[str] = None
    rotate_secret: bool = False


def _public_view(row: Dict[str, Any]) -> Dict[str, Any]:
    """Row -> admin listing entry, never exposing the full signing secret."""
    secret = row.get("auction_hmac_secret") or ""
    return {
        "id": str(row.get("id")),
        "name": row.get("name"),
        "label": row.get("auction_label"),
        "trusted": bool(row.get("auction_trusted")),
        "revoked": bool(row.get("revoked")),
        "secret_hint": (secret[:4] + "…") if secret else None,
        "id_count": row.get("auction_id_count"),
        "size_bytes": row.get("auction_size_bytes"),
        "last_utc": row.get("auction_last_utc"),
        "fingerprint": row.get("auction_fingerprint"),
        "object_key": auction_raw_store.object_key(str(row.get("id"))),
    }


@router.get("/admin/auction-sources")
async def list_sources(_: str = Depends(require_admin)) -> Dict[str, Any]:
    rows = db.list_auction_contributors()
    return {"sources": [_public_view(r) for r in rows]}


@router.post("/admin/auction-sources")
async def create_source(
    body: CreateSourceBody, _: str = Depends(require_admin)
) -> Dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    key = secrets.token_urlsafe(32)
    secret = secrets.token_urlsafe(32)
    row = db.create_auction_contributor(
        key, name, secret, trusted=body.trusted, label=body.label
    )
    # The key + secret are returned ONCE here; they are not retrievable later.
    return {
        "id": str(row["id"]),
        "name": name,
        "api_key": key,
        "hmac_secret": secret,
        "trusted": body.trusted,
        "label": body.label,
        "object_key": auction_raw_store.object_key(str(row["id"])),
    }


@router.patch("/admin/auction-sources/{key_id}")
async def update_source(
    key_id: str, body: UpdateSourceBody, _: str = Depends(require_admin)
) -> Dict[str, Any]:
    row = db.get_api_key_by_id(key_id)
    if not row or not row.get("auction_contributor"):
        raise HTTPException(status_code=404, detail="auction source not found")
    new_secret = secrets.token_urlsafe(32) if body.rotate_secret else None
    db.set_auction_contributor(
        row["key"], trusted=body.trusted, label=body.label, hmac_secret=new_secret
    )
    resp: Dict[str, Any] = {"id": key_id, "status": "ok"}
    if new_secret is not None:
        resp["hmac_secret"] = new_secret  # shown once
    return resp


@router.post("/admin/auction-sources/{key_id}/revoke")
async def revoke_source(
    key_id: str,
    purge: bool = Query(default=False),
    check: bool = Query(default=False),
    _: str = Depends(require_admin),
) -> Dict[str, Any]:
    row = db.get_api_key_by_id(key_id)
    if not row or not row.get("auction_contributor"):
        raise HTTPException(status_code=404, detail="auction source not found")

    if check:
        # Dry-run: report impact of excluding this source without mutating.
        return {"id": key_id, "dry_run": True, "impact": auction_rebuild.source_impact(key_id)}

    db.revoke_api_key(row["key"])
    purged = False
    if purge:
        try:
            auction_raw_store.delete_raw(key_id)
            purged = True
        except Exception as exc:  # noqa: BLE001 — best-effort object delete
            logger.warning("[auction] purge of %s failed: %s", key_id, exc)

    result = await auction_rebuild.rebuild_now()
    return {"id": key_id, "revoked": True, "purged": purged, "rebuild": result}


@router.post("/admin/auction-rebuild")
async def force_rebuild(_: str = Depends(require_admin)) -> Dict[str, Any]:
    result = await auction_rebuild.rebuild_now()
    return {"status": "ok", "rebuild": result}
