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

from fastapi import APIRouter, HTTPException, Query, Request
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
_ALLOWED_PLATFORMS = ("win-x64", "linux-x64")


def _exe_name(platform: str) -> str:
    return "VSProxy.exe" if platform.startswith("win") else "VSProxy"


def _platform_label(platform: str) -> str:
    return "Windows (64-bit)" if platform.startswith("win") else "Linux (64-bit)"

_README_TEXT = """VSProxy — pre-configured build
================================

This package was prepared for you by the Cairn project administrator.

Contents
--------
  {exe}   the proxy, pre-configured with its default arguments
  license.key   your personal license (do not share)
  publish.key   your personal upload key (do not share)

How to run
----------
  1. Keep all three files in the same folder.
  2. Run {exe} (double-click on Windows, or launch it from a terminal).
  3. Launch Vintage Story and connect through the proxy as instructed.

The program reads license.key and publish.key from this folder automatically —
you do not need to pass any command-line arguments.
"""

_README_TEXT_EXE_ONLY = """VSProxy — program update
=========================

This package contains only the updated VSProxy program.

Contents
--------
  {exe}   the proxy, pre-configured with its default arguments

How to update
-------------
  1. Replace your existing {exe} with this one.
  2. Keep your existing license.key and publish.key in the same folder.
  3. Run {exe} as before.

This update does not change your license or upload key — reuse the ones you
already have.

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


def _safe_zip_name(label: Optional[str], platform: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", (label or "").strip()).strip("-")
    stem = f"VSProxy-{base}" if base else "VSProxy"
    return f"{stem}-{platform}.zip"


@router.get("/program-download/{token}/info")
async def program_download_info(token: str, request: Request):
    ip_hash = _auth._hash_ip(_auth._get_client_ip(request))
    check_scoped_rate_limit(ip_hash, "public-program-download-info", 60, 60)

    link = db.get_program_download_link_by_token(token)
    if link is None:
        raise HTTPException(status_code=404, detail="not_found")

    now = datetime.now(timezone.utc)
    status = _status(link, now)
    # The link is platform-agnostic; advertise whichever platforms currently
    # have a published build so the download page can offer a choice.
    platforms = []
    for p in _ALLOWED_PLATFORMS:
        build = db.get_current_program_build(p)
        if build and build.get("r2_key"):
            platforms.append(
                {
                    "platform": p,
                    "label": _platform_label(p),
                    "filename": _exe_name(p),
                    "size_bytes": build.get("size_bytes"),
                    "version_label": build.get("version_label"),
                }
            )
    return {
        "label": link.get("label"),
        "status": status,
        "expires_at": link["expires_at"].isoformat() if link.get("expires_at") else None,
        "include_keys": bool(link.get("include_keys", True)),
        "platforms": platforms,
    }


@router.get("/program-download/{token}")
async def redeem_program_download(
    token: str,
    request: Request,
    platform: str = Query("win-x64", max_length=32),
):
    ip_hash = _auth._hash_ip(_auth._get_client_ip(request))
    # Tighter cap than /info — assembling a zip is comparatively expensive.
    check_scoped_rate_limit(ip_hash, "public-program-download", 10, 60)

    if platform not in _ALLOWED_PLATFORMS:
        raise HTTPException(status_code=400, detail="invalid_platform")

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

    build = db.get_current_program_build(platform)
    if build is None or not build.get("r2_key"):
        _record_failure(link["id"], request, "build_missing")
        raise HTTPException(status_code=410, detail="build_unavailable")

    exe_name = _exe_name(platform)
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
                zf.writestr("README.txt", _README_TEXT.format(exe=exe_name))
            else:
                zf.writestr("README.txt", _README_TEXT_EXE_ONLY.format(exe=exe_name))
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
            metadata={
                "link_id": link["id"],
                "label": link.get("label"),
                "platform": platform,
            },
            ip_hash=ip_hash,
        )
    except Exception:
        logger.exception(
            "program-download: failed to record success for link_id=%s", link["id"]
        )

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=_safe_zip_name(link.get("label"), platform),
        background=BackgroundTask(_cleanup),
    )


@router.get("/program/latest/{platform}")
async def download_latest_raw(platform: str, request: Request):
    """Raw, unauthenticated download of the current build for a platform — the
    URL the VSProxy auto-updater fetches. No zip, no keys, just the binary."""
    ip_hash = _auth._hash_ip(_auth._get_client_ip(request))
    check_scoped_rate_limit(ip_hash, "public-program-latest", 30, 60)

    if platform not in _ALLOWED_PLATFORMS:
        raise HTTPException(status_code=400, detail="invalid_platform")
    build = db.get_current_program_build(platform)
    if build is None or not build.get("r2_key"):
        raise HTTPException(status_code=404, detail="not_found")

    tmp_dir = tempfile.mkdtemp(prefix="vsproxy-latest-")
    exe_path = os.path.join(tmp_dir, _exe_name(platform))

    def _cleanup() -> None:
        try:
            os.unlink(exe_path)
        except OSError:
            pass
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

    try:
        r2_storage.download_to_path(build["r2_key"], exe_path)
    except FileNotFoundError:
        _cleanup()
        raise HTTPException(status_code=404, detail="not_found")
    except Exception:
        logger.exception("program-latest: download failed for %s", platform)
        _cleanup()
        raise HTTPException(status_code=500, detail="download_failed")

    return FileResponse(
        exe_path,
        media_type="application/octet-stream",
        filename=_exe_name(platform),
        background=BackgroundTask(_cleanup),
    )
