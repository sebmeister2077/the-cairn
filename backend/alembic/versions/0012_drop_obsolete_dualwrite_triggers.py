"""drop obsolete dual-write triggers from 0006

Revision ID: 0012_drop_dualwrite_triggers
Revises: 0011_tl_screenshot_requests
Create Date: 2026-05-11

Migration 0006 installed BEFORE INSERT/UPDATE triggers on
``feature_flags``, ``app_settings``, ``maintenance_notices``,
``contributions``, ``ip_bans``, ``admin_audit_log``,
``backup_download_links``, ``webauthn_credentials`` and ``users`` that
auto-resolved a legacy ``*_key`` text column into the corresponding
``*_id`` UUID column. Migration 0010 then **dropped** every one of
those legacy text columns (``feature_flags.updated_by_key`` etc.) but
left the triggers & helper functions in place. Any insert/update on
those tables — including the Supabase Studio "Insert row" UI on
``feature_flags`` — now fails with::

    record "new" has no field "updated_by_key"

This migration drops the obsolete trigger + helper function for every
table affected by 0010. The remaining ``webauthn_credentials`` trigger
(``api_key`` → ``user_id``) is kept because that legacy column is still
present in the schema. The application has been writing the ``*_id``
columns directly since Phase 4 (revision 0006 was always intended as a
short-lived transitional safety net), so removing these triggers is a
no-op for normal traffic.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0012_drop_dualwrite_triggers"
down_revision: Union[str, None] = "0011_tl_screenshot_requests"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Tables whose legacy text column was removed by 0010 — their dual-write
# trigger now references a non-existent ``NEW.<legacy_col>`` and must go.
_OBSOLETE_TABLES = [
    "contributions",
    "ip_bans",
    "admin_audit_log",
    "backup_download_links",
    "feature_flags",
    "app_settings",
    "maintenance_notices",
    "users",
]


def _trigger_name(table: str) -> str:
    return f"trg_dualwrite_{table}_ids_biu"


def _function_name(table: str) -> str:
    return f"trg_dualwrite_{table}_ids"


def upgrade() -> None:
    for table in _OBSOLETE_TABLES:
        op.execute(f"DROP TRIGGER IF EXISTS {_trigger_name(table)} ON {table}")
        op.execute(f"DROP FUNCTION IF EXISTS {_function_name(table)}()")


def downgrade() -> None:
    # No-op: the original triggers reference columns that no longer exist
    # (dropped in 0010), so reinstating them would immediately re-break
    # every write. If a true rollback is needed, downgrade past 0010
    # first to restore the legacy columns, then past this revision.
    pass
