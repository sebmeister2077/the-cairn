"""dual-write triggers: auto-fill *_id columns from legacy *_key text columns

Revision ID: 0006_dualwrite_triggers
Revises: 0005_webauthn_user_id
Create Date: 2026-05-05

MIGRATE step (Phase 3): rather than touching every INSERT site in the
application, install BEFORE INSERT/UPDATE triggers that resolve the
legacy text column (``*_key`` / ``api_key`` / ``banned_by`` / etc.) to
the corresponding UUID and stamp the new ``*_id`` column. This keeps
Phase 3 to a single, atomic, fully-reversible DB change with zero risk
of the application drifting out of sync with the schema.

Behaviour:
* If the new ``*_id`` column is already provided by the caller, the
  trigger leaves it alone (so when Phase 4 switches the app to write
  ``*_id`` directly, the triggers — even if still installed — are no-ops).
* If the legacy text column is NULL, the new column is set to NULL.
* If the legacy text column references a row that no longer exists in
  ``api_keys`` / ``users``, the new column stays NULL (matches the
  ``ON DELETE SET NULL`` semantics chosen in revisions 0004 and 0005).

Reversible: ``downgrade()`` drops every trigger and helper function. The
``*_id`` columns themselves are governed by their respective revisions.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0006_dualwrite_triggers"
down_revision: Union[str, None] = "0005_webauthn_user_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, [(legacy_text_col, new_uuid_col, target_table, target_text_col, target_uuid_col), ...])
# target_table='api_keys' resolves via api_keys.key -> api_keys.id
# target_table='users'    resolves via users.api_key -> users.id
_TRIGGER_TABLES = [
    ("contributions", [
        ("submitted_by_key",          "submitted_by_user_id",          "users",    "api_key", "id"),
        ("approval_requested_by_key", "approval_requested_by_key_id", "api_keys", "key",     "id"),
        ("revert_requested_by_key",   "revert_requested_by_key_id",   "api_keys", "key",     "id"),
        ("reverted_by_key",           "reverted_by_key_id",           "api_keys", "key",     "id"),
    ]),
    ("ip_bans", [
        ("banned_by", "banned_by_key_id", "api_keys", "key", "id"),
    ]),
    ("admin_audit_log", [
        ("admin_key", "admin_key_id", "api_keys", "key", "id"),
    ]),
    ("backup_download_links", [
        ("created_by", "created_by_key_id", "api_keys", "key", "id"),
        ("revoked_by", "revoked_by_key_id", "api_keys", "key", "id"),
    ]),
    ("feature_flags", [
        ("updated_by_key", "updated_by_key_id", "api_keys", "key", "id"),
    ]),
    ("app_settings", [
        ("updated_by_key", "updated_by_key_id", "api_keys", "key", "id"),
    ]),
    ("maintenance_notices", [
        ("updated_by_key", "updated_by_key_id", "api_keys", "key", "id"),
    ]),
    # webauthn_credentials.api_key -> users.id
    ("webauthn_credentials", [
        ("api_key", "user_id", "users", "api_key", "id"),
    ]),
    # users.api_key -> api_keys.id (so legacy users-table writers also dual-write)
    ("users", [
        ("api_key", "api_key_id", "api_keys", "key", "id"),
    ]),
]


def _function_name(table: str) -> str:
    return f"trg_dualwrite_{table}_ids"


def _trigger_name(table: str) -> str:
    return f"trg_dualwrite_{table}_ids_biu"


def upgrade() -> None:
    for table, columns in _TRIGGER_TABLES:
        # Build the function body. Each mapping resolves the legacy text
        # column to a UUID via a scalar subquery; ``COALESCE`` makes the
        # trigger a no-op when the caller already provided the new column.
        body_lines = []
        for legacy_col, new_col, target_table, target_text_col, target_uuid_col in columns:
            body_lines.append(
                f"""
                IF NEW.{new_col} IS NULL AND NEW.{legacy_col} IS NOT NULL THEN
                    NEW.{new_col} := (
                        SELECT {target_uuid_col} FROM {target_table}
                         WHERE {target_text_col} = NEW.{legacy_col}
                         LIMIT 1
                    );
                END IF;
                """
            )
        body = "\n".join(body_lines)

        op.execute(
            f"""
            CREATE OR REPLACE FUNCTION {_function_name(table)}()
            RETURNS TRIGGER AS $$
            BEGIN
                {body}
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            """
        )
        # DROP + CREATE to keep the trigger spec authoritative on every
        # re-run (idempotent across re-applications via stamp/upgrade).
        op.execute(
            f"DROP TRIGGER IF EXISTS {_trigger_name(table)} ON {table}"
        )
        op.execute(
            f"""
            CREATE TRIGGER {_trigger_name(table)}
                BEFORE INSERT OR UPDATE ON {table}
                FOR EACH ROW
                EXECUTE FUNCTION {_function_name(table)}();
            """
        )

    # Final reconciliation pass: catch any rows that may have been written
    # between the Phase 2 backfill (revisions 0003-0005) and this trigger
    # going live. Idempotent — only touches NULL ``*_id`` rows whose
    # legacy text column resolves to a known row.
    for table, columns in _TRIGGER_TABLES:
        for legacy_col, new_col, target_table, target_text_col, target_uuid_col in columns:
            op.execute(
                f"""
                UPDATE {table} t
                   SET {new_col} = src.{target_uuid_col}
                  FROM {target_table} src
                 WHERE src.{target_text_col} = t.{legacy_col}
                   AND t.{legacy_col} IS NOT NULL
                   AND t.{new_col} IS NULL
                """
            )


def downgrade() -> None:
    for table, _columns in _TRIGGER_TABLES:
        op.execute(f"DROP TRIGGER IF EXISTS {_trigger_name(table)} ON {table}")
        op.execute(f"DROP FUNCTION IF EXISTS {_function_name(table)}()")
