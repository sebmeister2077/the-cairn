"""Route-level tests for the public ``/usage/item-views`` endpoint (mocked DB)."""

from contextlib import contextmanager

import pytest
from starlette.requests import Request
from starlette.responses import Response

from app.routes import usage_ingest as u


def _request():
    return Request(
        {"type": "http", "method": "GET", "path": "/", "headers": [],
         "client": ("127.0.0.1", 1), "query_string": b""}
    )


class _FakeCursor:
    def __init__(self, rows, calls):
        self._rows = rows
        self._calls = calls

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        self._calls.append(params)

    def fetchall(self):
        return self._rows


class _FakeConn:
    def __init__(self, rows, calls):
        self._rows = rows
        self._calls = calls

    def cursor(self):
        return _FakeCursor(self._rows, self._calls)


@pytest.fixture
def fake_db(monkeypatch):
    calls = []
    rows = [("123", 7), ("45", 2), ("not-an-id", 99), (None, 5)]

    @contextmanager
    def get_conn():
        yield _FakeConn(rows, calls)

    monkeypatch.setattr(u.db, "is_available", lambda: True)
    monkeypatch.setattr(u.db, "get_conn", get_conn)
    monkeypatch.setattr(u, "check_scoped_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(u, "_item_views_cache", None)
    return calls


def test_item_views_keeps_only_numeric_refs_and_sets_cache_header(fake_db):
    resp = Response()
    out = u.item_views(_request(), resp)
    assert out["views"] == {"123": 7, "45": 2}
    assert "generatedAt" in out
    assert resp.headers["cache-control"].startswith("public, max-age=")
    assert fake_db == [("/market/items/:itemId",)]


def test_item_views_serves_cached_payload_without_requerying(fake_db):
    first = u.item_views(_request(), Response())
    second = u.item_views(_request(), Response())
    assert second is first
    assert len(fake_db) == 1
