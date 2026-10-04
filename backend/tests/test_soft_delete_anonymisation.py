"""Unit tests for `soft_delete_user` anonymisation + order deactivation.

Uses a fake DB connection/cursor (no Postgres) to capture the SQL emitted
inside the single soft-delete transaction and assert that every denormalised
display-name column is scrubbed and the user's open orders are closed.
"""

import uuid

import pytest

from app.core import accounts_db


class _FakeCursor:
    def __init__(self, recorder, user_row):
        self._recorder = recorder
        self._user_row = user_row
        self._last_returns_row = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._recorder.append((" ".join(sql.split()), params))
        self._last_returns_row = "RETURNING" in sql and "users" in sql

    def fetchone(self):
        return self._user_row if self._last_returns_row else None


class _FakeConn:
    def __init__(self, recorder, user_row):
        self._recorder = recorder
        self._user_row = user_row

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self, *a, **k):
        return _FakeCursor(self._recorder, self._user_row)


@pytest.fixture
def captured(monkeypatch):
    recorder = []
    key_id = uuid.uuid4()
    user_row = {"id": uuid.uuid4(), "api_key_id": key_id, "display_name": "tomb"}

    monkeypatch.setattr(accounts_db.api_key_cache, "ensure_id", lambda k: key_id)
    monkeypatch.setattr(accounts_db.api_key_cache, "invalidate", lambda k: None)
    monkeypatch.setattr(accounts_db, "get_conn", lambda: _FakeConn(recorder, user_row))

    tombstone = "[deleted-1700000000]"
    result = accounts_db.soft_delete_user("SOME_KEY", tombstone)
    return recorder, str(key_id), tombstone, result


def test_returns_updated_row(captured):
    _, _, _, result = captured
    assert result is not None
    assert result["display_name"] == "tomb"


def test_core_user_and_key_updates(captured):
    recorder, key_str, tombstone, _ = captured
    joined = " || ".join(sql for sql, _ in recorder)
    assert "UPDATE users" in joined
    assert "UPDATE api_keys SET revoked = TRUE" in joined


def test_every_denormalised_name_table_is_scrubbed(captured):
    recorder, key_str, tombstone, _ = captured
    statements = {sql: params for sql, params in recorder}

    expected = [
        ("landmarks_audit", "actor_display_name", "actor_api_key_id"),
        ("landmark_edit_requests", "submitted_by_display_name", "submitted_by_api_key_id"),
        ("translocators_audit", "actor_display_name", "actor_api_key_id"),
        ("translocator_screenshot_requests", "submitter_display_name", "submitter_api_key_id"),
        ("traders_audit", "actor_display_name", "actor_api_key_id"),
        ("trader_claim_types_audit", "actor_display_name", "actor_api_key_id"),
        ("trader_claim_empty_audit", "actor_display_name", "actor_api_key_id"),
        ("elk_walkable_audit", "actor_display_name", "actor_api_key_id"),
        ("elk_walkable_reports", "reporter_display_name", "reporter_api_key_id"),
    ]

    for table, name_col, key_col in expected:
        match = [
            (sql, params)
            for sql, params in recorder
            if sql.startswith(f"UPDATE {table} SET {name_col}")
        ]
        assert match, f"missing anonymisation UPDATE for {table}"
        sql, params = match[0]
        assert f"WHERE {key_col} = %s" in sql
        assert params == (tombstone, key_str)


def test_open_orders_are_closed(captured):
    recorder, key_str, _, _ = captured
    match = [
        (sql, params)
        for sql, params in recorder
        if sql.startswith("UPDATE orders SET status = 'closed'")
    ]
    assert match, "missing order deactivation UPDATE"
    sql, params = match[0]
    assert "WHERE author_api_key_id = %s AND status = 'open'" in sql
    assert params == (key_str,)
