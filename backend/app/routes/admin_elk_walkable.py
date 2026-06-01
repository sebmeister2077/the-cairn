"""Admin endpoints for the elk-walkable feature.

Read access to the audit log + per-row revert + full-file snapshot
restore. All endpoints require the admin API key.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ..auth import require_admin
from ..core import database as db
from ..core import elk_walkable_store


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/elk-walkable", tags=["admin-elk-walkable"])


# Admin actions come in via the env-var ``ADMIN_API_KEY`` which has no
# ``api_keys`` row, so ``actor_api_key_id`` is recorded as NULL and the
# display name is a static label distinguishing admin rows in the audit
# trail.
_ADMIN_DISPLAY_NAME = "admin"


@router.get("/audit")
async def list_audit(
    api_key: str = Depends(require_admin),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    action: Optional[str] = Query(None),
    edge_key: Optional[str] = Query(None),
) -> dict:
    rows = await asyncio.to_thread(
        db.list_elk_walkable_audit,
        edge_key=edge_key,
        action=action,
        limit=limit,
        offset=offset,
    )
    serialised = []
    for r in rows:
        created = r.get("created_at")
        serialised.append({
            "id": r.get("id"),
            "change_id": r.get("change_id"),
            "action": r.get("action"),
            "edge_key": r.get("edge_key"),
            "actor_api_key_id": r.get("actor_api_key_id"),
            "actor_display_name": r.get("actor_display_name"),
            "snapshot_key": r.get("snapshot_key"),
            "before_payload": r.get("before_payload"),
            "after_payload": r.get("after_payload"),
            "created_at": (
                created.isoformat() if hasattr(created, "isoformat") else created
            ),
        })
    return {"audit": serialised, "limit": limit, "offset": offset}


@router.post("/audit/{audit_id}/revert")
async def revert_audit_row(
    audit_id: int,
    api_key: str = Depends(require_admin),
) -> dict:
    async with elk_walkable_store.elk_walkable_write_lock("admin_revert"):
        result = await asyncio.to_thread(
            elk_walkable_store.revert_audit_row,
            audit_id,
            actor_api_key_id=None,
            actor_display_name=_ADMIN_DISPLAY_NAME,
        )
    return result


@router.get("/snapshots")
async def list_snapshots(
    api_key: str = Depends(require_admin),
    limit: int = Query(200, ge=1, le=1000),
) -> dict:
    snapshots = await asyncio.to_thread(elk_walkable_store.list_snapshots, limit)
    return {"snapshots": snapshots}


class RestoreSnapshotBody(BaseModel):
    snapshot_key: str


@router.post("/restore")
async def restore_snapshot(
    payload: RestoreSnapshotBody,
    api_key: str = Depends(require_admin),
) -> dict:
    async with elk_walkable_store.elk_walkable_write_lock("admin_restore_snapshot"):
        result = await asyncio.to_thread(
            elk_walkable_store.restore_snapshot,
            payload.snapshot_key,
            actor_api_key_id=None,
            actor_display_name=_ADMIN_DISPLAY_NAME,
        )
    return result
