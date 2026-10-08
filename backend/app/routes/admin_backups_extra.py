"""Admin endpoints for two additional crowd-sourced / upstream data backups.

* ``/admin/map-features-rapids`` — list / snapshot / restore the merged
  ``map-features.rapids.json`` list (mirrors the map-features-traders flow).
* ``/admin/tops-translocators`` — list / snapshot the upstream TOPS
  translocators geojson. There is intentionally no restore/download: the data
  is only ever fetched fresh from the upstream host and stored as a backup in
  case that host goes down.

All endpoints require the admin API key.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import require_admin, require_admin_passkey
from ..tasks import weekly_backup


logger = logging.getLogger("uvicorn.error")

rapids_router = APIRouter(
    prefix="/admin/map-features-rapids", tags=["admin-map-features-rapids"]
)
tops_translocators_router = APIRouter(
    prefix="/admin/tops-translocators", tags=["admin-tops-translocators"]
)


class RestoreBackupBody(BaseModel):
    key: str
    confirm: bool = False


# ---------------------------------------------------------------------------
# Merged map-features rapids list
# ---------------------------------------------------------------------------


@rapids_router.get("/backups")
async def list_rapids_backups(_: str = Depends(require_admin)) -> dict:
    backups = await asyncio.to_thread(weekly_backup.list_map_features_rapids_backups)
    return {"backups": backups}


@rapids_router.post("/backups/create")
async def create_rapids_backup(_: str = Depends(require_admin)) -> dict:
    try:
        key = await asyncio.to_thread(
            weekly_backup.create_manual_map_features_rapids_snapshot
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"key": key}


@rapids_router.post("/backups/restore")
async def restore_rapids_backup(
    body: RestoreBackupBody,
    _: str = Depends(require_admin_passkey),
) -> dict:
    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail="confirm must be true — restore overwrites the live file",
        )
    try:
        return await asyncio.to_thread(
            weekly_backup.restore_map_features_rapids_from_backup, body.key
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Upstream TOPS translocators geojson (list + snapshot only)
# ---------------------------------------------------------------------------


@tops_translocators_router.get("/backups")
async def list_tops_translocators_backups(_: str = Depends(require_admin)) -> dict:
    backups = await asyncio.to_thread(weekly_backup.list_tops_translocators_backups)
    return {"backups": backups}


@tops_translocators_router.post("/backups/create")
async def create_tops_translocators_backup(_: str = Depends(require_admin)) -> dict:
    try:
        key = await asyncio.to_thread(
            weekly_backup.create_manual_tops_translocators_snapshot
        )
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:  # noqa: BLE001 - upstream fetch can fail many ways
        logger.warning("admin tops-translocators: snapshot failed: %r", exc)
        raise HTTPException(status_code=502, detail="upstream fetch failed")
    return {"key": key}
