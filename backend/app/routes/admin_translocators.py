"""Admin endpoints for the user-contributed translocators feature.

- ``GET    /api/admin/translocators/audit`` — paginated audit feed.
- ``GET    /api/admin/translocators`` — current user-contributed segments
  (joined with the latest add-row stats + ``still_present`` flag).
- ``DELETE /api/admin/translocators/{segment_id}`` — single hard delete.
- ``DELETE /api/admin/translocators/by-user/{actor_api_key_id}`` — bulk
  revert: drop every user-contributed segment authored by one user, in
  one geojson rewrite.

All endpoints require the env-var admin key (``require_admin``) and so
also enforce the WebAuthn session gate when one is configured. There is
no TOTP requirement: deletes are recoverable from the audit log
(``before_payload``) and from the next weekly backup.

The geojson read-modify-upload is serialised through the
``_translocators_lock`` defined in [backend/app/routes/contribute_tls.py]
so admin + user writes can't race.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_admin
from ..core import accounts_db
from ..core import database as db
from . import contribute_tls as contribute_tls_routes


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/translocators", tags=["admin-translocators"])


def _admin_api_key_id(api_key: str) -> Optional[str]:
    record = db.get_api_key(api_key)
    if record and record.get("id") is not None:
        return str(record["id"])
    return None


def _serialise_audit(row: dict) -> dict:
    created = row.get("created_at")
    return {
        "id": row["id"],
        "segment_id": row["segment_id"],
        "action": row["action"],
        "actor_api_key_id": row.get("actor_api_key_id"),
        "actor_display_name": row.get("actor_display_name"),
        "before_payload": row.get("before_payload"),
        "after_payload": row.get("after_payload"),
        "submission_stats": row.get("submission_stats"),
        "created_at": created.isoformat() if hasattr(created, "isoformat") else created,
    }


def _page_payload(key: str, items: list, total: int, limit: int, offset: int) -> dict:
    next_offset = offset + limit if offset + limit < total else None
    return {
        key: items,
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "next_offset": next_offset,
    }


# ---------------------------------------------------------------------------
# Audit feed
# ---------------------------------------------------------------------------

@router.get("/audit")
async def list_audit(
    segment_id: Optional[str] = None,
    actor_api_key_id: Optional[str] = None,
    action: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    _: str = Depends(require_admin),
) -> dict:
    safe_limit = max(1, min(int(limit), 500))
    safe_offset = max(0, int(offset))
    page = await asyncio.to_thread(
        db.list_translocator_audit_paginated,
        segment_id=segment_id,
        actor_api_key_id=actor_api_key_id,
        action=action,
        limit=safe_limit,
        offset=safe_offset,
    )
    items = [_serialise_audit(r) for r in page["items"]]
    return _page_payload("audit", items, int(page["total"]), safe_limit, safe_offset)


# ---------------------------------------------------------------------------
# Current-state listing (joins audit `add` rows against the live geojson)
# ---------------------------------------------------------------------------

@router.get("")
async def list_user_translocators(
    actor_api_key_id: Optional[str] = None,
    limit: int = 10,
    offset: int = 0,
    _: str = Depends(require_admin),
) -> dict:
    """Return one entry per still-present user-contributed segment with
    contributor + submission-stats + coordinates pulled from the live
    geojson. Sorted by ``added_at`` descending.
    """
    data = await asyncio.to_thread(contribute_tls_routes._load_translocators_file)
    by_id = {}
    for feat in data.get("features") or []:
        if not isinstance(feat, dict):
            continue
        props = feat.get("properties") or {}
        sid = props.get("id")
        if sid:
            by_id[sid] = feat

    safe_limit = max(1, min(int(limit), 200))
    safe_offset = max(0, int(offset))
    page, contributors = await asyncio.gather(
        asyncio.to_thread(
            db.list_translocator_add_audit_paginated,
            actor_api_key_id=actor_api_key_id,
            limit=safe_limit,
            offset=safe_offset,
        ),
        asyncio.to_thread(db.list_translocator_contributors),
    )
    out = []
    seen = set()
    for r in page["items"]:
        sid = r["segment_id"]
        if sid in seen:
            continue
        seen.add(sid)
        feat = by_id.get(sid)
        still_present = feat is not None
        coords = (
            ((feat.get("geometry") or {}).get("coordinates") or [])
            if still_present
            else (
                ((r.get("after_payload") or {}).get("geometry") or {}).get(
                    "coordinates"
                )
                or []
            )
        )
        created = r.get("created_at")
        out.append({
            "segment_id": sid,
            "actor_api_key_id": r.get("actor_api_key_id"),
            "actor_display_name": r.get("actor_display_name"),
            "label": (
                ((feat.get("properties") or {}).get("label"))
                if still_present
                else (
                    (r.get("after_payload") or {}).get("properties") or {}
                ).get("label")
            ),
            "coordinates": coords,
            "submission_stats": r.get("submission_stats"),
            "still_present": still_present,
            "created_at": (
                created.isoformat() if hasattr(created, "isoformat") else created
            ),
        })
    payload = _page_payload(
        "translocators", out, int(page["total"]), safe_limit, safe_offset
    )
    payload["contributors"] = [
        {
            "id": str(r["actor_api_key_id"]),
            "name": r.get("actor_display_name") or str(r["actor_api_key_id"]),
            "submission_count": int(r.get("submission_count") or 0),
        }
        for r in contributors
    ]
    return payload


# ---------------------------------------------------------------------------
# Hard delete
# ---------------------------------------------------------------------------

def _drop_features_by_ids(data: dict, ids: set) -> list:
    """In-place: remove every feature whose ``properties.id`` is in ``ids``.
    Returns the list of removed features (snapshots)."""
    removed: list = []
    kept: list = []
    for feat in data.get("features") or []:
        if not isinstance(feat, dict):
            kept.append(feat)
            continue
        sid = (feat.get("properties") or {}).get("id")
        if sid in ids:
            removed.append(feat)
        else:
            kept.append(feat)
    data["features"] = kept
    return removed


@router.delete("/{segment_id}")
async def delete_user_translocator(
    segment_id: str,
    api_key: str = Depends(require_admin),
) -> dict:
    """Remove a single user-contributed segment from the live geojson and
    write a ``delete`` audit row capturing the pre-delete feature."""
    actor_api_key_id = _admin_api_key_id(api_key)
    async with contribute_tls_routes.translocators_write_lock("admin_delete"):
        data = await asyncio.to_thread(
            contribute_tls_routes._load_translocators_file
        )
        removed = _drop_features_by_ids(data, {segment_id})
        if not removed:
            raise HTTPException(status_code=404, detail="translocator not found")
        await asyncio.to_thread(
            contribute_tls_routes._save_translocators_file, data
        )
        await asyncio.to_thread(
            db.insert_translocator_audit,
            segment_id=segment_id,
            action="admin_delete",
            actor_api_key_id=actor_api_key_id,
            actor_display_name="admin",
            before_payload=removed[0],
        )
    accounts_db.audit_log(
        api_key,
        "translocators.deleted",
        target=segment_id,
        metadata={"feature": removed[0]},
    )
    return {"deleted": segment_id, "feature": removed[0]}


@router.delete("/by-user/{actor_api_key_id}")
async def delete_user_translocators_bulk(
    actor_api_key_id: str,
    api_key: str = Depends(require_admin),
) -> dict:
    """Bulk revert: drop every user-contributed segment authored by one
    user. One geojson rewrite, one audit row per removed segment, plus a
    summary entry on the cross-cutting admin audit log."""
    admin_id = _admin_api_key_id(api_key)
    async with contribute_tls_routes.translocators_write_lock("admin_bulk_delete"):
        data = await asyncio.to_thread(
            contribute_tls_routes._load_translocators_file
        )
        ids_to_drop: set = set()
        for feat in data.get("features") or []:
            if not isinstance(feat, dict):
                continue
            props = feat.get("properties") or {}
            if props.get("origin") != "user":
                continue
            owner = props.get("added_by_user_id")
            if owner and str(owner) == str(actor_api_key_id):
                ids_to_drop.add(props.get("id"))
        ids_to_drop.discard(None)
        if not ids_to_drop:
            return {"deleted": 0, "segment_ids": []}
        removed = _drop_features_by_ids(data, ids_to_drop)
        await asyncio.to_thread(
            contribute_tls_routes._save_translocators_file, data
        )
        for feat in removed:
            sid = (feat.get("properties") or {}).get("id")
            if not sid:
                continue
            await asyncio.to_thread(
                db.insert_translocator_audit,
                segment_id=sid,
                action="admin_delete",
                actor_api_key_id=admin_id,
                actor_display_name="admin",
                before_payload=feat,
            )
    accounts_db.audit_log(
        api_key,
        "translocators.deleted_by_user",
        target=str(actor_api_key_id),
        metadata={"count": len(removed)},
    )
    return {
        "deleted": len(removed),
        "segment_ids": [
            (f.get("properties") or {}).get("id") for f in removed
        ],
    }
