"""Route-level tests for the promo-events endpoints (mocked DB)."""

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.routes import promos as promo_routes
from app.routes.promos import PromoCreate, PromoPatch


def run(coro):
    return asyncio.run(coro)


def _row(**over):
    base = {
        "id": "abc123",
        "title": "Test promo",
        "content": {"summary": "hi"},
        "image_key": None,
        "image_content_type": None,
        "active": False,
        "expires_at": None,
        "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 1, 2, tzinfo=timezone.utc),
        "created_by_key_id": None,
    }
    base.update(over)
    return base


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(promo_routes.accounts_db, "audit_log", lambda *a, **k: None)
    monkeypatch.setattr(promo_routes, "resolve_key_id", lambda key: None)


def test_serialise_includes_cache_busted_image_url():
    out = promo_routes._serialise_promo(_row(image_key="promos/abc123/banner"))
    assert out["has_image"] is True
    assert out["image_url"] == "/promos/abc123/image?v=" + str(
        int(datetime(2026, 1, 2, tzinfo=timezone.utc).timestamp() * 1000)
    )


def test_serialise_no_image():
    out = promo_routes._serialise_promo(_row())
    assert out["has_image"] is False
    assert out["image_url"] is None


def test_active_returns_null_when_none(monkeypatch):
    monkeypatch.setattr(promo_routes.db, "get_active_promo_event", lambda: None)
    out = run(promo_routes.get_active_promo(request=None, _info={}))
    assert out == {"promo": None}


def test_active_returns_serialised(monkeypatch):
    monkeypatch.setattr(
        promo_routes.db, "get_active_promo_event", lambda: _row(active=True)
    )
    out = run(promo_routes.get_active_promo(request=None, _info={}))
    assert out["promo"]["id"] == "abc123"
    assert out["promo"]["active"] is True


def test_create_activates_when_requested(monkeypatch):
    created = {}

    def _create(promo_id, title, **kw):
        created["id"] = promo_id
        return _row(id=promo_id, title=title)

    activated = {}

    def _set_active(promo_id, active):
        activated["id"] = promo_id
        activated["active"] = active
        return _row(id=promo_id, active=active)

    monkeypatch.setattr(promo_routes.db, "create_promo_event", _create)
    monkeypatch.setattr(promo_routes.db, "set_promo_event_active", _set_active)

    out = run(
        promo_routes.create_promo(
            PromoCreate(title="New", content={"summary": "x"}, active=True),
            api_key="K",
        )
    )
    assert out["promo"]["active"] is True
    assert activated["active"] is True
    assert activated["id"] == created["id"]


def test_create_without_active_does_not_activate(monkeypatch):
    monkeypatch.setattr(
        promo_routes.db,
        "create_promo_event",
        lambda promo_id, title, **kw: _row(id=promo_id, title=title),
    )

    def _boom(*a, **k):
        raise AssertionError("should not activate")

    monkeypatch.setattr(promo_routes.db, "set_promo_event_active", _boom)
    out = run(promo_routes.create_promo(PromoCreate(title="New"), api_key="K"))
    assert out["promo"]["active"] is False


def test_patch_missing_404(monkeypatch):
    monkeypatch.setattr(promo_routes.db, "get_promo_event", lambda pid: None)
    with pytest.raises(HTTPException) as ei:
        run(promo_routes.patch_promo("nope", PromoPatch(title="x"), api_key="K"))
    assert ei.value.status_code == 404


def test_patch_sets_active(monkeypatch):
    monkeypatch.setattr(promo_routes.db, "get_promo_event", lambda pid: _row(id=pid))
    monkeypatch.setattr(
        promo_routes.db,
        "update_promo_event",
        lambda pid, **kw: _row(id=pid, **{k: v for k, v in kw.items() if k != "content"}),
    )
    seen = {}

    def _set_active(pid, active):
        seen["active"] = active
        return _row(id=pid, active=active)

    monkeypatch.setattr(promo_routes.db, "set_promo_event_active", _set_active)
    out = run(
        promo_routes.patch_promo("abc123", PromoPatch(active=True), api_key="K")
    )
    assert seen["active"] is True
    assert out["promo"]["active"] is True


def test_delete_missing_404(monkeypatch):
    monkeypatch.setattr(promo_routes.db, "get_promo_event", lambda pid: None)
    with pytest.raises(HTTPException) as ei:
        run(promo_routes.delete_promo("nope", api_key="K"))
    assert ei.value.status_code == 404


def test_delete_ok(monkeypatch):
    monkeypatch.setattr(promo_routes.db, "get_promo_event", lambda pid: _row(id=pid))
    monkeypatch.setattr(promo_routes.db, "delete_promo_event", lambda pid: True)
    out = run(promo_routes.delete_promo("abc123", api_key="K"))
    assert out == {"deleted": True}


def test_content_too_large_rejected():
    big = {"summary": "x" * 20000}
    with pytest.raises(HTTPException) as ei:
        promo_routes._validate_content(big)
    assert ei.value.status_code == 400
