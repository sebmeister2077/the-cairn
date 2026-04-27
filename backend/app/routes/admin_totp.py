"""Phase 4a — admin TOTP enrolment endpoints.

POST  /api/admin/totp/enroll    — start enrolment, returns provisioning URI
POST  /api/admin/totp/confirm   — confirm enrolment with the first 6-digit code
GET   /api/admin/totp/status    — whether the current admin has enrolled

The plaintext secret is generated server-side, returned **once** in the
``enroll`` response, and held in memory by the client until it is confirmed.
The encrypted secret is only persisted on confirmation, so an interrupted
enrolment leaves no garbage in the DB.
"""

import threading
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth as _auth
from ..auth import require_admin
from ..core import accounts_db


router = APIRouter(prefix="/admin/totp", tags=["admin-totp"])


# Secrets pending confirmation live in memory only — never persisted.
# Mapping: api_key -> (secret, created_monotonic_ts)
_PENDING_TTL_SECONDS = 10 * 60
_pending_lock = threading.Lock()
_pending: dict = {}


def _gc_pending(now: float) -> None:
    expired = [k for k, (_, ts) in _pending.items() if (now - ts) > _PENDING_TTL_SECONDS]
    for k in expired:
        _pending.pop(k, None)


class TotpConfirmBody(BaseModel):
    code: str


@router.get("/status")
async def totp_status(api_key: str = Depends(require_admin)):
    return {
        "enrolled": _auth.is_totp_enrolled(api_key),
        "configured": bool(_auth.settings.TOTP_ENCRYPTION_KEY),
    }


@router.post("/enroll")
async def totp_enroll(api_key: str = Depends(require_admin)):
    if not _auth.settings.TOTP_ENCRYPTION_KEY:
        raise HTTPException(
            status_code=503,
            detail={"code": "totp_not_configured", "message": "TOTP_ENCRYPTION_KEY is not set"},
        )
    secret = _auth.generate_totp_secret()
    uri = _auth.build_otpauth_uri(api_key, secret, account_label="")
    now = time.monotonic()
    with _pending_lock:
        _gc_pending(now)
        _pending[api_key] = (secret, now)
    return {"secret": secret, "otpauth_uri": uri}


@router.post("/confirm")
async def totp_confirm(body: TotpConfirmBody, api_key: str = Depends(require_admin)):
    now = time.monotonic()
    with _pending_lock:
        _gc_pending(now)
        entry = _pending.get(api_key)
    if not entry:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_pending_enrolment", "message": "Call /enroll first"},
        )
    secret, _ts = entry

    # Validate the first code against the just-generated secret without going
    # through the DB-backed verifier (the secret isn't persisted yet).
    import pyotp
    if not pyotp.TOTP(secret).verify(body.code.strip(), valid_window=1):
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_totp", "message": "Code did not match"},
        )

    _auth.store_enrolment(api_key, secret)
    with _pending_lock:
        _pending.pop(api_key, None)

    accounts_db.audit_log(api_key, "totp.enrol")
    return {"enrolled": True}
