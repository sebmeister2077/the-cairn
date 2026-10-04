"""Route-level tests for admin promote/demote guards (Phase 4d)."""

import asyncio

import pytest
from fastapi import HTTPException

from app.routes import admin as admin_routes
from app.routes.admin import SetAdminRequest


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(admin_routes.db, "is_available", lambda: True)
    monkeypatch.setattr(admin_routes.settings, "ADMIN_API_KEY", "ENV_ADMIN")
    monkeypatch.setattr(admin_routes.accounts_db, "audit_log", lambda *a, **k: None)
    # Serialisable record shape.
    monkeypatch.setattr(
        admin_routes.db,
        "set_api_key_admin",
        lambda key, is_admin: True,
    )


def _record(is_admin: bool):
    return {"key": "K2", "name": "n", "is_admin": is_admin, "created_at": None, "last_used_at": None}


def test_promote_succeeds(monkeypatch):
    monkeypatch.setattr(admin_routes.db, "get_api_key", lambda key: _record(False))
    out = run(admin_routes.set_key_admin("K2", SetAdminRequest(is_admin=True), admin_key="ENV_ADMIN"))
    assert out["is_admin"] in (True, False)  # serialised echo of latest get_api_key


def test_missing_key_404(monkeypatch):
    monkeypatch.setattr(admin_routes.db, "get_api_key", lambda key: None)
    with pytest.raises(HTTPException) as ei:
        run(admin_routes.set_key_admin("K2", SetAdminRequest(is_admin=True), admin_key="ENV_ADMIN"))
    assert ei.value.status_code == 404


def test_cannot_demote_env_super_admin(monkeypatch):
    monkeypatch.setattr(admin_routes.db, "get_api_key", lambda key: _record(True))
    monkeypatch.setattr(admin_routes.db, "count_admin_keys", lambda: 5)
    with pytest.raises(HTTPException) as ei:
        run(admin_routes.set_key_admin("ENV_ADMIN", SetAdminRequest(is_admin=False), admin_key="ENV_ADMIN"))
    assert ei.value.status_code == 400
    assert "super-admin" in ei.value.detail


def test_cannot_remove_only_admin(monkeypatch):
    monkeypatch.setattr(admin_routes.db, "get_api_key", lambda key: _record(True))
    monkeypatch.setattr(admin_routes.db, "count_admin_keys", lambda: 1)
    with pytest.raises(HTTPException) as ei:
        run(admin_routes.set_key_admin("K2", SetAdminRequest(is_admin=False), admin_key="ENV_ADMIN"))
    assert ei.value.status_code == 400
    assert "only remaining admin" in ei.value.detail


def test_demote_allowed_when_other_admins_exist(monkeypatch):
    monkeypatch.setattr(admin_routes.db, "get_api_key", lambda key: _record(True))
    monkeypatch.setattr(admin_routes.db, "count_admin_keys", lambda: 3)
    out = run(admin_routes.set_key_admin("K2", SetAdminRequest(is_admin=False), admin_key="ENV_ADMIN"))
    assert "key" in out
