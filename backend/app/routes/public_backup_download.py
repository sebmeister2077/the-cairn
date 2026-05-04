"""Public, unauthenticated endpoint for redeeming shareable backup-download links.

A backup-download link is a long opaque token issued by an admin via
``POST /api/admin/backups/download-links``. Anyone who has the URL can
exchange the token for a short-lived presigned R2 GET URL and download
the underlying ``backups/...`` object — until the link expires or is
revoked. Each redemption is logged so admins can see who has been
pulling the file (hashed IP + truncated UA).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from .. import auth as _auth
from ..core import accounts_db
from ..core import r2_storage
from ..rate_limiter import check_scoped_rate_limit


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/public", tags=["public-backup-download"])

# Presigned URL TTL for the redirect response. Kept short — the *token* is the
# admin-shared credential; the presigned URL only ever briefly appears in the
# 302 Location header.
_REDIRECT_PRESIGN_SECONDS = 5 * 60

# Cap user-agent length to keep the audit table tidy.
_USER_AGENT_MAX_LEN = 256


def _record_failure(link_id: int, request: Request, reason: str) -> None:
    try:
        accounts_db.record_backup_download_redemption(
            link_id,
            ip_hash=_auth._hash_ip(_auth._get_client_ip(request)),
            user_agent=(request.headers.get("user-agent") or "")[:_USER_AGENT_MAX_LEN] or None,
            success=False,
            failure_reason=reason,
        )
    except Exception:
        logger.exception("backup-download: failed to record failure for link_id=%s", link_id)


@router.get("/backup-download/{token}")
async def redeem_backup_download(token: str, request: Request):
    # Cheap per-IP rate limit to slow token enumeration. The bucket is
    # keyed by IP-hash so it survives proxies and doesn't punish a shared
    # outbound NAT too harshly.
    ip_hash = _auth._hash_ip(_auth._get_client_ip(request))
    check_scoped_rate_limit(ip_hash, "public-backup-download", 30, 60)

    link = accounts_db.get_backup_download_link_by_token(token)
    if link is None:
        # Don't reveal whether the token was ever valid.
        raise HTTPException(status_code=404, detail="not_found")

    now = datetime.now(timezone.utc)
    if link.get("revoked_at") is not None:
        _record_failure(link["id"], request, "revoked")
        raise HTTPException(status_code=404, detail="not_found")
    if link.get("expires_at") is not None and link["expires_at"] <= now:
        _record_failure(link["id"], request, "expired")
        raise HTTPException(status_code=404, detail="not_found")

    backup_key = link["backup_key"]
    if not r2_storage.object_exists(backup_key):
        _record_failure(link["id"], request, "object_missing")
        raise HTTPException(
            status_code=410,
            detail={
                "code": "object_missing",
                "message": "The backup file is no longer available.",
            },
        )

    filename = os.path.basename(backup_key) or "backup.db"
    # RFC 6266 — keep it ASCII-safe; backup filenames are already constrained
    # to ``backup-YYYY-Www[-manual-<ts>].db[.zst]`` so no quoting needed.
    content_disposition = f'attachment; filename="{filename}"'

    url = r2_storage.generate_presigned_download_url(
        backup_key,
        expires_seconds=_REDIRECT_PRESIGN_SECONDS,
        content_type="application/octet-stream",
        verify_exists=False,  # already checked above
        content_disposition=content_disposition,
    )
    if not url:
        _record_failure(link["id"], request, "presign_failed")
        raise HTTPException(status_code=500, detail="presign_failed")

    try:
        accounts_db.record_backup_download_redemption(
            link["id"],
            ip_hash=ip_hash,
            user_agent=(request.headers.get("user-agent") or "")[:_USER_AGENT_MAX_LEN] or None,
            success=True,
            failure_reason=None,
        )
    except Exception:
        logger.exception(
            "backup-download: failed to record success for link_id=%s", link["id"]
        )

    return RedirectResponse(url, status_code=302)
