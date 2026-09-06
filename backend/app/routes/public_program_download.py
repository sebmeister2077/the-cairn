"""Public, unauthenticated endpoints for redeeming program-download links.

A program-download link is an opaque token an admin issues via
``POST /api/admin/program-downloads``. Anyone with the URL can:

* ``GET /api/public/program-download/<token>/info`` — read non-secret metadata
  (label, status, filename, size) so the frontend ``/download/<token>`` page
  can render before the user clicks download.
* ``GET /api/public/program-download/<token>`` — download a zip containing the
  current VSProxy build. For a full link the zip also carries ``license.key`` +
  ``publish.key`` (the per-recipient license code and API key); an "update only"
  link (``include_keys`` false) ships just the exe. Assembled on the fly.

Each redemption is logged (hashed IP + truncated UA) for the admin view, until
the link expires or is revoked.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .. import auth as _auth
from ..core import database as db
from ..core import r2_storage
from ..core import usage_events
from ..rate_limiter import check_scoped_rate_limit


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/public", tags=["public-program-download"])

_USER_AGENT_MAX_LEN = 256

_README_TEXT = """VSProxy — pre-configured build
================================

This package was prepared for you by the map-features project administrator.

Contents
--------
  VSProxy.exe   the proxy, pre-configured with its default arguments
  license.key   your personal license (do not share)
  publish.key   your personal upload key (do not share)

How to run
----------
  1. Keep all three files in the same folder.
  2. Double-click VSProxy.exe (or run it from a terminal).
  3. Launch Vintage Story and connect through the proxy as instructed.

The exe reads license.key and publish.key from this folder automatically —
you do not need to pass any command-line arguments.

Unofficial tool — not affiliated with or endorsed by Anego Studios.
"""

_README_TEXT_EXE_ONLY = """VSProxy — program update
=========================

This package contains only the updated VSProxy program.

Contents
--------
  VSProxy.exe   the proxy, pre-configured with its default arguments

How to update
-------------
  1. Replace your existing VSProxy.exe with this one.
  2. Keep your existing license.key and publish.key in the same folder.
  3. Run VSProxy.exe as before.

This update does not change your license or upload key — reuse the ones you
already have.

Unofficial tool — not affiliated with or endorsed by Anego Studios.
"""


def _status(link: dict, now: datetime) -> Optional[str]:
    if link.get("revoked_at") is not None:
        return "revoked"
    exp = link.get("expires_at")
    if exp is not None and exp <= now:
        return "expired"
    return "active"


def _record_failure(link_id: int, request: Request, reason: str) -> None:
    try:
        db.record_program_download_redemption(
            link_id,
            ip_hash=_auth._hash_ip(_auth._get_client_ip(request)),
            user_agent=(request.headers.get("user-agent") or "")[:_USER_AGENT_MAX_LEN]
            or None,
            success=False,
            failure_reason=reason,
        )
    except Exception:
        logger.exception(
            "program-download: failed to record failure for link_id=%s", link_id
        )


def _safe_zip_name(label: Optional[str]) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", (label or "").strip()).strip("-")
    return f"VSProxy-{base}.zip" if base else "VSProxy.zip"


@router.get("/program-download/{token}/info")
async def program_download_info(token: str, request: Request):
    ip_hash = _auth._hash_ip(_auth._get_client_ip(request))
    check_scoped_rate_limit(ip_hash, "public-program-download-info", 60, 60)

    link = db.get_program_download_link_by_token(token)
    if link is None:
        raise HTTPException(status_code=404, detail="not_found")

    now = datetime.now(timezone.utc)
    status = _status(link, now)
    build = db.get_program_build(link["build_id"]) if link.get("build_id") else None
    return {
        "label": link.get("label"),
        "status": status,
        "expires_at": link["expires_at"].isoformat() if link.get("expires_at") else None,
        "filename": (build or {}).get("original_filename") or "VSProxy.exe",
        "size_bytes": (build or {}).get("size_bytes"),
        "include_keys": bool(link.get("include_keys", True)),
    }


@router.get("/program-download/{token}")
async def redeem_program_download(token: str, request: Request):
    ip_hash = _auth._hash_ip(_auth._get_client_ip(request))
    # Tighter cap than /info — assembling a zip is comparatively expensive.
    check_scoped_rate_limit(ip_hash, "public-program-download", 10, 60)

    link = db.get_program_download_link_by_token(token)
    if link is None:
        raise HTTPException(status_code=404, detail="not_found")

    now = datetime.now(timezone.utc)
    if link.get("revoked_at") is not None:
        _record_failure(link["id"], request, "revoked")
        raise HTTPException(status_code=404, detail="not_found")
    if link.get("expires_at") is not None and link["expires_at"] <= now:
        _record_failure(link["id"], request, "expired")
        raise HTTPException(status_code=404, detail="not_found")

    build = db.get_program_build(link["build_id"]) if link.get("build_id") else None
    if build is None or not build.get("r2_key"):
        _record_failure(link["id"], request, "build_missing")
        raise HTTPException(status_code=410, detail="build_unavailable")

    exe_name = build.get("original_filename") or "VSProxy.exe"
    tmp_dir = tempfile.mkdtemp(prefix="vsproxy-dl-")
    exe_path = os.path.join(tmp_dir, "build.exe")
    zip_path = os.path.join(tmp_dir, "package.zip")

    def _cleanup() -> None:
        for p in (exe_path, zip_path):
            try:
                os.unlink(p)
            except OSError:
                pass
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

    try:
        try:
            r2_storage.download_to_path(build["r2_key"], exe_path)
        except FileNotFoundError:
            _record_failure(link["id"], request, "object_missing")
            _cleanup()
            raise HTTPException(status_code=410, detail="build_unavailable")

        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(exe_path, arcname=exe_name)
            if link.get("include_keys", True) and link.get("license_code"):
                zf.writestr("license.key", link["license_code"])
                zf.writestr("publish.key", link["api_key"])
                zf.writestr("README.txt", _README_TEXT)
            else:
                zf.writestr("README.txt", _README_TEXT_EXE_ONLY)
        # The raw exe is now inside the zip; free the disk copy early.
        try:
            os.unlink(exe_path)
        except OSError:
            pass
    except HTTPException:
        raise
    except Exception:
        logger.exception("program-download: failed to assemble zip for link_id=%s", link["id"])
        _record_failure(link["id"], request, "assembly_failed")
        _cleanup()
        raise HTTPException(status_code=500, detail="assembly_failed")

    try:
        db.record_program_download_redemption(
            link["id"],
            ip_hash=ip_hash,
            user_agent=(request.headers.get("user-agent") or "")[:_USER_AGENT_MAX_LEN]
            or None,
            success=True,
            failure_reason=None,
        )
        usage_events.record(
            "program.downloaded",
            category="download",
            metadata={"link_id": link["id"], "label": link.get("label")},
            ip_hash=ip_hash,
        )
    except Exception:
        logger.exception(
            "program-download: failed to record success for link_id=%s", link["id"]
        )

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=_safe_zip_name(link.get("label")),
        background=BackgroundTask(_cleanup),
    )
