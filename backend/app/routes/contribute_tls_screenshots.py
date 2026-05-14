"""Screenshot-based translocator contribution endpoints.

Two-part flow per submission:
  1. ``POST /contribute-tls/screenshots/upload-url`` returns a request_id
     and two presigned PUT URLs (slot a + b). The browser uploads each
     PNG directly to R2.
  2. ``POST /contribute-tls/screenshots/complete`` registers the request
     in the database and enqueues the analysis worker.

The worker (:mod:`backend.app.tasks.process_tl_screenshot_request`) does
EXIF strip + OCR + minimap match + warning aggregation, writing results
back to the row. Admin then reviews & approves/rejects via
:mod:`backend.app.routes.admin_translocators_screenshots`.

Gated by feature flag ``translocator_screenshot_contributions`` (default
OFF). Account-required: anonymous keys cannot submit.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_active_user
from ..core import database as db
from ..core import feature_flags
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/contribute-tls/screenshots", tags=["contribute-tls-screenshots"])


_FLAG_KEY = "translocator_screenshot_contributions"
_LABEL_MAX_LEN = 200
_MAX_PENDING_PER_USER = 15
_UPLOAD_URL_TTL_SECONDS = 900
_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024  # 8 MiB

_ACCOUNT_REQUIRED_DETAIL = {
    "code": "account_required",
    "message": "Create an account to contribute translocator screenshots.",
}
_FLAG_OFF_DETAIL = {
    "code": "feature_disabled",
    "message": "Screenshot-based translocator contributions are currently disabled.",
}


def _require_account_user(ctx: dict) -> dict:
    user = ctx.get("user")
    if user is None:
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)
    return user


def _ctx_api_key_id(ctx: dict) -> Optional[str]:
    info = ctx.get("info") or {}
    raw = info.get("id")
    return str(raw) if raw is not None else None


def _flag_enabled() -> bool:
    return feature_flags.is_feature_enabled(_FLAG_KEY)


def _ensure_flag_on() -> None:
    if not _flag_enabled():
        # 404 hides the feature when off (matches existing pattern).
        raise HTTPException(status_code=404, detail=_FLAG_OFF_DETAIL)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class UploadUrlResponse(BaseModel):
    request_id: str
    upload_url_a: str
    upload_url_b: str
    screenshot_a_key: str
    screenshot_b_key: str
    expires_in: int


class CompleteBody(BaseModel):
    request_id: str
    label: Optional[str] = Field(default=None, max_length=_LABEL_MAX_LEN)


class WithdrawResponse(BaseModel):
    withdrawn: str


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _serialise_request(row: dict, *, include_urls: bool = False) -> dict:
    out = {
        "id": row["id"],
        "status": row["status"],
        "analysis_status": row.get("analysis_status"),
        "analysis_error": row.get("analysis_error"),
        "submitter_api_key_id": row.get("submitter_api_key_id"),
        "submitter_display_name": row.get("submitter_display_name"),
        "label": row.get("label"),
        "ocr_a": row.get("ocr_a"),
        "ocr_b": row.get("ocr_b"),
        "coords_a": row.get("coords_a"),
        "coords_b": row.get("coords_b"),
        "validation_warnings": row.get("validation_warnings") or [],
        "minimap_match": row.get("minimap_match"),
        "decision_actor_api_key_id": row.get("decision_actor_api_key_id"),
        "decision_reason": row.get("decision_reason"),
        "decision_at": _iso(row.get("decision_at")),
        "resulting_segment_id": row.get("resulting_segment_id"),
        "screenshot_a_taken_at": _iso(row.get("screenshot_a_taken_at")),
        "screenshot_b_taken_at": _iso(row.get("screenshot_b_taken_at")),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }
    if include_urls:
        out["screenshot_a_url"] = _maybe_presign(row.get("screenshot_a_key"))
        out["screenshot_b_url"] = _maybe_presign(row.get("screenshot_b_key"))
        out["minimap_a_url"] = _maybe_presign(row.get("minimap_crop_a_key"))
        out["minimap_b_url"] = _maybe_presign(row.get("minimap_crop_b_key"))
        # Server-map crop the analysis worker matched against. Stored at a
        # deterministic R2 key so we don't need a DB column; presign with
        # verify_exists=True so we return null when the worker couldn't
        # sample (no level-5 chunks for this area).
        out["server_minimap_a_url"] = _maybe_presign(
            r2_storage.tl_screenshot_server_crop_key(row["id"], "a"),
            verify_exists=True,
        )
        out["server_minimap_b_url"] = _maybe_presign(
            r2_storage.tl_screenshot_server_crop_key(row["id"], "b"),
            verify_exists=True,
        )
    return out


def _iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def _maybe_presign(key: Optional[str], *, verify_exists: bool = False) -> Optional[str]:
    if not key:
        return None
    try:
        url = r2_storage.generate_presigned_download_url(
            key,
            expires_seconds=_UPLOAD_URL_TTL_SECONDS,
            content_type="image/png",
            verify_exists=verify_exists,
        )
        return url or None
    except Exception:
        logger.exception("tl_screenshot: presign failed for %s", key)
        return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/upload-url", response_model=UploadUrlResponse)
async def request_upload_urls(
    ctx: dict = Depends(require_active_user),
) -> UploadUrlResponse:
    _ensure_flag_on()
    user = _require_account_user(ctx)
    api_key_id = _ctx_api_key_id(ctx)
    if not api_key_id:
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)

    pending = await asyncio.to_thread(
        db.count_pending_tl_screenshot_requests_for_user, api_key_id
    )
    if pending >= _MAX_PENDING_PER_USER:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "too_many_pending",
                "message": (
                    f"You already have {pending} pending screenshot requests. "
                    f"Wait for the admin to review them before submitting more."
                ),
            },
        )

    request_id = str(uuid.uuid4())
    key_a = r2_storage.tl_screenshot_pending_key(request_id, "a")
    key_b = r2_storage.tl_screenshot_pending_key(request_id, "b")
    url_a = await asyncio.to_thread(
        r2_storage.generate_presigned_upload_url,
        key_a,
        expires_seconds=_UPLOAD_URL_TTL_SECONDS,
        content_type="image/png",
    )
    url_b = await asyncio.to_thread(
        r2_storage.generate_presigned_upload_url,
        key_b,
        expires_seconds=_UPLOAD_URL_TTL_SECONDS,
        content_type="image/png",
    )
    return UploadUrlResponse(
        request_id=request_id,
        upload_url_a=url_a,
        upload_url_b=url_b,
        screenshot_a_key=key_a,
        screenshot_b_key=key_b,
        expires_in=_UPLOAD_URL_TTL_SECONDS,
    )


@router.post("/complete")
async def complete_upload(
    body: CompleteBody,
    ctx: dict = Depends(require_active_user),
) -> dict:
    _ensure_flag_on()
    user = _require_account_user(ctx)
    api_key_id = _ctx_api_key_id(ctx)
    if not api_key_id:
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)

    # Re-check the per-user pending cap so a racing client can't bypass it.
    pending = await asyncio.to_thread(
        db.count_pending_tl_screenshot_requests_for_user, api_key_id
    )
    if pending >= _MAX_PENDING_PER_USER:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "too_many_pending",
                "message": (
                    f"You already have {pending} pending screenshot requests."
                ),
            },
        )

    request_id = body.request_id
    try:
        uuid.UUID(request_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="invalid request_id")

    key_a = r2_storage.tl_screenshot_pending_key(request_id, "a")
    key_b = r2_storage.tl_screenshot_pending_key(request_id, "b")

    # Verify both objects exist and are within the size cap.
    for slot, key in (("a", key_a), ("b", key_b)):
        try:
            size = await asyncio.to_thread(r2_storage.get_object_size, key)
        except FileNotFoundError:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "screenshot_missing",
                    "message": f"Screenshot {slot.upper()} was not uploaded.",
                },
            )
        if size > _MAX_SCREENSHOT_BYTES:
            # Best-effort cleanup so the orphaned object doesn't linger.
            try:
                r2_storage.delete_object(key)
            except Exception:
                pass
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "screenshot_too_large",
                    "message": (
                        f"Screenshot {slot.upper()} is {size} bytes, "
                        f"max {_MAX_SCREENSHOT_BYTES}."
                    ),
                },
            )

    label = body.label.strip() if body.label else None
    if label and len(label) > _LABEL_MAX_LEN:
        raise HTTPException(status_code=400, detail="label too long")

    display_name = (user.get("display_name") if user else None) or "Anonymous"

    row = await asyncio.to_thread(
        db.insert_tl_screenshot_request,
        request_id=request_id,
        submitter_api_key_id=api_key_id,
        submitter_display_name=display_name,
        screenshot_a_key=key_a,
        screenshot_b_key=key_b,
        screenshot_a_taken_at=None,
        screenshot_b_taken_at=None,
        label=label,
    )

    # Kick the analysis worker (no-op if already running).
    try:
        from ..tasks import process_tl_screenshot_request as worker
        worker.start_job()
    except Exception:
        logger.exception("tl_screenshot: failed to start worker")

    return _serialise_request(row, include_urls=False)


@router.get("/mine")
async def list_my_requests(
    ctx: dict = Depends(require_active_user),
) -> dict:
    _ensure_flag_on()
    user = _require_account_user(ctx)
    api_key_id = _ctx_api_key_id(ctx)
    if not api_key_id:
        return {"items": [], "total": 0}
    page = await asyncio.to_thread(
        db.list_tl_screenshot_requests_paginated,
        submitter_api_key_id=api_key_id,
        limit=50,
        offset=0,
    )
    return {
        "items": [_serialise_request(r) for r in page["items"]],
        "total": int(page["total"]),
    }


@router.post("/{request_id}/withdraw", response_model=WithdrawResponse)
async def withdraw_request(
    request_id: str,
    ctx: dict = Depends(require_active_user),
) -> WithdrawResponse:
    _ensure_flag_on()
    _require_account_user(ctx)
    api_key_id = _ctx_api_key_id(ctx)
    if not api_key_id:
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)

    row = await asyncio.to_thread(db.get_tl_screenshot_request, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    if str(row.get("submitter_api_key_id")) != str(api_key_id):
        raise HTTPException(status_code=403, detail="not your request")
    if row.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"cannot withdraw a {row.get('status')} request",
        )

    # Delete R2 objects (best-effort).
    for k in (
        row.get("screenshot_a_key"),
        row.get("screenshot_b_key"),
        row.get("minimap_crop_a_key"),
        row.get("minimap_crop_b_key"),
    ):
        if k:
            try:
                r2_storage.delete_object(k)
            except Exception:
                logger.exception("tl_screenshot: delete %s failed", k)

    await asyncio.to_thread(
        db.finalise_tl_screenshot_request,
        request_id,
        status="withdrawn",
        decision_actor_api_key_id=api_key_id,
        decision_reason=None,
        resulting_segment_id=None,
    )
    return WithdrawResponse(withdrawn=request_id)
