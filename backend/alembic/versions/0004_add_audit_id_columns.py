"""add *_id audit columns alongside legacy *_by_key text columns

Revision ID: 0004_add_audit_id_columns
Revises: 0003_add_users_id_and_api_key_fk
Create Date: 2026-05-05

EXPAND step: every audit / "who did this" column gets a parallel
``*_id UUID`` column with a typed FK at ``api_keys.id`` (or ``users.id``
where the column is guaranteed to refer to a registered user). Backfill
joins on the legacy text column and is tolerant of dangling references
(legacy admin keys not in ``api_keys`` are left NULL).

The legacy text columns stay in place — Phase 4 (revision 0007) drops
them after Phase 3 has dual-written for one release.

Reversible: ``downgrade()`` drops every new column and FK.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0004_add_audit_id_columns"
down_revision: Union[str, None] = "0003_add_users_id_and_api_key_fk"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, new_uuid_column, legacy_text_column, target_table, on_delete, fk_name)
# target_table is 'api_keys' (FK -> api_keys.id) or 'users' (FK -> users.id).
_COLUMNS = [
    # contributions: who submitted is a user-bound key when present.
    ("contributions", "submitted_by_user_id", "submitted_by_key", "users", "SET NULL", "contributions_submitted_by_user_id_fkey"),
    # contributions: who queued/ran an admin op — admin keys are not
    # guaranteed to have a users row, so FK at api_keys.id.
    ("contributions", "approval_requested_by_key_id", "approval_requested_by_key", "api_keys", "SET NULL", "contributions_approval_requested_by_key_id_fkey"),
    ("contributions", "revert_requested_by_key_id",   "revert_requested_by_key",   "api_keys", "SET NULL", "contributions_revert_requested_by_key_id_fkey"),
    ("contributions", "reverted_by_key_id",           "reverted_by_key",           "api_keys", "SET NULL", "contributions_reverted_by_key_id_fkey"),
    # ip_bans / admin_audit_log / backup_download_links / settings tables —
    # every ``*_by`` value is an admin key.
    ("ip_bans",                "banned_by_key_id",   "banned_by",      "api_keys", "SET NULL", "ip_bans_banned_by_key_id_fkey"),
    ("admin_audit_log",        "admin_key_id",       "admin_key",      "api_keys", "SET NULL", "admin_audit_log_admin_key_id_fkey"),
    ("backup_download_links",  "created_by_key_id",  "created_by",     "api_keys", "SET NULL", "backup_download_links_created_by_key_id_fkey"),
    ("backup_download_links",  "revoked_by_key_id",  "revoked_by",     "api_keys", "SET NULL", "backup_download_links_revoked_by_key_id_fkey"),
    ("feature_flags",          "updated_by_key_id",  "updated_by_key", "api_keys", "SET NULL", "feature_flags_updated_by_key_id_fkey"),
    ("app_settings",           "updated_by_key_id",  "updated_by_key", "api_keys", "SET NULL", "app_settings_updated_by_key_id_fkey"),
    ("maintenance_notices",    "updated_by_key_id",  "updated_by_key", "api_keys", "SET NULL", "maintenance_notices_updated_by_key_id_fkey"),
]


def upgrade() -> None:
    for table, new_col, legacy_col, target, on_delete, fk_name in _COLUMNS:
        # 1. Add the new column (nullable — admin/legacy keys may not be
        #    resolvable on backfill).
        op.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {new_col} UUID"
        )
        # 2. Backfill from the legacy text column. The join key on the
        #    target side is always the text ``key``/``api_key`` column.
        if target == "users":
            op.execute(
                f"""
                UPDATE {table} t
                   SET {new_col} = u.id
                  FROM users u
                 WHERE u.api_key = t.{legacy_col}
                   AND t.{legacy_col} IS NOT NULL
                   AND t.{new_col} IS NULL
                """
            )
        else:  # api_keys
            op.execute(
                f"""
                UPDATE {table} t
                   SET {new_col} = k.id
                  FROM api_keys k
                 WHERE k.key = t.{legacy_col}
                   AND t.{legacy_col} IS NOT NULL
                   AND t.{new_col} IS NULL
                """
            )
        # 3. Add FK if missing.
        target_pk = "id"
        op.execute(
            f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = '{fk_name}'
                ) THEN
                    ALTER TABLE {table}
                        ADD CONSTRAINT {fk_name}
                        FOREIGN KEY ({new_col}) REFERENCES {target}({target_pk})
                        ON UPDATE CASCADE ON DELETE {on_delete};
                END IF;
            END$$;
            """
        )
        # 4. Partial index to mirror the existing query patterns
        #    (most lookups filter "WHERE *_id IS NOT NULL" implicitly).
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{table}_{new_col} "
            f"ON {table} ({new_col}) WHERE {new_col} IS NOT NULL"
        )


def downgrade() -> None:
    # Drop in reverse order so dependent indexes/FKs go before the column.
    for table, new_col, _legacy_col, _target, _on_delete, fk_name in reversed(_COLUMNS):
        op.execute(f"DROP INDEX IF EXISTS idx_{table}_{new_col}")
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {fk_name}")
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {new_col}")
