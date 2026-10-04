"""Unit tests for admin passkey enforcement + multi-admin auth (Phase 4d).

These exercise the auth-layer logic directly (dependency callables + helpers)
with the DB and settings monkeypatched, so no Postgres / FastAPI app is needed.
"""

import asyncio
import time

import pytest
from fastapi import HTTPException

from app import auth


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run(coro):
    return asyncio.run(coro)


class FakeRequest:
    def __init__(self, method="GET"):
        self.method = method


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    """Baseline: DB available, WebAuthn enforced, env super-admin set, no
    passkeys, strict mode off, empty session store."""
    monkeypatch.setattr(auth.db, "is_available", lambda: True)
    monkeypatch.setattr(auth.db, "count_webauthn_credentials", lambda key: 0)
    monkeypatch.setattr(auth.db, "get_app_setting", lambda key: None)
    monkeypatch.setattr(auth.db, "get_api_key", lambda key: None)
    monkeypatch.setattr(auth.api_key_cache, "peek", lambda key: None)
    monkeypatch.setattr(auth.settings, "WEBAUTHN_ENFORCE", True)
    monkeypatch.setattr(auth.settings, "ADMIN_API_KEY", "ENV_ADMIN")
    auth._admin_sessions.clear()
    yield
    auth._admin_sessions.clear()


def _grant_session(api_key: str, token: str, ttl: int = 3600):
    auth._admin_sessions[token] = {
        "api_key": api_key,
        "ip_hash": "x",
        "expires_at": time.monotonic() + ttl,
    }


def _set_passkeys(monkeypatch, count: int):
    monkeypatch.setattr(auth.db, "count_webauthn_credentials", lambda key: count)


def _enable_strict(monkeypatch):
    monkeypatch.setattr(
        auth.db,
        "get_app_setting",
        lambda key: {"value": True} if key == auth.STRICT_MODE_SETTING_KEY else None,
    )


# ---------------------------------------------------------------------------
# is_admin_key — env super-admin + DB-backed admins
# ---------------------------------------------------------------------------

def test_env_key_is_admin():
    assert auth.is_admin_key("ENV_ADMIN") is True


def test_unknown_key_is_not_admin():
    assert auth.is_admin_key("nope") is False


def test_db_flagged_key_is_admin_via_cache(monkeypatch):
    monkeypatch.setattr(auth.api_key_cache, "peek", lambda key: {"is_admin": True})
    assert auth.is_admin_key("K2") is True


def test_db_flagged_key_is_admin_via_db_fallback(monkeypatch):
    monkeypatch.setattr(auth.db, "get_api_key", lambda key: {"is_admin": True})
    assert auth.is_admin_key("K2") is True


def test_db_non_admin_key(monkeypatch):
    monkeypatch.setattr(auth.db, "get_api_key", lambda key: {"is_admin": False})
    assert auth.is_admin_key("K2") is False


# ---------------------------------------------------------------------------
# _enforce_passkey_session — non-strict (legacy opt-in)
# ---------------------------------------------------------------------------

def test_nonstrict_noop_when_enforce_off(monkeypatch):
    monkeypatch.setattr(auth.settings, "WEBAUTHN_ENFORCE", False)
    _set_passkeys(monkeypatch, 3)
    auth._enforce_passkey_session("K", None, strict=False)


def test_nonstrict_noop_when_no_passkeys(monkeypatch):
    _set_passkeys(monkeypatch, 0)
    auth._enforce_passkey_session("K", None, strict=False)


def test_nonstrict_requires_session_when_enrolled(monkeypatch):
    _set_passkeys(monkeypatch, 1)
    with pytest.raises(HTTPException) as ei:
        auth._enforce_passkey_session("K", None, strict=False)
    assert ei.value.status_code == 401
    assert ei.value.detail["code"] == "passkey_required"


def test_nonstrict_passes_with_valid_session(monkeypatch):
    _set_passkeys(monkeypatch, 1)
    _grant_session("K", "tok")
    auth._enforce_passkey_session("K", "tok", strict=False)


# ---------------------------------------------------------------------------
# _enforce_passkey_session — strict
# ---------------------------------------------------------------------------

def test_strict_blocks_when_no_passkeys(monkeypatch):
    _set_passkeys(monkeypatch, 0)
    with pytest.raises(HTTPException) as ei:
        auth._enforce_passkey_session("K", "whatever", strict=True)
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "passkey_enrollment_required"


def test_strict_ignores_enforce_flag(monkeypatch):
    monkeypatch.setattr(auth.settings, "WEBAUTHN_ENFORCE", False)
    _set_passkeys(monkeypatch, 0)
    with pytest.raises(HTTPException) as ei:
        auth._enforce_passkey_session("K", None, strict=True)
    assert ei.value.detail["code"] == "passkey_enrollment_required"


def test_strict_requires_session_when_enrolled(monkeypatch):
    _set_passkeys(monkeypatch, 2)
    with pytest.raises(HTTPException) as ei:
        auth._enforce_passkey_session("K", None, strict=True)
    assert ei.value.detail["code"] == "passkey_required"


def test_strict_passes_with_valid_session(monkeypatch):
    _set_passkeys(monkeypatch, 2)
    _grant_session("K", "tok")
    auth._enforce_passkey_session("K", "tok", strict=True)


def test_strict_fails_closed_when_db_down(monkeypatch):
    monkeypatch.setattr(auth.db, "is_available", lambda: False)
    with pytest.raises(HTTPException) as ei:
        auth._enforce_passkey_session("K", "tok", strict=True)
    assert ei.value.status_code == 503


# ---------------------------------------------------------------------------
# require_admin — method-aware under strict mode
# ---------------------------------------------------------------------------

def test_require_admin_rejects_non_admin(monkeypatch):
    with pytest.raises(HTTPException) as ei:
        run(auth.require_admin(FakeRequest("GET"), "stranger", None))
    assert ei.value.status_code == 403


def test_require_admin_readonly_allowed_without_passkey_under_strict(monkeypatch):
    _enable_strict(monkeypatch)
    _set_passkeys(monkeypatch, 0)
    assert run(auth.require_admin(FakeRequest("GET"), "ENV_ADMIN", None)) == "ENV_ADMIN"


def test_require_admin_mutating_blocked_without_passkey_under_strict(monkeypatch):
    _enable_strict(monkeypatch)
    _set_passkeys(monkeypatch, 0)
    with pytest.raises(HTTPException) as ei:
        run(auth.require_admin(FakeRequest("POST"), "ENV_ADMIN", None))
    assert ei.value.detail["code"] == "passkey_enrollment_required"


def test_require_admin_mutating_allowed_when_strict_off(monkeypatch):
    _set_passkeys(monkeypatch, 0)
    assert run(auth.require_admin(FakeRequest("POST"), "ENV_ADMIN", None)) == "ENV_ADMIN"


def test_require_admin_mutating_allowed_with_session_under_strict(monkeypatch):
    _enable_strict(monkeypatch)
    _set_passkeys(monkeypatch, 1)
    _grant_session("ENV_ADMIN", "tok")
    assert run(auth.require_admin(FakeRequest("DELETE"), "ENV_ADMIN", "tok")) == "ENV_ADMIN"


# ---------------------------------------------------------------------------
# require_admin_critical — GET gated under strict mode
# ---------------------------------------------------------------------------

def test_require_admin_critical_blocks_read_without_passkey_under_strict(monkeypatch):
    _enable_strict(monkeypatch)
    _set_passkeys(monkeypatch, 0)
    with pytest.raises(HTTPException) as ei:
        run(auth.require_admin_critical(FakeRequest("GET"), "ENV_ADMIN", None))
    assert ei.value.detail["code"] == "passkey_enrollment_required"


def test_require_admin_critical_read_allowed_when_strict_off(monkeypatch):
    _set_passkeys(monkeypatch, 0)
    assert run(auth.require_admin_critical(FakeRequest("GET"), "ENV_ADMIN", None)) == "ENV_ADMIN"


# ---------------------------------------------------------------------------
# require_admin_passkey — always strict (privileged actions)
# ---------------------------------------------------------------------------

def test_require_admin_passkey_blocks_without_passkey_even_when_strict_off(monkeypatch):
    _set_passkeys(monkeypatch, 0)
    with pytest.raises(HTTPException) as ei:
        run(auth.require_admin_passkey(FakeRequest("PATCH"), "ENV_ADMIN", None))
    assert ei.value.detail["code"] == "passkey_enrollment_required"


def test_require_admin_passkey_requires_session(monkeypatch):
    _set_passkeys(monkeypatch, 1)
    with pytest.raises(HTTPException) as ei:
        run(auth.require_admin_passkey(FakeRequest("PATCH"), "ENV_ADMIN", None))
    assert ei.value.detail["code"] == "passkey_required"


def test_require_admin_passkey_passes_with_session(monkeypatch):
    _set_passkeys(monkeypatch, 1)
    _grant_session("ENV_ADMIN", "tok")
    assert run(auth.require_admin_passkey(FakeRequest("PATCH"), "ENV_ADMIN", "tok")) == "ENV_ADMIN"


# ---------------------------------------------------------------------------
# strict-mode flag helpers
# ---------------------------------------------------------------------------

def test_strict_mode_disabled_by_default(monkeypatch):
    assert auth._strict_mode_enabled() is False


def test_strict_mode_enabled_reads_app_setting(monkeypatch):
    _enable_strict(monkeypatch)
    assert auth._strict_mode_enabled() is True


def test_strict_mode_dict_value(monkeypatch):
    monkeypatch.setattr(auth.db, "get_app_setting", lambda key: {"value": {"enabled": True}})
    assert auth._strict_mode_enabled() is True


def test_strict_mode_false_when_db_down(monkeypatch):
    monkeypatch.setattr(auth.db, "is_available", lambda: False)
    assert auth._strict_mode_enabled() is False
