"""Admin endpoints for the user-contributed Traders feature.

- ``GET    /api/admin/traders/audit`` — paginated audit feed.
- ``GET    /api/admin/traders``       — current user-contributed traders
  (joined with the latest add-row stats + ``still_present`` flag).
- ``GET    /api/admin/traders/users/{actor_api_key_id}`` — per-user stats
  (total + 7-day add counts) for the contributor sidebar.
- ``PATCH  /api/admin/traders/{trader_id}`` — edit label / type / coords.
- ``DELETE /api/admin/traders/{trader_id}`` — single hard delete.
- ``DELETE /api/admin/traders/by-user/{actor_api_key_id}`` — bulk revert.
- ``POST   /api/admin/traders/audit/{audit_id}/revert`` — per-submission
  revert. **Gated** by feature flag ``per_traders_revert``.

The geojson read-modify-upload is serialised through
``contribute_traders_routes._traders_lock`` so admin + user writes can't
race.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..core import accounts_db
from ..core import database as db
from ..core import feature_flags
from . import contribute_traders as contribute_traders_routes


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/traders", tags=["admin-traders"])

_REVERT_FLAG = "per_traders_revert"

_TRADER_TYPES = contribute_traders_routes._TRADER_TYPES


def _admin_api_key_id(api_key: str) -> Optional[str]:
    record = db.get_api_key(api_key)
    if record and record.get("id") is not None:
        return str(record["id"])
    return None


def _serialise_audit(row: dict) -> dict:
    created = row.get("created_at")
    return {
        "id": row["id"],
        "trader_id": row["trader_id"],
        "action": row["action"],
        "source": row.get("source"),
        "trader_type": row.get("trader_type"),
        "actor_api_key_id": row.get("actor_api_key_id"),
        "actor_display_name": row.get("actor_display_name"),
        "before_payload": row.get("before_payload"),
        "after_payload": row.get("after_payload"),
        "submission_stats": row.get("submission_stats"),
        "duplicate_flagged": bool(row.get("duplicate_flagged")),
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
    trader_id: Optional[str] = None,
    actor_api_key_id: Optional[str] = None,
    action: Optional[str] = None,
    trader_type: Optional[str] = None,
    source: Optional[str] = None,
    duplicate_flagged: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0,
    _: str = Depends(require_admin),
) -> dict:
    safe_limit = max(1, min(int(limit), 500))
    safe_offset = max(0, int(offset))
    page = await asyncio.to_thread(
        db.list_trader_audit_paginated,
        trader_id=trader_id,
        actor_api_key_id=actor_api_key_id,
        action=action,
        trader_type=trader_type,
        source=source,
        duplicate_flagged=duplicate_flagged,
        limit=safe_limit,
        offset=safe_offset,
    )
    items = [_serialise_audit(r) for r in page["items"]]
    return _page_payload("audit", items, int(page["total"]), safe_limit, safe_offset)


# ---------------------------------------------------------------------------
# Current-state listing
# ---------------------------------------------------------------------------

@router.get("")
async def list_user_traders(
    actor_api_key_id: Optional[str] = None,
    trader_type: Optional[str] = None,
    limit: int = 10,
    offset: int = 0,
    _: str = Depends(require_admin),
) -> dict:
    """One entry per still-present user-contributed trader with contributor +
    submission-stats + coordinates pulled from the live geojson. Sorted by
    add ``created_at`` descending."""
    data = await asyncio.to_thread(contribute_traders_routes._load_traders_file)
    by_id = {}
    for feat in data.get("features") or []:
        if not isinstance(feat, dict):
            continue
        props = feat.get("properties") or {}
        tid = props.get("id")
        if tid:
            by_id[tid] = feat

    safe_limit = max(1, min(int(limit), 200))
    safe_offset = max(0, int(offset))
    # Restrict the audit query to ids that still exist in the geojson so
    # already-deleted / reverted traders don't keep showing up in the
    # admin list (and so the Delete button doesn't 404 on a stale id).
    live_ids = list(by_id.keys())
    page, contributors = await asyncio.gather(
        asyncio.to_thread(
            db.list_trader_add_audit_paginated,
            actor_api_key_id=actor_api_key_id,
            trader_type=trader_type,
            trader_ids=live_ids,
            limit=safe_limit,
            offset=safe_offset,
        ),
        asyncio.to_thread(db.list_trader_contributors),
    )
    out = []
    seen = set()
    for r in page["items"]:
        tid = r["trader_id"]
        if tid in seen:
            continue
        seen.add(tid)
        feat = by_id.get(tid)
        still_present = feat is not None
        props = (feat or {}).get("properties") or (
            (r.get("after_payload") or {}).get("properties") or {}
        )
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
            "trader_id": tid,
            "actor_api_key_id": r.get("actor_api_key_id"),
            "actor_display_name": r.get("actor_display_name"),
            "label": props.get("label"),
            "trader_type": props.get("trader_type") or r.get("trader_type"),
            "source": r.get("source"),
            "coordinates": coords,
            "submission_stats": r.get("submission_stats"),
            "duplicate_flagged": bool(r.get("duplicate_flagged")),
            "still_present": still_present,
            "created_at": (
                created.isoformat() if hasattr(created, "isoformat") else created
            ),
        })
    payload = _page_payload(
        "traders", out, int(page["total"]), safe_limit, safe_offset
    )
    payload["contributors"] = [
        {
            "id": str(r["actor_api_key_id"]),
            "name": r.get("actor_display_name") or str(r["actor_api_key_id"]),
            "total_added": int(r.get("total_added") or 0),
            "added_last_7d": int(r.get("added_last_7d") or 0),
            "last_submission_at": r.get("last_submission_at"),
        }
        for r in contributors
    ]
    return payload


@router.get("/users/{actor_api_key_id}")
async def get_user_stats(
    actor_api_key_id: str,
    _: str = Depends(require_admin),
) -> dict:
    stats = await asyncio.to_thread(db.get_trader_user_stats, actor_api_key_id)
    return {"actor_api_key_id": actor_api_key_id, "stats": stats}


# ---------------------------------------------------------------------------
# Edit
# ---------------------------------------------------------------------------

class TraderEditBody(BaseModel):
    label: Optional[str] = None
    trader_type: Optional[str] = None
    x: Optional[int] = None
    z: Optional[int] = None


@router.patch("/{trader_id}")
async def edit_user_trader(
    trader_id: str,
    body: TraderEditBody,
    api_key: str = Depends(require_admin),
) -> dict:
    admin_id = _admin_api_key_id(api_key)
    async with contribute_traders_routes.traders_write_lock("admin_edit"):
        data = await asyncio.to_thread(contribute_traders_routes._load_traders_file)
        target = None
        for feat in data.get("features") or []:
            if not isinstance(feat, dict):
                continue
            if (feat.get("properties") or {}).get("id") == trader_id:
                target = feat
                break
        if target is None:
            raise HTTPException(status_code=404, detail="trader not found")
        before = {
            "properties": dict(target.get("properties") or {}),
            "geometry": dict(target.get("geometry") or {}),
        }
        props = target.setdefault("properties", {})
        if body.label is not None:
            props["label"] = contribute_traders_routes._normalise_label(body.label)
        if body.trader_type is not None:
            if body.trader_type not in _TRADER_TYPES:
                raise HTTPException(
                    status_code=400, detail=f"unknown trader_type '{body.trader_type}'"
                )
            props["trader_type"] = body.trader_type
        if body.x is not None or body.z is not None:
            geom = target.setdefault(
                "geometry", {"type": "Point", "coordinates": [0, 0]}
            )
            coords = list(geom.get("coordinates") or [0, 0])
            while len(coords) < 2:
                coords.append(0)
            if body.x is not None:
                coords[0] = int(body.x)
            if body.z is not None:
                # Frontend sends +Z = north; geojson stores +Z = south.
                coords[1] = -int(body.z)
            geom["coordinates"] = coords
        await asyncio.to_thread(contribute_traders_routes._save_traders_file, data)
        await asyncio.to_thread(
            db.insert_trader_audit,
            trader_id=trader_id,
            action="admin_edit",
            actor_api_key_id=admin_id,
            actor_display_name="admin",
            trader_type=props.get("trader_type"),
            before_payload=before,
            after_payload={
                "properties": dict(props),
                "geometry": dict(target.get("geometry") or {}),
            },
        )
    accounts_db.audit_log(
        api_key, "traders.edited", target=trader_id, metadata={"before": before}
    )
    return {"updated": trader_id, "feature": target}


# ---------------------------------------------------------------------------
# Delete (single + bulk)
# ---------------------------------------------------------------------------

def _drop_features_by_ids(data: dict, ids: set) -> list:
    removed: list = []
    kept: list = []
    for feat in data.get("features") or []:
        if not isinstance(feat, dict):
            kept.append(feat)
            continue
        tid = (feat.get("properties") or {}).get("id")
        if tid in ids:
            removed.append(feat)
        else:
            kept.append(feat)
    data["features"] = kept
    return removed


@router.delete("/{trader_id}")
async def delete_user_trader(
    trader_id: str,
    api_key: str = Depends(require_admin),
) -> dict:
    admin_id = _admin_api_key_id(api_key)
    async with contribute_traders_routes.traders_write_lock("admin_delete"):
        data = await asyncio.to_thread(contribute_traders_routes._load_traders_file)
        removed = _drop_features_by_ids(data, {trader_id})
        if not removed:
            raise HTTPException(status_code=404, detail="trader not found")
        await asyncio.to_thread(contribute_traders_routes._save_traders_file, data)
        await asyncio.to_thread(
            db.insert_trader_audit,
            trader_id=trader_id,
            action="admin_delete",
            actor_api_key_id=admin_id,
            actor_display_name="admin",
            trader_type=((removed[0].get("properties") or {}).get("trader_type")),
            before_payload=removed[0],
        )
    accounts_db.audit_log(
        api_key, "traders.deleted", target=trader_id, metadata={"feature": removed[0]}
    )
    return {"deleted": trader_id, "feature": removed[0]}


@router.delete("/by-user/{actor_api_key_id}")
async def delete_user_traders_bulk(
    actor_api_key_id: str,
    api_key: str = Depends(require_admin),
) -> dict:
    admin_id = _admin_api_key_id(api_key)
    # The geojson stores ``added_by_user_id`` (account id) while admin
    # tooling identifies contributors by ``actor_api_key_id`` (the api key
    # that submitted the audit row). Those are different identifiers, so
    # we resolve the trader ids via the audit table first and then drop
    # the matching geojson features by id.
    add_rows = await asyncio.to_thread(
        db.list_trader_add_audit_paginated,
        actor_api_key_id=actor_api_key_id,
        limit=200,
        offset=0,
    )
    ids_to_drop: set = set()
    for r in add_rows.get("items") or []:
        tid = r.get("trader_id")
        if tid:
            ids_to_drop.add(tid)
    # Walk additional pages if the user has more than the page size.
    total = int(add_rows.get("total") or 0)
    fetched = len(add_rows.get("items") or [])
    while fetched < total:
        page = await asyncio.to_thread(
            db.list_trader_add_audit_paginated,
            actor_api_key_id=actor_api_key_id,
            limit=200,
            offset=fetched,
        )
        items = page.get("items") or []
        if not items:
            break
        for r in items:
            tid = r.get("trader_id")
            if tid:
                ids_to_drop.add(tid)
        fetched += len(items)

    if not ids_to_drop:
        return {"deleted": 0, "trader_ids": []}

    async with contribute_traders_routes.traders_write_lock("admin_bulk_delete"):
        data = await asyncio.to_thread(contribute_traders_routes._load_traders_file)
        removed = _drop_features_by_ids(data, ids_to_drop)
        if not removed:
            return {"deleted": 0, "trader_ids": []}
        await asyncio.to_thread(contribute_traders_routes._save_traders_file, data)
        for feat in removed:
            tid = (feat.get("properties") or {}).get("id")
            if not tid:
                continue
            await asyncio.to_thread(
                db.insert_trader_audit,
                trader_id=tid,
                action="admin_delete",
                actor_api_key_id=admin_id,
                actor_display_name="admin",
                trader_type=((feat.get("properties") or {}).get("trader_type")),
                before_payload=feat,
            )
    accounts_db.audit_log(
        api_key,
        "traders.deleted_by_user",
        target=str(actor_api_key_id),
        metadata={"count": len(removed)},
    )
    return {
        "deleted": len(removed),
        "trader_ids": [(f.get("properties") or {}).get("id") for f in removed],
    }


# ---------------------------------------------------------------------------
# Per-submission revert (feature-flagged)
# ---------------------------------------------------------------------------

class RevertBody(BaseModel):
    confirm: bool = Field(False)


@router.post("/audit/{audit_id}/revert")
async def revert_trader_audit(
    audit_id: int,
    body: RevertBody,
    api_key: str = Depends(require_admin),
) -> dict:
    """Revert a single ``add`` row: removes the trader if it's still
    present, and writes a ``revert`` audit row carrying the prior add's
    feature as ``before_payload``. Gated by ``per_traders_revert``."""
    if not feature_flags.is_feature_enabled_default(_REVERT_FLAG, False):
        raise HTTPException(
            status_code=503,
            detail={"code": "feature_disabled", "message": "per-traders revert is disabled"},
        )
    if not body.confirm:
        raise HTTPException(status_code=400, detail="confirm must be true")
    admin_id = _admin_api_key_id(api_key)
    row = await asyncio.to_thread(db.get_trader_audit_row, audit_id)
    if not row:
        raise HTTPException(status_code=404, detail="audit row not found")
    if row.get("action") != "add":
        raise HTTPException(status_code=400, detail="can only revert 'add' rows")
    trader_id = row["trader_id"]
    async with contribute_traders_routes.traders_write_lock("admin_revert"):
        data = await asyncio.to_thread(contribute_traders_routes._load_traders_file)
        removed = _drop_features_by_ids(data, {trader_id})
        if removed:
            await asyncio.to_thread(
                contribute_traders_routes._save_traders_file, data
            )
        await asyncio.to_thread(
            db.insert_trader_audit,
            trader_id=trader_id,
            action="revert",
            actor_api_key_id=admin_id,
            actor_display_name="admin",
            trader_type=row.get("trader_type"),
            before_payload=removed[0] if removed else row.get("after_payload"),
            submission_stats={"reverted_audit_id": int(audit_id)},
        )
    accounts_db.audit_log(
        api_key,
        "traders.reverted",
        target=trader_id,
        metadata={"audit_id": int(audit_id), "still_present": bool(removed)},
    )
    return {
        "reverted": trader_id,
        "audit_id": int(audit_id),
        "still_present": bool(removed),
    }
