"""Phase 4c — admin WebAuthn (passkey) endpoints.

Two flows live here:

1. **Registration** — the admin enrols a new passkey:
   ``POST /admin/webauthn/register/begin``  -> publicKeyCredentialCreationOptions
   ``POST /admin/webauthn/register/complete`` -> persists the credential

2. **Authentication** — after pasting their API key the admin must complete
   one passkey gesture per ``WEBAUTHN_SESSION_TTL_SECONDS`` window:
   ``POST /admin/webauthn/auth/begin``      -> publicKeyCredentialRequestOptions
   ``POST /admin/webauthn/auth/complete``   -> issues an X-Admin-Session token

A status endpoint plus credential management round it out:
   ``GET    /admin/webauthn/status``
   ``GET    /admin/webauthn/credentials``
   ``DELETE /admin/webauthn/credentials/{id}``
   ``POST   /admin/webauthn/logout`` (revoke current session)

All endpoints use :func:`auth.require_admin_keyonly` — they MUST stay
reachable with the API key alone, otherwise the admin could never establish
a passkey session in the first place.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel

from .. import auth as _auth
from ..auth import require_admin_keyonly, require_admin_passkey
from ..config import settings
from ..core import accounts_db
from ..core import database as db


router = APIRouter(prefix="/admin/webauthn", tags=["admin-webauthn"])


# ---------------------------------------------------------------------------
# Pending-challenge store (in-memory, short TTL)
# ---------------------------------------------------------------------------
#
# WebAuthn requires a fresh server-issued challenge per ceremony. We keep one
# pending registration challenge and one pending authentication challenge per
# admin api_key. They expire after _CHALLENGE_TTL seconds and are deleted on
# successful verification (one-shot).

_CHALLENGE_TTL = 5 * 60
_pending_lock = threading.Lock()
_pending_register: dict = {}   # api_key -> (challenge_bytes, created_at_monotonic)
_pending_auth: dict = {}       # api_key -> (challenge_bytes, created_at_monotonic)


def _gc(store: dict, now: float) -> None:
    expired = [k for k, (_, ts) in store.items() if (now - ts) > _CHALLENGE_TTL]
    for k in expired:
        store.pop(k, None)


def _put_challenge(store: dict, api_key: str, challenge: bytes) -> None:
    now = time.monotonic()
    with _pending_lock:
        _gc(store, now)
        store[api_key] = (challenge, now)


def _take_challenge(store: dict, api_key: str) -> Optional[bytes]:
    now = time.monotonic()
    with _pending_lock:
        _gc(store, now)
        entry = store.pop(api_key, None)
    if not entry:
        return None
    return entry[0]


# ---------------------------------------------------------------------------
# Config / availability helpers
# ---------------------------------------------------------------------------

def _normalize_origin(origin: str) -> str:
    """Return a full WebAuthn origin (scheme + host) for ``origin``.

    The browser always reports a complete origin (e.g. ``https://the-cairn.com``)
    in ``clientDataJSON``, so a bare hostname such as ``the-cairn.com`` — which is
    valid for ``ALLOWED_ORIGINS``/CORS — can never match. When an entry has no
    scheme we add one: ``http://`` for localhost/loopback (the only non-HTTPS
    origin browsers accept for WebAuthn) and ``https://`` for everything else.
    """
    origin = origin.strip().rstrip("/")
    if not origin or "://" in origin:
        return origin
    host = origin.split(":", 1)[0]
    scheme = "http" if host in ("localhost", "127.0.0.1", "::1") else "https"
    return f"{scheme}://{origin}"


def _allowed_origins() -> list[str]:
    """Origins the browser is allowed to assert from. Falls back to
    ``ALLOWED_ORIGINS`` so a single-host deployment works without
    duplicating config."""
    raw = settings.WEBAUTHN_ORIGINS or settings.ALLOWED_ORIGINS or []
    seen: set[str] = set()
    origins: list[str] = []
    for entry in raw:
        normalized = _normalize_origin(entry)
        if normalized and normalized not in seen:
            seen.add(normalized)
            origins.append(normalized)
    return origins


def _require_configured() -> None:
    if not settings.WEBAUTHN_RP_ID:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "webauthn_not_configured",
                "message": "WEBAUTHN_RP_ID is not set on the server",
            },
        )
    if not _allowed_origins():
        raise HTTPException(
            status_code=503,
            detail={
                "code": "webauthn_not_configured",
                "message": "WEBAUTHN_ORIGINS or ALLOWED_ORIGINS must be set",
            },
        )
    if not db.is_available():
        raise HTTPException(
            status_code=503,
            detail={"code": "webauthn_not_configured", "message": "Database unavailable"},
        )


def _block_registration_in_strict_mode() -> None:
    """Refuse new passkey enrolment while global strict mode is enabled.

    In strict mode the admin surface is locked down to already-enrolled
    passkeys, so no new credentials may be created. Admins must enrol their
    passkeys *before* strict mode is turned on; to add more afterwards an
    authorised admin must disable strict mode first.
    """
    if _auth._strict_mode_enabled():
        raise HTTPException(
            status_code=403,
            detail={
                "code": "registration_disabled_strict_mode",
                "message": "Passkey registration is disabled while strict mode is enabled",
            },
        )


def _admin_user_id(api_key: str) -> bytes:
    """Stable, opaque 32-byte user handle for this admin key.

    WebAuthn requires a user.id that does not contain personally-identifying
    info. We derive it deterministically from the api_key with HMAC so the
    same admin always gets the same handle (lets browsers offer "use existing
    passkey" prompts) without exposing the key.
    """
    salt = (settings.IP_HASH_SALT or "default-webauthn-salt").encode()
    return hmac.new(salt, ("webauthn:" + api_key).encode(), hashlib.sha256).digest()


# ---------------------------------------------------------------------------
# Pydantic bodies (we accept the raw clientDataJSON / attestation responses
# as JSON dicts — the python-webauthn library handles parsing)
# ---------------------------------------------------------------------------

class RegisterBeginBody(BaseModel):
    name: str = ""


class RegisterCompleteBody(BaseModel):
    name: str = ""
    credential: dict


class AuthCompleteBody(BaseModel):
    credential: dict


# ---------------------------------------------------------------------------
# Status / credential listing
# ---------------------------------------------------------------------------

@router.get("/status")
async def webauthn_status(api_key: str = Depends(require_admin_keyonly)):
    configured = bool(settings.WEBAUTHN_RP_ID and _allowed_origins())
    enrolled = configured and db.is_available() and db.count_webauthn_credentials(api_key) > 0
    return {
        "configured": configured,
        "enrolled": enrolled,
        "enforced": settings.WEBAUTHN_ENFORCE,
        "strict_mode": _auth._strict_mode_enabled(),
        "session_ttl_seconds": settings.WEBAUTHN_SESSION_TTL_SECONDS,
    }


class StrictModeBody(BaseModel):
    enabled: bool


@router.get("/strict-mode")
async def get_strict_mode(api_key: str = Depends(require_admin_keyonly)):
    """Current global strict-mode state plus whether *this* admin may toggle it.

    ``can_toggle`` is True only when the acting admin has enrolled at least one
    passkey — the frontend uses it to enable/disable the toggle control."""
    self_enrolled = db.is_available() and db.count_webauthn_credentials(api_key) > 0
    return {
        "enabled": _auth._strict_mode_enabled(),
        "self_enrolled": bool(self_enrolled),
        "can_toggle": bool(self_enrolled),
    }


@router.put("/strict-mode")
async def set_strict_mode(
    body: StrictModeBody,
    api_key: str = Depends(require_admin_passkey),
):
    """Enable/disable global strict mode.

    Guarded by :func:`require_admin_passkey` — the acting admin must personally
    have a passkey + valid session, so strict mode can only ever be turned on
    (or off) by a strongly-authenticated admin."""
    enabled = _auth.set_strict_mode(body.enabled, api_key)
    accounts_db.audit_log(
        api_key,
        "webauthn.strict_mode_enabled" if enabled else "webauthn.strict_mode_disabled",
    )
    return {"enabled": enabled}


@router.get("/credentials")
async def list_credentials(api_key: str = Depends(require_admin_keyonly)):
    if not db.is_available():
        return {"credentials": []}
    rows = db.list_webauthn_credentials(api_key)
    return {
        "credentials": [
            {
                "id": int(r["id"]),
                "name": r.get("name") or "",
                "created_at": (r.get("created_at").isoformat() if r.get("created_at") else None),
                "last_used_at": (r.get("last_used_at").isoformat() if r.get("last_used_at") else None),
            }
            for r in rows
        ]
    }


@router.delete("/credentials/{cred_id}")
async def delete_credential(
    cred_id: int,
    api_key: str = Depends(require_admin_keyonly),
    x_admin_session: Optional[str] = Header(None, alias="X-Admin-Session"),
):
    """Remove one passkey. Requires a valid passkey session — you must have
    *another* working passkey (or have just verified) to drop one."""
    # Removing the last passkey while sessions exist would still be safe
    # (no passkeys ⇒ enforcement off), but we still want this to be a
    # passkey-gated action so a stolen API key cannot wipe enrolment.
    if db.is_available() and db.count_webauthn_credentials(api_key) > 0:
        _auth._enforce_passkey_session(api_key, x_admin_session)

    deleted = db.delete_webauthn_credential(api_key, cred_id) if db.is_available() else False
    if not deleted:
        raise HTTPException(status_code=404, detail="Credential not found")
    accounts_db.audit_log(api_key, "webauthn.credential_deleted", target=str(cred_id))
    # If that was the last one, drop all sessions so enforcement re-engages
    # cleanly the next time a passkey is registered.
    if db.count_webauthn_credentials(api_key) == 0:
        _auth.revoke_all_admin_sessions(api_key)
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Registration ceremony
# ---------------------------------------------------------------------------

@router.post("/register/begin")
async def register_begin(
    body: RegisterBeginBody,
    api_key: str = Depends(require_admin_keyonly),
):
    _require_configured()
    _block_registration_in_strict_mode()
    from webauthn import generate_registration_options, options_to_json
    from webauthn.helpers.structs import (
        AuthenticatorSelectionCriteria,
        ResidentKeyRequirement,
        UserVerificationRequirement,
        PublicKeyCredentialDescriptor,
    )

    existing = db.list_webauthn_credentials(api_key)
    exclude = [
        PublicKeyCredentialDescriptor(id=row["credential_id"])
        for row in existing
        if row.get("credential_id")
    ]

    options = generate_registration_options(
        rp_id=settings.WEBAUTHN_RP_ID,
        rp_name=settings.WEBAUTHN_RP_NAME or "Admin",
        user_id=_admin_user_id(api_key),
        user_name=f"admin-{api_key[-6:]}",
        user_display_name="Admin",
        exclude_credentials=exclude,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
        timeout=60_000,
    )

    _put_challenge(_pending_register, api_key, options.challenge)
    # options_to_json returns a JSON string; parse so FastAPI re-serialises it
    # alongside our own metadata.
    import json
    return {"options": json.loads(options_to_json(options))}


@router.post("/register/complete")
async def register_complete(
    body: RegisterCompleteBody,
    api_key: str = Depends(require_admin_keyonly),
):
    _require_configured()
    _block_registration_in_strict_mode()
    challenge = _take_challenge(_pending_register, api_key)
    if not challenge:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_pending_registration", "message": "Call /register/begin first"},
        )

    from webauthn import verify_registration_response
    from webauthn.helpers.exceptions import InvalidRegistrationResponse

    try:
        verification = verify_registration_response(
            credential=body.credential,
            expected_challenge=challenge,
            expected_origin=_allowed_origins(),
            expected_rp_id=settings.WEBAUTHN_RP_ID,
            require_user_verification=False,
        )
    except InvalidRegistrationResponse as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_registration", "message": str(exc)},
        )

    transports = None
    raw_transports = (
        body.credential.get("response", {}).get("transports")
        if isinstance(body.credential, dict)
        else None
    )
    if isinstance(raw_transports, list) and raw_transports:
        transports = ",".join(str(t) for t in raw_transports if t)

    row = db.add_webauthn_credential(
        api_key=api_key,
        name=body.name or "Passkey",
        credential_id=verification.credential_id,
        public_key=verification.credential_public_key,
        sign_count=int(verification.sign_count or 0),
        transports=transports,
    )
    accounts_db.audit_log(
        api_key,
        "webauthn.credential_registered",
        target=str(row.get("id") or ""),
        metadata={"name": body.name or "Passkey"},
    )
    return {"registered": True, "id": int(row.get("id") or 0)}


# ---------------------------------------------------------------------------
# Authentication ceremony
# ---------------------------------------------------------------------------

@router.post("/auth/begin")
async def auth_begin(api_key: str = Depends(require_admin_keyonly)):
    _require_configured()
    if db.count_webauthn_credentials(api_key) == 0:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "no_credentials",
                "message": "Register a passkey before signing in",
            },
        )

    from webauthn import generate_authentication_options, options_to_json
    from webauthn.helpers.structs import (
        UserVerificationRequirement,
        PublicKeyCredentialDescriptor,
    )

    rows = db.list_webauthn_credentials(api_key)
    allow = [
        PublicKeyCredentialDescriptor(id=r["credential_id"])
        for r in rows
        if r.get("credential_id")
    ]
    options = generate_authentication_options(
        rp_id=settings.WEBAUTHN_RP_ID,
        allow_credentials=allow,
        user_verification=UserVerificationRequirement.PREFERRED,
        timeout=60_000,
    )
    _put_challenge(_pending_auth, api_key, options.challenge)

    import json
    return {"options": json.loads(options_to_json(options))}


def _b64url_decode(s: str) -> bytes:
    pad = "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(s + pad)


@router.post("/auth/complete")
async def auth_complete(
    body: AuthCompleteBody,
    request: Request,
    api_key: str = Depends(require_admin_keyonly),
):
    _require_configured()
    challenge = _take_challenge(_pending_auth, api_key)
    if not challenge:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_pending_assertion", "message": "Call /auth/begin first"},
        )

    raw_id = body.credential.get("rawId") or body.credential.get("id")
    if not raw_id:
        raise HTTPException(status_code=400, detail={"code": "invalid_assertion", "message": "Missing rawId"})
    try:
        cred_id_bytes = _b64url_decode(raw_id)
    except Exception:
        raise HTTPException(status_code=400, detail={"code": "invalid_assertion", "message": "Bad rawId encoding"})

    stored = db.get_webauthn_credential_by_id(cred_id_bytes)
    if not stored or stored["api_key"] != api_key:
        raise HTTPException(
            status_code=401,
            detail={"code": "unknown_credential", "message": "Credential not registered for this admin"},
        )

    from webauthn import verify_authentication_response
    from webauthn.helpers.exceptions import InvalidAuthenticationResponse

    try:
        verification = verify_authentication_response(
            credential=body.credential,
            expected_challenge=challenge,
            expected_origin=_allowed_origins(),
            expected_rp_id=settings.WEBAUTHN_RP_ID,
            credential_public_key=stored["public_key"],
            credential_current_sign_count=int(stored.get("sign_count") or 0),
            require_user_verification=False,
        )
    except InvalidAuthenticationResponse as exc:
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_assertion", "message": str(exc)},
        )

    db.update_webauthn_sign_count(int(stored["id"]), int(verification.new_sign_count or 0))
    session = _auth.issue_admin_session(api_key, request)
    accounts_db.audit_log(
        api_key,
        "webauthn.signed_in",
        target=str(stored["id"]),
        metadata={"name": stored.get("name") or ""},
    )
    return {
        "session_token": session["token"],
        "expires_in": session["expires_in"],
    }


@router.post("/logout")
async def webauthn_logout(
    api_key: str = Depends(require_admin_keyonly),
    x_admin_session: Optional[str] = Header(None, alias="X-Admin-Session"),
):
    """Invalidate the supplied session token. Safe to call without a token."""
    if x_admin_session:
        _auth.revoke_admin_session(x_admin_session)
    return {"logged_out": True}
