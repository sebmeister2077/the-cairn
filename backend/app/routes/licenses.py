"""VSProxy online license activation + admin management.

Public endpoints (no API key — the license code itself is the credential):

* ``POST /license/activate`` — bind this machine to the license (enforcing the
  activation cap) and return a signed, short-lived token the client caches for
  an offline grace window.
* ``POST /license/validate`` — refresh an already-bound machine's token
  (heartbeat); never consumes a new activation slot.

Admin endpoints (``require_admin``) issue, list, and revoke licenses, and can
unbind a single machine to free its slot. See ``app/core/license_signing.py``
and the VSProxy client's ``src/Licensing`` gate.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..config import settings
from ..core import database as db
from ..core import license_signing
from .. import auth as _auth


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["licenses"])

# How long an issued token stays valid for offline use before the client must
# re-activate online. Bounded so revocation propagates within a day.
_TOKEN_GRACE = timedelta(hours=24)
_USER_AGENT_MAX_LEN = 256


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _sign_token(license_row: dict, fingerprint: str, platform: Optional[str] = None) -> dict:
    now = datetime.now(timezone.utc)
    token_expiry = now + _TOKEN_GRACE
    lic_expiry = license_row.get("expires_at")
    # Never let the offline token outlive the license itself.
    if isinstance(lic_expiry, datetime):
        le = lic_expiry if lic_expiry.tzinfo else lic_expiry.replace(tzinfo=timezone.utc)
        token_expiry = min(token_expiry, le)
    payload = {
        "license_code": license_row["license_code"],
        "fingerprint": fingerprint,
        "status": "active",
        "issued_at": _iso(now),
        "token_expires_at": _iso(token_expiry),
        "license_expires_at": _iso(lic_expiry) if isinstance(lic_expiry, datetime) else None,
    }
    # Version-gate + auto-update advertisement (all optional). Signed into the
    # token so the client trusts and can enforce them even offline.
    _add_version_policy(payload, platform)
    try:
        signed = license_signing.sign_payload(payload)
    except license_signing.LicenseSigningUnavailable as exc:
        logger.error("License signing unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="License signing not configured")
    return signed


def _update_url_for(platform: Optional[str]) -> Optional[str]:
    p = (platform or "").lower()
    if "linux" in p:
        return settings.VSPROXY_UPDATE_URL_LINUX or None
    # Default to the Windows build for win-* and any unrecognised platform.
    return settings.VSPROXY_UPDATE_URL_WIN or None


def _add_version_policy(payload: dict, platform: Optional[str]) -> None:
    # Admin-editable gate lives in the DB (program_settings); env vars are a
    # fallback so a fresh deploy still works before anything is configured.
    stored: dict = {}
    try:
        stored = db.get_program_settings()
    except Exception:
        logger.exception("failed to read program_settings")

    min_v = stored.get("min_supported_version") or settings.VSPROXY_MIN_SUPPORTED_VERSION
    blocked_msg = stored.get("blocked_message") or settings.VSPROXY_BLOCKED_MESSAGE
    update_msg = stored.get("update_message") or settings.VSPROXY_UPDATE_MESSAGE
    if min_v:
        payload["min_supported_version"] = min_v
    if blocked_msg:
        payload["blocked_message"] = blocked_msg
    if update_msg:
        payload["update_message"] = update_msg

    # latest_version + update_url are auto-derived from the current published
    # build for this platform, so publishing a new build both bumps the update
    # prompt and keeps the download URL valid with no extra admin step.
    build = None
    try:
        if platform:
            build = db.get_current_program_build(platform)
    except Exception:
        logger.exception("failed to read current program build")

    latest = (build or {}).get("version_label")
    if latest:
        payload["latest_version"] = latest

    if build and settings.PUBLIC_BASE_URL:
        payload["update_url"] = (
            f"{settings.PUBLIC_BASE_URL}/api/public/program/latest/{platform}"
        )
        # Sign the build's content hash into the token so the client can verify
        # the integrity of the downloaded binary before swapping it in. Only set
        # for the build-derived URL, whose bytes we know the digest of.
        sha = build.get("sha256")
        if sha:
            payload["update_sha256"] = sha.strip().lower()
    else:
        env_url = _update_url_for(platform)
        if env_url:
            payload["update_url"] = env_url


def _check_license(license_code: str) -> dict:
    lic = db.get_license(license_code)
    if lic is None:
        raise HTTPException(status_code=403, detail="Unknown license")
    if lic.get("status") != "active":
        raise HTTPException(status_code=403, detail="License revoked")
    exp = lic.get("expires_at")
    if isinstance(exp, datetime):
        e = exp if exp.tzinfo else exp.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > e:
            raise HTTPException(status_code=403, detail="License expired")
    return lic


class ActivateRequest(BaseModel):
    license_code: str = Field(..., min_length=8, max_length=200)
    fingerprint: str = Field(..., min_length=8, max_length=200)
    app_version: Optional[str] = Field(None, max_length=64)
    # Runtime identifier the client runs on (e.g. "win-x64", "linux-x64"); used
    # to hand back the matching auto-update download URL.
    platform: Optional[str] = Field(None, max_length=64)
    # Effective runtime parameters (CLI flags / config, minus licensing secrets).
    parameters: Optional[dict] = None


@router.post("/license/activate")
async def activate(req: ActivateRequest, request: Request) -> dict:
    lic = _check_license(req.license_code)
    existing = db.get_activation(req.license_code, req.fingerprint)
    if existing is not None and existing.get("revoked"):
        raise HTTPException(status_code=403, detail="This machine has been unbound")
    if existing is None:
        if db.count_active_activations(req.license_code) >= int(lic["max_activations"]):
            try:
                db.record_activation_attempt(
                    req.license_code,
                    req.fingerprint,
                    req.app_version,
                    ip_hash=_auth._hash_ip(_auth._get_client_ip(request)),
                    user_agent=(request.headers.get("user-agent") or "")[
                        :_USER_AGENT_MAX_LEN
                    ]
                    or None,
                    reason="limit_reached",
                )
            except Exception:
                logger.exception(
                    "failed to record over-limit activation attempt for %s",
                    req.license_code,
                )
            raise HTTPException(
                status_code=403,
                detail="License activation limit reached on other machines",
            )
    db.upsert_activation(
        req.license_code, req.fingerprint, req.app_version, req.parameters
    )
    return _sign_token(lic, req.fingerprint, req.platform)


@router.post("/license/validate")
async def validate(req: ActivateRequest) -> dict:
    lic = _check_license(req.license_code)
    existing = db.get_activation(req.license_code, req.fingerprint)
    if existing is None:
        raise HTTPException(status_code=403, detail="Machine not activated")
    if existing.get("revoked"):
        raise HTTPException(status_code=403, detail="This machine has been unbound")
    db.upsert_activation(
        req.license_code, req.fingerprint, req.app_version, req.parameters
    )
    return _sign_token(lic, req.fingerprint, req.platform)


# --------------------------------------------------------------------------
# Admin management
# --------------------------------------------------------------------------
class IssueLicenseRequest(BaseModel):
    label: Optional[str] = Field(None, max_length=200)
    max_activations: int = Field(2, ge=1, le=20)
    expires_at: Optional[datetime] = None
    notes: Optional[str] = Field(None, max_length=1000)


@router.post("/admin/licenses")
async def issue_license(
    req: IssueLicenseRequest, _admin: str = Depends(require_admin)
) -> dict:
    code = "vsp_" + secrets.token_urlsafe(24)
    row = db.create_license(
        code, req.label, req.max_activations, req.expires_at, req.notes
    )
    return {
        "license_code": row["license_code"],
        "label": row.get("label"),
        "max_activations": row["max_activations"],
        "expires_at": _iso(row.get("expires_at")),
    }


@router.get("/admin/licenses")
async def list_licenses(
    status: str = Query("all", pattern="^(all|active|revoked)$"),
    q: Optional[str] = Query(None, max_length=200),
    min_machines: Optional[int] = Query(None, ge=0),
    max_machines: Optional[int] = Query(None, ge=0),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    _admin: str = Depends(require_admin),
) -> dict:
    result = db.list_licenses(
        status=status,
        q=(q or "").strip() or None,
        min_machines=min_machines,
        max_machines=max_machines,
        offset=offset,
        limit=limit,
    )
    items = result["items"]
    for it in items:
        it["expires_at"] = _iso(it.get("expires_at"))
        it["created_at"] = _iso(it.get("created_at"))
    total = result["total"]
    next_offset = offset + len(items) if offset + len(items) < total else None
    return {"items": items, "total": total, "next_offset": next_offset}


@router.get("/admin/licenses/{license_code}/attempts")
async def list_over_limit_attempts(
    license_code: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    _admin: str = Depends(require_admin),
) -> dict:
    if db.get_license(license_code) is None:
        raise HTTPException(status_code=404, detail="Unknown license")
    result = db.list_license_activation_attempts(
        license_code, offset=offset, limit=limit
    )
    items = result["items"]
    for it in items:
        it["attempted_at"] = _iso(it.get("attempted_at"))
        it["ip_hash_short"] = (it.pop("ip_hash", None) or "")[:12] or None
    total = result["total"]
    next_offset = offset + len(items) if offset + len(items) < total else None
    return {"items": items, "total": total, "next_offset": next_offset}


@router.get("/admin/licenses/{license_code}/activations")
async def list_activations(
    license_code: str, _admin: str = Depends(require_admin)
) -> dict:
    if db.get_license(license_code) is None:
        raise HTTPException(status_code=404, detail="Unknown license")
    items = db.list_license_activations(license_code)
    for it in items:
        it["first_seen"] = _iso(it.get("first_seen"))
        it["last_seen"] = _iso(it.get("last_seen"))
        it["params_changed_at"] = _iso(it.get("params_changed_at"))
    return {"items": items}


@router.post("/admin/licenses/{license_code}/revoke")
async def revoke_license(
    license_code: str, _admin: str = Depends(require_admin)
) -> dict:
    if db.get_license(license_code) is None:
        raise HTTPException(status_code=404, detail="Unknown license")
    db.revoke_license(license_code)
    return {"ok": True, "license_code": license_code, "status": "revoked"}


@router.post("/admin/licenses/{license_code}/activations/{fingerprint}/revoke")
async def unbind_activation(
    license_code: str, fingerprint: str, _admin: str = Depends(require_admin)
) -> dict:
    if db.get_activation(license_code, fingerprint) is None:
        raise HTTPException(status_code=404, detail="Unknown activation")
    db.revoke_activation(license_code, fingerprint)
    return {"ok": True, "license_code": license_code, "fingerprint": fingerprint}


@router.post("/admin/licenses/{license_code}/activations/{fingerprint}/dismiss-flag")
async def dismiss_activation_flag(
    license_code: str, fingerprint: str, _admin: str = Depends(require_admin)
) -> dict:
    if db.get_activation(license_code, fingerprint) is None:
        raise HTTPException(status_code=404, detail="Unknown activation")
    db.dismiss_activation_flag(license_code, fingerprint)
    return {"ok": True, "license_code": license_code, "fingerprint": fingerprint}
