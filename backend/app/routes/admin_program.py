"""Admin endpoints for distributing pre-configured VSProxy builds.

Workflow
--------
1. ``POST /admin/program-downloads/build/upload-url`` — mint a presigned R2
   PUT URL so the browser can upload the compiled ``VSProxy.exe`` (built
   locally with its non-secret baked args) straight to storage.
2. ``POST /admin/program-downloads/build/finalize`` — register the uploaded
   object as the new *current* build.
3. ``POST /admin/program-downloads`` — mint a per-recipient license + an API
   key carrying the ``map_features_publish`` permission, and return a friendly
   ``FRONTEND_BASE_URL/download/<token>`` link. The recipient's zip (assembled
   on download, see ``public_program_download.py``) ships the exe plus
   ``license.key`` + ``publish.key`` next to it.

All routes require the env-var admin key (``require_admin``). The generated
license mirrors the options of ``POST /admin/licenses`` — the ``label`` is the
key field for tracking *who* a link was handed to.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..config import settings
from ..core import accounts_db
from ..core import database as db
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/program-downloads", tags=["admin-program"])

_LABEL_MAX_LEN = 200
_NOTES_MAX_LEN = 1000
# Permission granted to every key minted here — the VSProxy map-export ingest.
_MAP_FEATURES_PERMISSION = "map_features_publish"
# Presigned PUT lifetime for the browser → R2 build upload.
_UPLOAD_URL_TTL_SECONDS = 15 * 60
# Hard ceiling on the declared build size (self-contained single-file exe is
# well under this; guards against a bogus finalize registering a huge object).
_MAX_BUILD_BYTES = 300 * 1024 * 1024


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _download_url(request: Request, token: str) -> str:
    """Friendly, frontend-facing URL a recipient opens to fetch their build."""
    base = (
        settings.FRONTEND_BASE_URL
        or settings.PUBLIC_BASE_URL
        or str(request.base_url).rstrip("/")
    )
    return f"{base}/download/{token}"


def _serialize_build(build: Optional[dict]) -> Optional[dict]:
    if not build:
        return None
    return {
        "id": build["id"],
        "original_filename": build.get("original_filename"),
        "version_label": build.get("version_label"),
        "size_bytes": build.get("size_bytes"),
        "sha256": build.get("sha256"),
        "uploaded_at": _iso(build.get("uploaded_at")),
    }


def _serialize_link(
    link: dict,
    *,
    request: Optional[Request] = None,
    build: Optional[dict] = None,
) -> dict:
    now = datetime.now(timezone.utc)
    expires_at = link.get("expires_at")
    revoked_at = link.get("revoked_at")
    if revoked_at is not None:
        status = "revoked"
    elif expires_at is not None and expires_at <= now:
        status = "expired"
    else:
        status = "active"
    out = {
        "id": link["id"],
        "token": link["token"],
        "label": link.get("label"),
        "license_code": link.get("license_code"),
        "api_key": link.get("api_key"),
        "max_activations": link.get("max_activations"),
        "expires_at": _iso(expires_at),
        "notes": link.get("notes"),
        "created_at": _iso(link.get("created_at")),
        "revoked_at": _iso(revoked_at),
        "redeem_count": int(link.get("redeem_count") or 0),
        "success_count": int(link.get("success_count") or 0),
        "last_redeem_at": _iso(link.get("last_redeem_at")),
        "status": status,
        "build_filename": (build or {}).get("original_filename"),
        "active_activations": int(link.get("active_activations") or 0),
        "over_limit_attempts": int(link.get("over_limit_attempts") or 0),
        "include_keys": bool(link.get("include_keys", True)),
    }
    if request is not None:
        out["url"] = _download_url(request, link["token"])
    return out


# ---------------------------------------------------------------------------
# Build upload
# ---------------------------------------------------------------------------
class BuildUploadUrlBody(BaseModel):
    filename: str = Field(..., max_length=260)


@router.post("/build/upload-url")
async def create_build_upload_url(
    body: BuildUploadUrlBody, _admin: str = Depends(require_admin)
):
    # Opaque, unguessable object key so a leaked URL can't enumerate builds.
    token = secrets.token_urlsafe(16)
    r2_key = f"program/builds/{token}.exe"
    try:
        upload_url = r2_storage.generate_presigned_upload_url(
            r2_key,
            expires_seconds=_UPLOAD_URL_TTL_SECONDS,
            content_type="application/octet-stream",
        )
    except Exception as exc:
        logger.exception("program build upload-url failed")
        raise HTTPException(status_code=500, detail="presign_failed") from exc
    return {
        "token": token,
        "r2_key": r2_key,
        "upload_url": upload_url,
        "content_type": "application/octet-stream",
        "expires_in": _UPLOAD_URL_TTL_SECONDS,
    }


class BuildFinalizeBody(BaseModel):
    r2_key: str = Field(..., max_length=300)
    original_filename: Optional[str] = Field(None, max_length=260)
    version_label: Optional[str] = Field(None, max_length=100)
    sha256: Optional[str] = Field(None, max_length=64)


@router.post("/build/finalize")
async def finalize_build(
    body: BuildFinalizeBody, admin_key: str = Depends(require_admin)
):
    # Only accept keys we minted, to stop a finalize pointing at an arbitrary
    # object elsewhere in the bucket.
    if not body.r2_key.startswith("program/builds/"):
        raise HTTPException(status_code=400, detail="invalid_r2_key")
    try:
        size_bytes = r2_storage.get_object_size(body.r2_key)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="upload_not_found")
    if size_bytes <= 0:
        raise HTTPException(status_code=400, detail="upload_empty")
    if size_bytes > _MAX_BUILD_BYTES:
        raise HTTPException(status_code=413, detail="upload_too_large")

    build = db.create_program_build(
        body.r2_key,
        original_filename=(body.original_filename or "VSProxy.exe"),
        version_label=body.version_label,
        size_bytes=size_bytes,
        sha256=body.sha256,
        uploaded_by=admin_key,
    )
    accounts_db.audit_log(
        admin_key,
        "program.build_upload",
        target=body.r2_key,
        metadata={
            "build_id": build["id"],
            "filename": body.original_filename,
            "version": body.version_label,
            "size_bytes": size_bytes,
        },
    )
    return {"build": _serialize_build(build)}


@router.get("/build")
async def get_current_build(_admin: str = Depends(require_admin)):
    return {"build": _serialize_build(db.get_current_program_build())}


# ---------------------------------------------------------------------------
# Link generation
# ---------------------------------------------------------------------------
class CreateLinkBody(BaseModel):
    label: Optional[str] = Field(None, max_length=_LABEL_MAX_LEN)
    max_activations: int = Field(2, ge=1, le=20)
    expires_at: Optional[datetime] = None
    notes: Optional[str] = Field(None, max_length=_NOTES_MAX_LEN)
    # When false, the link is an "update only" link: the zip ships just the exe,
    # with no minted license / API key (nothing to activate or track).
    include_keys: bool = True


@router.post("")
async def create_download_link(
    body: CreateLinkBody, request: Request, admin_key: str = Depends(require_admin)
):
    build = db.get_current_program_build()
    if build is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "no_build",
                "message": "Upload a VSProxy build before generating links.",
            },
        )

    label = (body.label or "").strip() or None

    license_code: Optional[str] = None
    api_key: Optional[str] = None
    if body.include_keys:
        # 1. Mint the license (same shape as POST /admin/licenses).
        license_code = "vsp_" + secrets.token_urlsafe(24)
        db.create_license(
            license_code, label, body.max_activations, body.expires_at, body.notes
        )

        # 2. Mint the API key and grant the map-export publish permission.
        api_key = secrets.token_urlsafe(32)
        db.create_api_key(
            api_key,
            name=f"VSProxy map-export — {label or 'unlabelled'}",
            permissions="contribute",
            consume_once=False,
        )
        if not db.set_api_key_extra_permission(
            api_key, _MAP_FEATURES_PERMISSION, True
        ):
            logger.warning(
                "program link: failed to grant %s to freshly minted key",
                _MAP_FEATURES_PERMISSION,
            )

    # 3. Record the link. Its expiry tracks the license expiry (may be None).
    token = secrets.token_urlsafe(24)
    link = db.create_program_download_link(
        token=token,
        label=label,
        license_code=license_code,
        api_key=api_key,
        build_id=build["id"],
        max_activations=body.max_activations,
        expires_at=body.expires_at,
        notes=body.notes,
        created_by=admin_key,
        include_keys=body.include_keys,
    )
    accounts_db.audit_log(
        admin_key,
        "program.create_download_link",
        target=label or token,
        metadata={
            "link_id": link["id"],
            "license_code": license_code,
            "build_id": build["id"],
            "include_keys": body.include_keys,
        },
    )
    return _serialize_link(link, request=request, build=build)


@router.get("")
async def list_download_links(
    request: Request,
    status: str = Query("all", pattern="^(all|active|expired|revoked)$"),
    q: Optional[str] = Query(None, max_length=200),
    min_machines: Optional[int] = Query(None, ge=0),
    max_machines: Optional[int] = Query(None, ge=0),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    _admin: str = Depends(require_admin),
):
    result = db.list_program_download_links(
        status=status,
        q=(q or "").strip() or None,
        min_machines=min_machines,
        max_machines=max_machines,
        offset=offset,
        limit=limit,
    )
    rows = result["items"]
    builds: dict = {}

    def _build_for(bid):
        if bid is None:
            return None
        if bid not in builds:
            builds[bid] = db.get_program_build(bid)
        return builds[bid]

    links = [
        _serialize_link(r, request=request, build=_build_for(r.get("build_id")))
        for r in rows
    ]
    total = result["total"]
    next_offset = offset + len(links) if offset + len(links) < total else None
    return {"links": links, "total": total, "next_offset": next_offset}


@router.get("/{link_id}/redemptions")
async def list_link_redemptions(link_id: int, _admin: str = Depends(require_admin)):
    if not db.get_program_download_link(link_id):
        raise HTTPException(status_code=404, detail="link_not_found")
    rows = db.list_program_download_redemptions(link_id)
    return {
        "redemptions": [
            {
                "id": r["id"],
                "redeemed_at": _iso(r.get("redeemed_at")),
                "ip_hash_short": (r.get("ip_hash") or "")[:12] or None,
                "user_agent": r.get("user_agent"),
                "success": bool(r.get("success")),
                "failure_reason": r.get("failure_reason"),
            }
            for r in rows
        ]
    }


@router.delete("/{link_id}")
async def revoke_download_link(link_id: int, admin_key: str = Depends(require_admin)):
    existing = db.get_program_download_link(link_id)
    if not existing:
        raise HTTPException(status_code=404, detail="link_not_found")
    updated = db.revoke_program_download_link(link_id, admin_key)
    if updated is None:
        # Already revoked — idempotent.
        return {"revoked": False, "link": _serialize_link(existing)}
    accounts_db.audit_log(
        admin_key,
        "program.revoke_download_link",
        target=existing.get("label") or existing["token"],
        metadata={"link_id": link_id},
    )
    return {"revoked": True, "link": _serialize_link(updated)}
