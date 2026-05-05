"""add api_keys.id UUID

Revision ID: 0002_add_api_keys_id
Revises: 0001_baseline
Create Date: 2026-05-05

EXPAND step: introduce a stable opaque UUID identifier for every API key
without disturbing the existing ``key`` text PK. The new column is
populated for existing rows by ``DEFAULT gen_random_uuid()`` and is
``NOT NULL UNIQUE`` immediately so downstream FKs in later revisions
can reference it. The text ``key`` column remains the PK for now —
promotion to PK happens in Phase 4 (revision 0006).

Reversible: ``downgrade()`` drops the column. No data is lost on rollback
because nothing else has been migrated to depend on ``id`` yet.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0002_add_api_keys_id"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ``gen_random_uuid()`` lives in pgcrypto on PostgreSQL < 13. Supabase
    # bundles it; enabling is idempotent.
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute(
        """
        ALTER TABLE api_keys
            ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid()
        """
    )
    # Defensive: if the column already existed (e.g. from a previous
    # half-applied attempt) make sure every row has a value.
    op.execute("UPDATE api_keys SET id = gen_random_uuid() WHERE id IS NULL")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_id_key'
            ) THEN
                ALTER TABLE api_keys ADD CONSTRAINT api_keys_id_key UNIQUE (id);
            END IF;
        END$$;
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_id_key")
    op.execute("ALTER TABLE api_keys DROP COLUMN IF EXISTS id")
