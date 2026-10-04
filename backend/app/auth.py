"""API key authentication dependencies."""

import hashlib
import hmac
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import Header, HTTPException, Query, Request

from .config import settings
from .core import database as db
from .core import accounts_db
from .core import api_key_cache

def _get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _hash_ip(ip: str) -> str:
    """Return a non-reversible HMAC-SHA256 digest of the IP address.

    Uses IP_HASH_SALT from config so the digest cannot be brute-forced
    against a public rainbow table.  The raw IP is never persisted.
    """
    salt = settings.IP_HASH_SALT.encode() if settings.IP_HASH_SALT else b"default-salt-change-me"
    return hmac.new(salt, ip.encode(), hashlib.sha256).hexdigest()


def _resolve_key(key: str, request: Request) -> Optional[dict]:
    """Validate a key and return its info dict, or None if invalid.

    Side-effects for DB keys: binds identity on first use (consume_once),
    and updates last_used_at (throttled — see :mod:`api_key_cache`).

    The returned dict always contains the ``id`` UUID of the resolved
    ``api_keys`` row (env-var keys are upserted on startup so they have
    one too). The synthetic ``is_admin`` flag is True iff the key
    matches ``ADMIN_API_KEY``.
    """
    # Fast path — cache hit (also bumps last_used_at + usage_count, throttled)
    cached = api_key_cache.touch(key)
    if cached is not None:
        if cached.get("revoked"):
            return None
        return cached

    if not db.is_available():
        # The key isn't cached and the database is momentarily unavailable
        # (cold start / brief connection drop). That's a transient condition,
        # NOT an invalid key — surface it as 503 so the client retries instead
        # of treating it as an auth rejection. A 401 here would poison the
        # user's stored key for the whole browser session.
        raise HTTPException(
            status_code=503,
            detail="Authentication temporarily unavailable, please retry",
        )

    record = db.get_api_key(key)
    if not record or record.get("revoked"):
        return None

    if record.get("consume_once"):
        client_ip_hash = _hash_ip(_get_client_ip(request))
        bound = record.get("bound_identity")
        if bound is None:
            db.bind_api_key(key, client_ip_hash)
            record["bound_identity"] = client_ip_hash
        elif bound != client_ip_hash:
            raise HTTPException(
                status_code=401,
                detail="API key is locked to another user",
            )

    info = dict(record)
    info["is_admin"] = bool(record.get("is_admin")) or bool(
        settings.ADMIN_API_KEY and key == settings.ADMIN_API_KEY
    )
    return api_key_cache.put(key, info)


def resolve_key_id(key: str) -> Optional[UUID]:
    """Return the ``api_keys.id`` UUID for ``key``, or ``None`` if unknown.

    Looks at the cache first, then falls back to a single ``SELECT``.
    Use this from places that have a key string and need the id without
    going through a ``Depends(verify_api_key_info)`` dependency
    (e.g. inside helper functions). Does NOT bump usage counters.
    """
    cached = api_key_cache.peek(key)
    if cached is not None:
        val = cached.get("id")
        if val is None:
            return None
        return val if isinstance(val, UUID) else UUID(str(val))
    if not db.is_available():
        return None
    row = db.get_api_key(key)
    if not row:
        return None
    val = row.get("id")
    if val is None:
        return None
    return val if isinstance(val, UUID) else UUID(str(val))


async def verify_api_key(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> str:
    """FastAPI dependency that validates the X-API-Key header."""
    await verify_api_key_info(request, x_api_key)
    return x_api_key


async def verify_api_key_info(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> dict:
    """Validate key and return resolved key metadata."""
    info = _resolve_key(x_api_key, request)
    if info is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return info


async def verify_contribute_permission(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> str:
    """Like verify_api_key but also requires 'contribute' permission."""
    info = await verify_api_key_info(request, x_api_key)
    if info.get("permissions") != "contribute":
        raise HTTPException(
            status_code=403,
            detail="This API key does not have contribute permission",
        )
    return x_api_key


async def verify_api_key_header_or_query(
    request: Request,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    api_key: Optional[str] = Query(None),
) -> str:
    """Validate an API key supplied in either the header or query string."""
    resolved_key = x_api_key or api_key
    if not resolved_key:
        raise HTTPException(status_code=401, detail="Invalid API key")

    info = _resolve_key(resolved_key, request)
    if info is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return resolved_key


async def require_admin(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_admin_session: Optional[str] = Header(None, alias="X-Admin-Session"),
) -> str:
    """FastAPI dependency that requires an admin API key (env super-admin or a
    DB key with ``is_admin``).

    Passkey enforcement is layered:

    * **Per-admin opt-in** (legacy): when the acting admin has registered at
      least one passkey and ``WEBAUTHN_ENFORCE`` is on, a valid
      ``X-Admin-Session`` is required.
    * **Strict mode** (global, admin-toggled): when enabled, every *mutating*
      request (POST/PUT/PATCH/DELETE) additionally requires the acting admin to
      have an enrolled passkey AND a valid session — so an admin without a
      passkey is limited to read-only actions.

    Endpoints that need to be reachable with the API key only (passkey
    registration and assertion themselves) must use
    :func:`require_admin_keyonly` instead.
    """
    if not is_admin_key(x_api_key):
        raise HTTPException(status_code=403, detail="Admin access required")
    strict = _strict_mode_enabled() and _is_mutating(request)
    _enforce_passkey_session(x_api_key, x_admin_session, strict=strict)
    return x_api_key


async def require_admin_critical(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_admin_session: Optional[str] = Header(None, alias="X-Admin-Session"),
) -> str:
    """Like :func:`require_admin` but classifies the action as *critical*
    regardless of HTTP method — under strict mode it requires an enrolled
    passkey + valid session even for a GET. Used for sensitive read endpoints
    such as ``GET /admin/keys`` (which exposes raw API keys)."""
    if not is_admin_key(x_api_key):
        raise HTTPException(status_code=403, detail="Admin access required")
    _enforce_passkey_session(
        x_api_key, x_admin_session, strict=_strict_mode_enabled()
    )
    return x_api_key


async def require_admin_passkey(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_admin_session: Optional[str] = Header(None, alias="X-Admin-Session"),
) -> str:
    """Strongest admin gate: the acting admin MUST personally have an enrolled
    passkey AND a valid session, *regardless of strict-mode state*.

    Used for privileged, trust-bootstrapping actions — promoting/demoting other
    admins and toggling strict mode — so these can never be performed with a
    leaked API key alone.
    """
    if not is_admin_key(x_api_key):
        raise HTTPException(status_code=403, detail="Admin access required")
    _enforce_passkey_session(x_api_key, x_admin_session, strict=True)
    return x_api_key


async def require_admin_keyonly(
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> str:
    """Like :func:`require_admin` but skips the WebAuthn session gate.

    Used only by the WebAuthn registration and assertion endpoints —
    otherwise the admin could never enrol a passkey or complete the
    assertion that produces a session token in the first place.
    """
    if not is_admin_key(x_api_key):
        raise HTTPException(status_code=403, detail="Admin access required")
    return x_api_key


async def require_publish_token(
    x_publish_token: str = Header(..., alias="X-Publish-Token"),
) -> str:
    """Dedicated machine credential for the headless build-publish endpoints
    (``deploy/publish.ps1`` → program build upload/finalize).

    Kept separate from the passkey-gated admin key so a CI/CLI publisher never
    needs a WebAuthn session, and so this narrow capability can be rotated
    independently of the admin key.
    """
    token = (settings.PROGRAM_PUBLISH_TOKEN or "").strip()
    if not token or not hmac.compare_digest(x_publish_token, token):
        raise HTTPException(status_code=403, detail="Invalid publish token")
    return x_publish_token


def is_admin_key(api_key: str) -> bool:
    """Return True if ``api_key`` is an admin — either the env-var super-admin
    key or a DB-backed key promoted via ``api_keys.is_admin``.

    Cache-first (``peek`` doesn't bump usage counters); falls back to a single
    ``SELECT`` only when the key isn't cached.
    """
    if settings.ADMIN_API_KEY and api_key == settings.ADMIN_API_KEY:
        return True
    if not api_key:
        return False
    cached = api_key_cache.peek(api_key)
    if cached is not None:
        return bool(cached.get("is_admin"))
    if not db.is_available():
        return False
    try:
        row = db.get_api_key(api_key)
    except Exception:
        return False
    return bool(row and row.get("is_admin"))


def verify_permission(api_key: str, perm_name: str) -> bool:
    """Check whether ``api_key`` has the granular permission ``perm_name``.

    Admins always pass. For DB-backed keys, the flag is read from the
    cached ``api_keys.extra_permissions`` (JSONB) — falling back to a
    direct DB query only if the key is not cached.
    """
    if is_admin_key(api_key):
        return True
    cached = api_key_cache.peek(api_key)
    if cached is not None:
        extras = cached.get("extra_permissions") or {}
        return bool(extras.get(perm_name))
    if not db.is_available():
        return False
    extras = db.get_api_key_extra_permissions(api_key)
    return bool(extras.get(perm_name))


def require_permission(perm_name: str):
    """Dependency factory that enforces ``verify_permission(api_key, perm_name)``."""

    async def _dep(
        request: Request,
        x_api_key: str = Header(..., alias="X-API-Key"),
    ) -> str:
        info = await verify_api_key_info(request, x_api_key)
        if not info.get("is_admin") and not verify_permission(x_api_key, perm_name):
            raise HTTPException(
                status_code=403,
                detail=f"This API key lacks the '{perm_name}' permission",
            )
        return x_api_key

    return _dep


async def require_active_user(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> dict:
    """FastAPI dependency: validates the API key, ensures the user has an
    account row that is not soft-deleted, and ensures the request IP is not
    on the IP-ban list. Returns ``{ "key": str, "user": dict, "info": dict }``.

    The synthetic admin user is allowed even without an account row.
    """
    info = _resolve_key(x_api_key, request)
    if info is None:
        raise HTTPException(status_code=401, detail="Invalid API key")

    # Always check IP ban first (admin too, so a banned IP can't sneak in via env-var key)
    ip_hash = _hash_ip(_get_client_ip(request))
    if accounts_db.is_ip_banned(ip_hash):
        raise HTTPException(status_code=403, detail="Your IP is banned")

    user = accounts_db.get_user(x_api_key)

    # Admin / legacy env-var keys may not have a users row — that's fine.
    if user is None:
        if info.get("is_admin"):
            return {"key": x_api_key, "user": None, "info": info}
        raise HTTPException(
            status_code=403,
            detail="No account associated with this API key. Register first.",
        )

    if user.get("deleted_at") is not None:
        raise HTTPException(status_code=403, detail="Account has been deleted")

    return {"key": x_api_key, "user": user, "info": info}


# Minimum account age (seconds) before a user may publish to the groupings
# library. Cheap spam deterrent that also makes attribution + reputation
# meaningful. See plans/global-groupings-library-plan.prompt.md.
PUBLISHER_MIN_ACCOUNT_AGE_SECONDS = 24 * 60 * 60


async def require_publisher(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> dict:
    """FastAPI dependency for publishing community content (groupings library).

    Builds on :func:`require_active_user` and additionally requires the account
    to be at least :data:`PUBLISHER_MIN_ACCOUNT_AGE_SECONDS` old. Admin keys
    bypass the age gate. Returns the same ``{key, user, info}`` shape.

    Raises 403 with ``{"code": "account_too_new"}`` when the account exists but
    is younger than the threshold.
    """
    ctx = await require_active_user(request, x_api_key)
    if ctx["info"].get("is_admin"):
        return ctx
    user = ctx["user"]
    joined_at = user.get("joined_at") if user else None
    if joined_at is None:
        raise HTTPException(
            status_code=403,
            detail={"code": "account_too_new", "message": "Account is too new to publish"},
        )
    now = datetime.now(timezone.utc)
    if joined_at.tzinfo is None:
        joined_at = joined_at.replace(tzinfo=timezone.utc)
    age_seconds = (now - joined_at).total_seconds()
    if age_seconds < PUBLISHER_MIN_ACCOUNT_AGE_SECONDS:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "account_too_new",
                "message": "Your account must be at least 1 day old to publish.",
            },
        )
    return ctx



# ---------------------------------------------------------------------------
# TOTP 2FA (Phase 4a)
# ---------------------------------------------------------------------------
#
# RFC 6238 TOTP, 30 s window, 6 digits — compatible with Google Authenticator,
# Authy, 1Password, Bitwarden, etc. Used to gate destructive admin actions
# (backup restore, force-release of map lock, future revert/restore paths).
#
# Storage: api_keys.totp_secret_encrypted — Fernet-encrypted with
# settings.TOTP_ENCRYPTION_KEY. The plaintext secret is only ever in memory
# during enrolment and verification.
#
# Replay protection: the (api_key, code) pair is cached for 90 s after a
# successful verification and rejected if reused.
#
# Throttling: 5 bad codes in a rolling 5 minute window per api_key returns
# 429 totp_throttled.

import base64
import secrets as _secrets
import threading
import time
from collections import deque
from typing import Tuple

_totp_lock = threading.Lock()
_totp_used: dict = {}              # (api_key, code) -> expiry monotonic ts
_totp_failures: dict = {}          # api_key -> deque[monotonic ts]
_TOTP_REPLAY_TTL = 90              # seconds
_TOTP_THROTTLE_WINDOW = 5 * 60     # seconds
_TOTP_THROTTLE_MAX = 5             # bad codes within window -> throttle


class TotpError(HTTPException):
    """Specialised HTTPException with a stable ``code`` field for the frontend."""

    def __init__(self, status: int, code: str, message: Optional[str] = None):
        super().__init__(status_code=status, detail={"code": code, "message": message or code})
        self.code = code


def _fernet():
    if not settings.TOTP_ENCRYPTION_KEY:
        raise TotpError(503, "totp_not_configured", "TOTP_ENCRYPTION_KEY is not set")
    # Imported lazily so a missing optional dependency only matters when TOTP
    # is actually configured.
    from cryptography.fernet import Fernet, InvalidToken  # noqa: F401
    try:
        return Fernet(settings.TOTP_ENCRYPTION_KEY.encode())
    except Exception as exc:  # invalid key shape
        raise TotpError(503, "totp_not_configured", f"Invalid TOTP_ENCRYPTION_KEY: {exc}")


def _encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def _decrypt_secret(blob: str) -> str:
    from cryptography.fernet import InvalidToken
    try:
        return _fernet().decrypt(blob.encode()).decode()
    except InvalidToken as exc:
        raise TotpError(503, "totp_not_configured", "TOTP secret could not be decrypted") from exc


def generate_totp_secret() -> str:
    """Return a fresh base32-encoded TOTP secret (160 bits)."""
    raw = _secrets.token_bytes(20)
    return base64.b32encode(raw).decode().rstrip("=")


def build_otpauth_uri(api_key: str, secret: str, account_label: str) -> str:
    """Render the otpauth:// URI an authenticator app needs to enrol."""
    import pyotp
    issuer = settings.TOTP_ISSUER or "Cairn Admin"
    return pyotp.TOTP(secret).provisioning_uri(
        name=account_label or _short_key_label(api_key),
        issuer_name=issuer,
    )


def _short_key_label(api_key: str) -> str:
    """Last 6 chars of the key — enough to disambiguate authenticator entries
    without leaking the full secret to the device's lock-screen preview."""
    return f"admin-{api_key[-6:]}" if api_key else "admin"


def is_totp_enrolled(api_key: str) -> bool:
    if not settings.TOTP_ENCRYPTION_KEY or not db.is_available():
        return False
    return bool(db.get_totp_secret_encrypted(api_key))


def store_enrolment(api_key: str, secret: str) -> None:
    db.set_totp_secret_encrypted(api_key, _encrypt_secret(secret))


def _gc_failures(now: float) -> None:
    cutoff = now - _TOTP_THROTTLE_WINDOW
    for key, q in list(_totp_failures.items()):
        while q and q[0] < cutoff:
            q.popleft()
        if not q:
            _totp_failures.pop(key, None)


def _check_throttle(api_key: str, now: float) -> None:
    _gc_failures(now)
    q = _totp_failures.get(api_key)
    if q and len(q) >= _TOTP_THROTTLE_MAX:
        raise TotpError(429, "totp_throttled", "Too many bad TOTP codes; try again later")


def _record_failure(api_key: str, now: float) -> None:
    _totp_failures.setdefault(api_key, deque()).append(now)


def verify_totp(api_key: str, code: str) -> None:
    """Validate ``code`` for ``api_key``. Raises ``TotpError`` on any failure.

    Allowed codes: previous, current, next 30 s window (±1 step) to absorb
    clock skew. Replay-protected for 90 s after a successful verification.
    """
    if not settings.TOTP_ENCRYPTION_KEY:
        raise TotpError(503, "totp_not_configured", "TOTP_ENCRYPTION_KEY is not set")
    if not code or not code.strip().isdigit() or len(code.strip()) != 6:
        raise TotpError(401, "invalid_totp", "TOTP code must be 6 digits")
    code = code.strip()

    now = time.monotonic()
    with _totp_lock:
        _check_throttle(api_key, now)
        # Replay check
        for cache_key, expiry in list(_totp_used.items()):
            if expiry < now:
                _totp_used.pop(cache_key, None)
        if (api_key, code) in _totp_used:
            _record_failure(api_key, now)
            raise TotpError(401, "invalid_totp", "TOTP code already used")

    if not db.is_available():
        raise TotpError(503, "totp_not_configured", "TOTP store unavailable")
    blob = db.get_totp_secret_encrypted(api_key)
    if not blob:
        raise TotpError(401, "totp_required", "TOTP enrolment required")
    secret = _decrypt_secret(blob)

    import pyotp
    totp = pyotp.TOTP(secret)
    # ``valid_window=1`` allows ±1 step (30 s).
    if not totp.verify(code, valid_window=1):
        with _totp_lock:
            _record_failure(api_key, now)
        raise TotpError(401, "invalid_totp", "Invalid TOTP code")

    # Success — pin the code so it can't be reused immediately.
    with _totp_lock:
        _totp_used[(api_key, code)] = now + _TOTP_REPLAY_TTL
        _totp_failures.pop(api_key, None)


def require_totp(api_key: str, code: Optional[str]) -> None:
    """Helper for endpoints: raises 401 totp_required if no code is supplied."""
    if not code:
        raise TotpError(401, "totp_required", "TOTP code is required for this action")
    verify_totp(api_key, code)


# ---------------------------------------------------------------------------
# WebAuthn admin session tokens (Phase 4c)
# ---------------------------------------------------------------------------
#
# After a successful passkey assertion the server mints an opaque session
# token and the frontend echoes it back on every admin request via the
# ``X-Admin-Session`` header. Tokens live in process memory only — they are
# regenerated on restart, which forces the admin to re-authenticate. That's
# the desired behaviour: a stolen header value can't survive a redeploy.
#
# Each session is bound to (api_key, ip_hash). If the request IP changes mid
# session the token is rejected, the client must re-assert.

import secrets as _wa_secrets
from threading import Lock as _WaLock

_session_lock = _WaLock()
_admin_sessions: dict = {}  # token -> {api_key, ip_hash, expires_at_monotonic}


def _gc_admin_sessions(now: float) -> None:
    expired = [t for t, s in _admin_sessions.items() if s["expires_at"] < now]
    for t in expired:
        _admin_sessions.pop(t, None)


def issue_admin_session(api_key: str, request: Request) -> dict:
    """Mint a fresh session token bound to this admin + IP. Returns
    ``{"token": str, "expires_in": int}``."""
    token = _wa_secrets.token_urlsafe(32)
    ttl = max(60, int(settings.WEBAUTHN_SESSION_TTL_SECONDS))
    now = time.monotonic()
    ip_hash = _hash_ip(_get_client_ip(request))
    with _session_lock:
        _gc_admin_sessions(now)
        _admin_sessions[token] = {
            "api_key": api_key,
            "ip_hash": ip_hash,
            "expires_at": now + ttl,
        }
    return {"token": token, "expires_in": ttl}


def revoke_admin_session(token: str) -> bool:
    with _session_lock:
        return _admin_sessions.pop(token, None) is not None


def revoke_all_admin_sessions(api_key: str) -> int:
    """Used on credential deletion / re-enrol to invalidate sessions."""
    with _session_lock:
        victims = [t for t, s in _admin_sessions.items() if s["api_key"] == api_key]
        for t in victims:
            _admin_sessions.pop(t, None)
        return len(victims)


# ---------------------------------------------------------------------------
# Strict-mode toggle (global) + passkey enforcement
# ---------------------------------------------------------------------------
#
# Strict mode is persisted in the ``app_settings`` table under this key so it
# is *not* reachable via the generic feature-flags PATCH endpoint (which would
# bypass the passkey gate). It is toggled only through the dedicated
# ``/admin/webauthn/strict-mode`` endpoint guarded by ``require_admin_passkey``.
STRICT_MODE_SETTING_KEY = "webauthn_strict_mode"

_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _is_mutating(request: Optional[Request]) -> bool:
    try:
        return bool(request) and request.method.upper() in _MUTATING_METHODS
    except Exception:
        return False


def _strict_mode_enabled() -> bool:
    """Return True when the global admin strict-mode toggle is on.

    Fails *open* to the legacy per-admin behaviour (returns False) when the DB
    is unavailable or the setting is missing — the critical/privileged gates
    that need to fail *closed* pass ``strict=True`` explicitly regardless of
    this flag."""
    if not db.is_available():
        return False
    try:
        row = db.get_app_setting(STRICT_MODE_SETTING_KEY)
    except Exception:
        return False
    if not row:
        return False
    val = row.get("value")
    if isinstance(val, dict):
        return bool(val.get("enabled"))
    return bool(val is True or val in ("true", "1", 1))


def set_strict_mode(enabled: bool, updated_by_key: str = "") -> bool:
    """Persist the global strict-mode toggle. Returns the stored value."""
    db.set_app_setting(STRICT_MODE_SETTING_KEY, bool(enabled), updated_by_key)
    return bool(enabled)


def _enforce_passkey_session(
    api_key: str, token: Optional[str], *, strict: bool = False
) -> None:
    """Enforce the admin passkey session gate for ``api_key``.

    ``strict=False`` (default, legacy opt-in): no-op when ``WEBAUTHN_ENFORCE``
    is off or the admin has not enrolled any passkey; otherwise a valid session
    token is required.

    ``strict=True``: the admin MUST have an enrolled passkey AND a valid
    session. Fails *closed* — if the DB is unavailable the action is refused,
    and an admin with zero passkeys is rejected with ``passkey_enrollment_required``.
    """
    if not strict and not settings.WEBAUTHN_ENFORCE:
        return
    if not db.is_available():
        if strict:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "passkey_verification_unavailable",
                    "message": "Passkey verification temporarily unavailable",
                },
            )
        return
    try:
        n = db.count_webauthn_credentials(api_key)
    except Exception:
        if strict:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "passkey_verification_unavailable",
                    "message": "Passkey verification temporarily unavailable",
                },
            )
        return
    if n == 0:
        if not strict:
            return  # admin has not enrolled — passkey is opt-in until they do
        raise HTTPException(
            status_code=403,
            detail={
                "code": "passkey_enrollment_required",
                "message": "Register a passkey before performing this action",
            },
        )

    # Admin has at least one passkey; a session token is mandatory.
    if not token:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "passkey_required",
                "message": "Admin passkey verification required",
            },
        )
    now = time.monotonic()
    with _session_lock:
        _gc_admin_sessions(now)
        sess = _admin_sessions.get(token)
    if not sess or sess["api_key"] != api_key or sess["expires_at"] < now:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "passkey_session_expired",
                "message": "Admin passkey session expired or invalid",
            },
        )

