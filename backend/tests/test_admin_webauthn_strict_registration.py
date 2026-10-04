"""Tests for blocking new passkey registration while strict mode is enabled.

Exercises the ``_block_registration_in_strict_mode`` guard and the two
registration endpoints (``register/begin`` / ``register/complete``) that call
it, with strict mode monkeypatched on/off.
"""

import asyncio

import pytest
from fastapi import HTTPException

from app.routes import admin_webauthn as aw


def run(coro):
    return asyncio.run(coro)


class _Body:
    credential = {}


def test_guard_noop_when_strict_off(monkeypatch):
    monkeypatch.setattr(aw._auth, "_strict_mode_enabled", lambda: False)
    aw._block_registration_in_strict_mode()  # should not raise


def test_guard_blocks_when_strict_on(monkeypatch):
    monkeypatch.setattr(aw._auth, "_strict_mode_enabled", lambda: True)
    with pytest.raises(HTTPException) as exc:
        aw._block_registration_in_strict_mode()
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "registration_disabled_strict_mode"


def test_register_begin_blocked_in_strict_mode(monkeypatch):
    monkeypatch.setattr(aw, "_require_configured", lambda: None)
    monkeypatch.setattr(aw._auth, "_strict_mode_enabled", lambda: True)
    with pytest.raises(HTTPException) as exc:
        run(aw.register_begin(body=_Body(), api_key="K"))
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "registration_disabled_strict_mode"


def test_register_complete_blocked_in_strict_mode(monkeypatch):
    monkeypatch.setattr(aw, "_require_configured", lambda: None)
    monkeypatch.setattr(aw._auth, "_strict_mode_enabled", lambda: True)
    with pytest.raises(HTTPException) as exc:
        run(aw.register_complete(body=_Body(), api_key="K"))
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "registration_disabled_strict_mode"
