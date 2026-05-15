"""Admin endpoints for screenshot-based TL contribution review.

- ``GET    /admin/translocators/screenshots`` paginated list with filters
- ``GET    /admin/translocators/screenshots/{id}`` detail (with presigned
  URLs for the screenshots and minimap crops)
- ``PATCH  /admin/translocators/screenshots/{id}`` admin edits OCR'd coords
- ``POST   /admin/translocators/screenshots/{id}/retry-analysis`` requeues
    analysis for a pending request
- ``POST   /admin/translocators/screenshots/{id}/approve`` merges into
  ``translocators.geojson`` (sharing ``_translocators_lock`` with the
  chat-log path) and deletes the screenshot R2 objects.
- ``POST   /admin/translocators/screenshots/{id}/reject`` rejects with a
  reason and deletes the screenshot R2 objects.

Approve writes a ``translocators_audit`` row whose
``submission_stats.source = "screenshot"`` so the audit feed and existing
admin TL listing page distinguish chat-log vs. screenshot submissions.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..core import accounts_db
from ..core import database as db
from ..core import r2_storage
from . import contribute_tls as contribute_tls_routes
from . import contribute_tls_screenshots as user_routes


logger = logging.getLogger("uvicorn.error")
router = APIRouter(
    prefix="/admin/translocators/screenshots",
    tags=["admin-translocators-screenshots"],
)


_LABEL_MAX_LEN = 200
_COORD_LIMIT = 4_000_000


def _admin_api_key_id(api_key: str) -> Optional[str]:
    record = db.get_api_key(api_key)
    if record and record.get("id") is not None:
        return str(record["id"])
    return None


def _validate_coords(coords: dict, name: str) -> dict:
    if not isinstance(coords, dict):
        raise HTTPException(status_code=400, detail=f"{name} must be an object")
    out: dict = {}
    for axis in ("x", "y", "z"):
        v = coords.get(axis)
        if v is None:
            out[axis] = None
            continue
        try:
            iv = int(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{name}.{axis} must be an integer")
        if abs(iv) > _COORD_LIMIT:
            raise HTTPException(status_code=400, detail=f"{name}.{axis} out of range")
        out[axis] = iv
    return out


def _coords_complete(c: Optional[dict]) -> bool:
    return (
        isinstance(c, dict)
        and isinstance(c.get("x"), int)
        and isinstance(c.get("z"), int)
    )


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------

class PatchBody(BaseModel):
    coords_a: Optional[dict] = None
    coords_b: Optional[dict] = None
    label: Optional[str] = Field(default=None, max_length=_LABEL_MAX_LEN)


class ApproveBody(BaseModel):
    label: Optional[str] = Field(default=None, max_length=_LABEL_MAX_LEN)


class RejectBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)


# ---------------------------------------------------------------------------
# Listing / detail
# ---------------------------------------------------------------------------

@router.get("")
async def list_requests(
    status: Optional[str] = None,
    submitter_api_key_id: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    _: str = Depends(require_admin),
) -> dict:
    safe_limit = max(1, min(int(limit), 200))
    safe_offset = max(0, int(offset))
    page = await asyncio.to_thread(
        db.list_tl_screenshot_requests_paginated,
        status=status,
        submitter_api_key_id=submitter_api_key_id,
        limit=safe_limit,
        offset=safe_offset,
    )
    items = [user_routes._serialise_request(r) for r in page["items"]]
    next_offset = (
        safe_offset + safe_limit
        if safe_offset + safe_limit < int(page["total"])
        else None
    )
    return {
        "items": items,
        "total": int(page["total"]),
        "limit": safe_limit,
        "offset": safe_offset,
        "next_offset": next_offset,
    }


@router.get("/{request_id}")
async def get_request(
    request_id: str,
    _: str = Depends(require_admin),
) -> dict:
    row = await asyncio.to_thread(db.get_tl_screenshot_request, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    return user_routes._serialise_request(row, include_urls=True)


# ---------------------------------------------------------------------------
# Patch (edit OCR'd coords / label)
# ---------------------------------------------------------------------------

@router.patch("/{request_id}")
async def patch_request(
    request_id: str,
    body: PatchBody,
    api_key: str = Depends(require_admin),
) -> dict:
    row = await asyncio.to_thread(db.get_tl_screenshot_request, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    if row.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"cannot edit a {row.get('status')} request",
        )

    coords_a = _validate_coords(body.coords_a, "coords_a") if body.coords_a is not None else None
    coords_b = _validate_coords(body.coords_b, "coords_b") if body.coords_b is not None else None
    label = body.label.strip() if body.label is not None else None

    updated = await asyncio.to_thread(
        db.update_tl_screenshot_request_coords,
        request_id,
        coords_a=coords_a,
        coords_b=coords_b,
        label=label,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="not found")

    accounts_db.audit_log(
        api_key,
        "tl_screenshot.patch",
        target=request_id,
        metadata={
            "coords_a": coords_a,
            "coords_b": coords_b,
            "label": label,
        },
    )
    return user_routes._serialise_request(updated, include_urls=True)


# ---------------------------------------------------------------------------
# Approve / reject
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _delete_request_objects(row: dict) -> None:
    keys = [
        row.get("screenshot_a_key"),
        row.get("screenshot_b_key"),
        row.get("minimap_crop_a_key"),
        row.get("minimap_crop_b_key"),
        # Server-map crops live at deterministic R2 keys (no DB column).
        r2_storage.tl_screenshot_server_crop_key(row["id"], "a"),
        r2_storage.tl_screenshot_server_crop_key(row["id"], "b"),
    ]
    for k in keys:
        if k:
            try:
                r2_storage.delete_object(k)
            except Exception:
                logger.exception("tl_screenshot admin: delete %s failed", k)


def _delete_analysis_objects(row: dict) -> None:
    keys = [
        row.get("minimap_crop_a_key"),
        row.get("minimap_crop_b_key"),
        r2_storage.tl_screenshot_server_crop_key(row["id"], "a"),
        r2_storage.tl_screenshot_server_crop_key(row["id"], "b"),
    ]
    for k in keys:
        if k:
            try:
                r2_storage.delete_object(k)
            except Exception:
                logger.exception("tl_screenshot admin: delete analysis object %s failed", k)


@router.post("/{request_id}/retry-analysis")
async def retry_analysis(
    request_id: str,
    api_key: str = Depends(require_admin),
) -> dict:
    row = await asyncio.to_thread(db.get_tl_screenshot_request, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    if row.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"cannot retry analysis for a {row.get('status')} request",
        )

    # ``analysis_status='running'`` is normally protected, but the worker
    # lives in this process: if the previous process OOM-crashed the row
    # is stranded with no live thread owning it. Allow the reset in that
    # case so the admin isn't stuck waiting for a worker that will never
    # finish.
    from ..tasks import process_tl_screenshot_request as screenshot_worker
    is_running = row.get("analysis_status") == "running"
    worker_alive = screenshot_worker.is_job_running()
    if is_running and worker_alive:
        raise HTTPException(status_code=409, detail="analysis is already running")

    await asyncio.to_thread(_delete_analysis_objects, row)
    updated = await asyncio.to_thread(
        db.retry_tl_screenshot_analysis, request_id, allow_running=is_running
    )
    if updated is None:
        raise HTTPException(status_code=409, detail="request could not be requeued")

    spawned = False
    try:
        spawned = screenshot_worker.start_job()
    except Exception:
        logger.exception("tl_screenshot admin: failed to start retry worker")
    accounts_db.audit_log(
        api_key,
        "tl_screenshot.retry_analysis",
        target=request_id,
        metadata={
            "previous_analysis_status": row.get("analysis_status"),
            "worker_spawned": spawned,
            "recovered_stuck_running": is_running and not worker_alive,
        },
    )
    return {
        "retried": request_id,
        "worker_spawned": spawned,
        "request": user_routes._serialise_request(updated, include_urls=True),
    }


@router.post("/{request_id}/approve")
async def approve_request(
    request_id: str,
    body: ApproveBody,
    api_key: str = Depends(require_admin),
) -> dict:
    row = await asyncio.to_thread(db.get_tl_screenshot_request, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    if row.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"cannot approve a {row.get('status')} request",
        )

    coords_a = row.get("coords_a")
    coords_b = row.get("coords_b")
    if not _coords_complete(coords_a) or not _coords_complete(coords_b):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "coords_incomplete",
                "message": "Both coords_a and coords_b must have x and z before approval.",
            },
        )

    final_label = body.label if body.label is not None else (row.get("label") or "")
    final_label = (final_label or "").strip()[:_LABEL_MAX_LEN]

    submitter_api_key_id = row.get("submitter_api_key_id")
    submitter_display_name = row.get("submitter_display_name") or "Anonymous"
    admin_id = _admin_api_key_id(api_key)

    # Geojson stores +Z = south; coords are in world space (+Z = north). Flip.
    geo_x1 = int(coords_a["x"])
    geo_z1 = -int(coords_a["z"])
    geo_x2 = int(coords_b["x"])
    geo_z2 = -int(coords_b["z"])
    if geo_x1 == geo_x2 and geo_z1 == geo_z2:
        raise HTTPException(status_code=400, detail="endpoints are identical")

    segment_id = str(uuid.uuid4())
    feature = {
        "type": "Feature",
        "properties": {
            "id": segment_id,
            "label": final_label,
            "depth1": 0,
            "depth2": 0,
            "tag": "user",
            "origin": "user",
            "added_by": submitter_display_name,
            "added_by_user_id": str(submitter_api_key_id) if submitter_api_key_id else None,
            "added_at": _now_iso(),
            "source": "screenshot",
        },
        "geometry": {
            "type": "LineString",
            "coordinates": [
                [geo_x1, geo_z1],
                [geo_x2, geo_z2],
            ],
        },
    }

    async with contribute_tls_routes._translocators_lock:
        data = await asyncio.to_thread(contribute_tls_routes._load_translocators_file)
        data.setdefault("features", []).append(feature)
        await asyncio.to_thread(contribute_tls_routes._save_translocators_file, data)

    submission_stats = {
        "source": "screenshot",
        "request_id": request_id,
        "minimap_match": row.get("minimap_match"),
        "validation_warnings": row.get("validation_warnings") or [],
        "ocr_a": row.get("ocr_a"),
        "ocr_b": row.get("ocr_b"),
        "approved_by_admin_api_key_id": admin_id,
    }
    await asyncio.to_thread(
        db.insert_translocator_audit,
        segment_id=segment_id,
        action="add",
        actor_api_key_id=str(submitter_api_key_id) if submitter_api_key_id else None,
        actor_display_name=submitter_display_name,
        after_payload=feature,
        submission_stats=submission_stats,
    )

    _delete_request_objects(row)

    updated = await asyncio.to_thread(
        db.finalise_tl_screenshot_request,
        request_id,
        status="approved",
        decision_actor_api_key_id=admin_id,
        decision_reason=None,
        resulting_segment_id=segment_id,
    )

    accounts_db.audit_log(
        api_key,
        "tl_screenshot.approve",
        target=request_id,
        metadata={"segment_id": segment_id, "feature": feature},
    )
    return {
        "approved": request_id,
        "segment_id": segment_id,
        "feature": feature,
        "request": user_routes._serialise_request(updated) if updated else None,
    }


@router.post("/{request_id}/reject")
async def reject_request(
    request_id: str,
    body: RejectBody,
    api_key: str = Depends(require_admin),
) -> dict:
    row = await asyncio.to_thread(db.get_tl_screenshot_request, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    if row.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"cannot reject a {row.get('status')} request",
        )

    admin_id = _admin_api_key_id(api_key)
    _delete_request_objects(row)
    updated = await asyncio.to_thread(
        db.finalise_tl_screenshot_request,
        request_id,
        status="rejected",
        decision_actor_api_key_id=admin_id,
        decision_reason=body.reason.strip(),
        resulting_segment_id=None,
    )
    accounts_db.audit_log(
        api_key,
        "tl_screenshot.reject",
        target=request_id,
        metadata={"reason": body.reason.strip()},
    )
    return {
        "rejected": request_id,
        "request": user_routes._serialise_request(updated) if updated else None,
    }
