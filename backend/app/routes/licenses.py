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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..core import database as db
from ..core import license_signing


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["licenses"])

# How long an issued token stays valid for offline use before the client must
# re-activate online. Bounded so revocation propagates within a day.
_TOKEN_GRACE = timedelta(hours=24)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _sign_token(license_row: dict, fingerprint: str) -> dict:
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
    try:
        signed = license_signing.sign_payload(payload)
    except license_signing.LicenseSigningUnavailable as exc:
        logger.error("License signing unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="License signing not configured")
    return signed


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


@router.post("/license/activate")
async def activate(req: ActivateRequest) -> dict:
    lic = _check_license(req.license_code)
    existing = db.get_activation(req.license_code, req.fingerprint)
    if existing is not None and existing.get("revoked"):
        raise HTTPException(status_code=403, detail="This machine has been unbound")
    if existing is None:
        if db.count_active_activations(req.license_code) >= int(lic["max_activations"]):
            raise HTTPException(
                status_code=403,
                detail="License activation limit reached on other machines",
            )
    db.upsert_activation(req.license_code, req.fingerprint, req.app_version)
    return _sign_token(lic, req.fingerprint)


@router.post("/license/validate")
async def validate(req: ActivateRequest) -> dict:
    lic = _check_license(req.license_code)
    existing = db.get_activation(req.license_code, req.fingerprint)
    if existing is None:
        raise HTTPException(status_code=403, detail="Machine not activated")
    if existing.get("revoked"):
        raise HTTPException(status_code=403, detail="This machine has been unbound")
    db.upsert_activation(req.license_code, req.fingerprint, req.app_version)
    return _sign_token(lic, req.fingerprint)


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
async def list_licenses(_admin: str = Depends(require_admin)) -> dict:
    items = db.list_licenses()
    for it in items:
        it["expires_at"] = _iso(it.get("expires_at"))
        it["created_at"] = _iso(it.get("created_at"))
    return {"items": items}


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
