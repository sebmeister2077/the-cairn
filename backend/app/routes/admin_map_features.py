"""Admin endpoints for the merged map-features traders list.

Read-only audit feed over ``map-features.traders.json`` (the crowd-sourced,
continuously-rebuilt traders list in the public map-features bucket) plus the
biweekly backup snapshots. There is intentionally no revert/restore — the
merged data is authoritative and only grows from contributor uploads.

All endpoints require the admin API key.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import require_admin, require_admin_passkey
from ..core import database as db
from ..tasks import weekly_backup


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/map-features-traders", tags=["admin-map-features-traders"])


def _serialise_audit(row: dict) -> dict:
    created = row.get("created_at")
    return {
        "id": row.get("id"),
        "action": row.get("action"),
        "actor_api_key_id": row.get("actor_api_key_id"),
        "actor_display_name": row.get("actor_display_name"),
        "upstream_host": row.get("upstream_host"),
        "traders_received": row.get("traders_received"),
        "traders_accepted": row.get("traders_accepted"),
        "total_accepted": row.get("total_accepted"),
        "published_version": row.get("published_version"),
        "note": row.get("note"),
        "created_at": (
            created.isoformat() if hasattr(created, "isoformat") else created
        ),
    }


@router.get("/audit")
async def list_audit(
    _: str = Depends(require_admin),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    action: Optional[str] = Query(None),
) -> dict:
    page = await asyncio.to_thread(
        db.list_map_features_traders_audit_paginated,
        action=action,
        limit=limit,
        offset=offset,
    )
    items = [_serialise_audit(r) for r in page["items"]]
    return {
        "audit": items,
        "total": int(page["total"]),
        "limit": limit,
        "offset": offset,
    }


@router.get("/backups")
async def list_backups(_: str = Depends(require_admin)) -> dict:
    backups = await asyncio.to_thread(weekly_backup.list_map_features_traders_backups)
    return {"backups": backups}


@router.post("/backups/create")
async def create_backup(_: str = Depends(require_admin)) -> dict:
    try:
        key = await asyncio.to_thread(
            weekly_backup.create_manual_map_features_traders_snapshot
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    try:
        await asyncio.to_thread(
            db.insert_map_features_traders_audit,
            action="admin_snapshot",
            actor_display_name="admin",
            note=key,
        )
    except Exception:
        logger.exception("admin map-features traders: failed to write snapshot audit row")
    return {"key": key}


class RestoreBackupBody(BaseModel):
    key: str
    confirm: bool = False


@router.post("/backups/restore")
async def restore_backup(
    body: RestoreBackupBody,
    _: str = Depends(require_admin_passkey),
) -> dict:
    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail="confirm must be true — restore overwrites the live file",
        )
    try:
        result = await asyncio.to_thread(
            weekly_backup.restore_map_features_traders_from_backup, body.key
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        await asyncio.to_thread(
            db.insert_map_features_traders_audit,
            action="admin_restore_backup",
            actor_display_name="admin",
            note=body.key,
        )
    except Exception:
        logger.exception("admin map-features traders: failed to write restore audit row")
    return result
