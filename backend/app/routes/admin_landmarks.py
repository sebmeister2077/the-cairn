"""Phase 3 — admin endpoints for the user-editable landmarks system.

Routes:
- ``GET    /api/admin/landmarks/edit-requests`` — list pending (or filtered) rename requests.
- ``POST   /api/admin/landmarks/edit-requests/{id}/approve`` — apply the proposed label.
- ``POST   /api/admin/landmarks/edit-requests/{id}/reject``  — close without applying.
- ``GET    /api/admin/landmarks/audit`` — paged audit feed.
- ``DELETE /api/admin/landmarks/{landmark_id}`` — admin-only hard delete (any origin).

All endpoints require the env-var admin key (``require_admin``) and therefore
also enforce the WebAuthn session gate when one is configured. There is no
TOTP requirement here: rename approval/reject is reversible from the audit
log, and a delete only removes a single feature whose state is recoverable
from the next backup.

The geojson read-modify-upload is serialised through the same
``_landmarks_lock`` defined in [backend/app/routes/landmarks.py] to prevent
concurrent admin + user writes from racing.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import require_admin
from ..core import database as db
from ..core import r2_storage
from ..tasks import weekly_backup
from . import landmarks as landmarks_routes


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/landmarks", tags=["admin-landmarks"])


class ReviewBody(BaseModel):
    note: Optional[str] = None


def _admin_api_key_id(api_key: str) -> Optional[str]:
    """Resolve the admin's ``api_keys.id`` UUID for audit logging.

    The env-var admin key has no row in ``api_keys`` and therefore no UUID,
    in which case audit columns receive None (the schema permits NULL).
    Admins authenticated via a DB-backed key (e.g. a future invite-claimed
    admin) get their real UUID recorded.
    """
    record = db.get_api_key(api_key)
    if record and record.get("id") is not None:
        return str(record["id"])
    return None


def _serialise_audit(row: dict) -> dict:
    created = row.get("created_at")
    return {
        "id": row["id"],
        "landmark_id": row["landmark_id"],
        "action": row["action"],
        "actor_api_key_id": row.get("actor_api_key_id"),
        "actor_display_name": row.get("actor_display_name"),
        "before_payload": row.get("before_payload"),
        "after_payload": row.get("after_payload"),
        "created_at": created.isoformat() if hasattr(created, "isoformat") else created,
    }


# ---------------------------------------------------------------------------
# Edit-request queue
# ---------------------------------------------------------------------------

@router.get("/edit-requests")
async def list_edit_requests(
    status: Optional[str] = "pending",
    limit: int = 100,
    offset: int = 0,
    _: str = Depends(require_admin),
) -> dict:
    """List rename requests. Defaults to pending; pass ``status=all`` to drop the filter."""
    status_filter = None if status == "all" else status
    rows = await asyncio.to_thread(
        db.list_landmark_edit_requests,
        status=status_filter,
        limit=max(1, min(int(limit), 500)),
        offset=max(0, int(offset)),
    )
    return {
        "edit_requests": [landmarks_routes._serialise_edit_request(r) for r in rows],
    }


@router.post("/edit-requests/{request_id}/approve")
async def approve_edit_request(
    request_id: str,
    body: ReviewBody,
    api_key: str = Depends(require_admin),
) -> dict:
    """Apply the proposed label to the live geojson and mark the request approved.

    Race protection:
    - ``resolve_landmark_edit_request`` only updates rows whose status is
      still ``pending``, so a second admin clicking approve simultaneously
      will get None back and a 409 here.
    - The geojson critical section is held under ``_landmarks_lock`` so
      a concurrent user POST/PATCH can't stomp on the rename.
    """
    reviewer_api_key_id = _admin_api_key_id(api_key)
    request_row = await asyncio.to_thread(db.get_landmark_edit_request, request_id)
    if request_row is None:
        raise HTTPException(status_code=404, detail="edit request not found")
    if request_row["status"] != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"edit request already {request_row['status']}",
        )

    landmark_id = request_row["landmark_id"]
    proposed_label = request_row["proposed_label"]

    async with landmarks_routes._landmarks_lock:
        data = await asyncio.to_thread(landmarks_routes._load_landmarks_file)
        feature = landmarks_routes._find_feature(data, landmark_id)
        if feature is None:
            # Landmark was deleted between request submission and approval.
            # Mark the request rejected so it stops cluttering the queue.
            await asyncio.to_thread(
                db.resolve_landmark_edit_request,
                request_id,
                new_status="rejected",
                reviewed_by_api_key_id=reviewer_api_key_id,
                review_note="Landmark no longer exists",
            )
            raise HTTPException(status_code=409, detail="landmark no longer exists")

        props = feature.setdefault("properties", {})
        before = json.loads(json.dumps(feature))
        props["label"] = proposed_label
        await asyncio.to_thread(landmarks_routes._save_landmarks_file, data)

        resolved = await asyncio.to_thread(
            db.resolve_landmark_edit_request,
            request_id,
            new_status="approved",
            reviewed_by_api_key_id=reviewer_api_key_id,
            review_note=body.note,
        )
        if resolved is None:
            # Lost the race against another admin — undo our file write.
            props["label"] = before.get("properties", {}).get("label", proposed_label)
            await asyncio.to_thread(landmarks_routes._save_landmarks_file, data)
            raise HTTPException(status_code=409, detail="edit request was already resolved")

        await asyncio.to_thread(
            db.insert_landmark_audit,
            landmark_id=landmark_id,
            action="admin_approve_rename",
            actor_api_key_id=reviewer_api_key_id,
            actor_display_name="admin",
            before_payload=before,
            after_payload=feature,
        )

    return {
        "edit_request": landmarks_routes._serialise_edit_request(resolved),
        "landmark": feature,
    }


@router.post("/edit-requests/{request_id}/reject")
async def reject_edit_request(
    request_id: str,
    body: ReviewBody,
    api_key: str = Depends(require_admin),
) -> dict:
    reviewer_api_key_id = _admin_api_key_id(api_key)
    resolved = await asyncio.to_thread(
        db.resolve_landmark_edit_request,
        request_id,
        new_status="rejected",
        reviewed_by_api_key_id=reviewer_api_key_id,
        review_note=body.note,
    )
    if resolved is None:
        existing = await asyncio.to_thread(db.get_landmark_edit_request, request_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="edit request not found")
        raise HTTPException(
            status_code=409,
            detail=f"edit request already {existing['status']}",
        )
    await asyncio.to_thread(
        db.insert_landmark_audit,
        landmark_id=resolved["landmark_id"],
        action="admin_reject_rename",
        actor_api_key_id=reviewer_api_key_id,
        actor_display_name="admin",
        before_payload={
            "current_label": resolved["current_label"],
            "proposed_label": resolved["proposed_label"],
        },
        after_payload={"note": body.note},
    )
    return {"edit_request": landmarks_routes._serialise_edit_request(resolved)}


# ---------------------------------------------------------------------------
# Audit feed
# ---------------------------------------------------------------------------

@router.get("/audit")
async def list_audit(
    landmark_id: Optional[str] = None,
    actor_api_key: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    _: str = Depends(require_admin),
) -> dict:
    actor_api_key_id: Optional[str] = None
    if actor_api_key:
        actor_db_api_key = await asyncio.to_thread(db.get_api_key, actor_api_key)
        if not actor_db_api_key:
            raise HTTPException(status_code=400, detail="actor_api_key filter not found")
        actor_api_key_id = str(actor_db_api_key["id"])

    rows = await asyncio.to_thread(
        db.list_landmark_audit,
        landmark_id=landmark_id,
        actor_api_key_id=actor_api_key_id,
        limit=max(1, min(int(limit), 500)),
        offset=max(0, int(offset)),
    )
    return {"audit": [_serialise_audit(r) for r in rows]}


# ---------------------------------------------------------------------------
# Hard delete
# ---------------------------------------------------------------------------

@router.delete("/{landmark_id}")
async def delete_landmark(
    landmark_id: str,
    api_key: str = Depends(require_admin),
) -> dict:
    """Remove a feature from the live geojson regardless of origin.

    Any pending rename requests for this landmark are auto-rejected so the
    queue stays clean.
    """
    async with landmarks_routes._landmarks_lock:
        data = await asyncio.to_thread(landmarks_routes._load_landmarks_file)
        feature = landmarks_routes._find_feature(data, landmark_id)
        if feature is None:
            raise HTTPException(status_code=404, detail="landmark not found")
        data["features"] = [
            f for f in data["features"]
            if (f.get("properties") or {}).get("id") != landmark_id
        ]
        await asyncio.to_thread(landmarks_routes._save_landmarks_file, data)
        actor_api_key_id = _admin_api_key_id(api_key)
        await asyncio.to_thread(
            db.insert_landmark_audit,
            landmark_id=landmark_id,
            action="admin_delete",
            actor_api_key_id=actor_api_key_id,
            actor_display_name="admin",
            before_payload=feature,
        )

        # Auto-reject any still-pending rename requests for this landmark.
        pending = await asyncio.to_thread(
            db.list_landmark_edit_requests,
            status="pending",
            landmark_id=landmark_id,
            limit=500,
        )
        for req in pending:
            await asyncio.to_thread(
                db.resolve_landmark_edit_request,
                req["id"],
                new_status="rejected",
                reviewed_by_api_key_id=actor_api_key_id,
                review_note="Landmark deleted",
            )

    return {"deleted": landmark_id, "feature": feature}


# ---------------------------------------------------------------------------
# Phase 4 — geojson backups (landmarks + translocators)
# ---------------------------------------------------------------------------
#
# Mirrors the combined-DB backup endpoints in [admin_backups.py] but for the
# tiny geojson assets. Restore is admin-key-gated only (no TOTP) — the data
# loss surface is at most a week of edits and the audit log preserves what
# was there.

_VALID_ASSETS = ("landmarks", "translocators")


class GeojsonBackupCreateBody(BaseModel):
    asset: str  # "landmarks" | "translocators"


class GeojsonBackupRestoreBody(BaseModel):
    asset: str
    key: str
    confirm: bool = False


@router.get("/backups")
async def list_geojson_backups(_: str = Depends(require_admin)) -> dict:
    return {"backups": weekly_backup.list_geojson_backups()}


@router.post("/backups/create")
async def create_geojson_backup(
    body: GeojsonBackupCreateBody,
    _: str = Depends(require_admin),
) -> dict:
    if body.asset not in _VALID_ASSETS:
        raise HTTPException(status_code=400, detail=f"asset must be one of {_VALID_ASSETS}")
    # Hold the per-asset lock so the manual snapshot can't capture a torn
    # write from a concurrent user POST/PATCH.
    async with landmarks_routes._landmarks_lock:
        try:
            key = await asyncio.to_thread(weekly_backup.create_manual_geojson_snapshot, body.asset)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
    return {"key": key}


@router.post("/backups/restore")
async def restore_geojson_backup(
    body: GeojsonBackupRestoreBody,
    api_key: str = Depends(require_admin),
) -> dict:
    if body.asset not in _VALID_ASSETS:
        raise HTTPException(status_code=400, detail=f"asset must be one of {_VALID_ASSETS}")
    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail="confirm must be true — restore overwrites the live file",
        )
    async with landmarks_routes._landmarks_lock:
        try:
            live_key = await asyncio.to_thread(
                weekly_backup.restore_geojson_from_backup, body.asset, body.key
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        await asyncio.to_thread(
            db.insert_landmark_audit,
            landmark_id=f"<{body.asset}-restore>",
            action="admin_restore_backup",
            actor_api_key_id=_admin_api_key_id(api_key),
            actor_display_name="admin",
            after_payload={"asset": body.asset, "from_key": body.key},
        )
    return {"restored": body.asset, "from_key": body.key, "live_key": live_key}

