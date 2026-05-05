"""add users.id UUID and users.api_key_id FK

Revision ID: 0003_add_users_id_and_api_key_fk
Revises: 0002_add_api_keys_id
Create Date: 2026-05-05

EXPAND step: every user gets an opaque ``id`` UUID (the durable identity
that survives rekey), plus a typed FK ``api_key_id`` pointing at the new
``api_keys.id`` UUID. The legacy ``users.api_key`` text PK stays in
place for now — Phase 4 promotes ``users.id`` to PK and drops the text
column.

The FK uses ``ON UPDATE CASCADE`` so the existing rekey path (which
mutates ``api_keys.key`` indirectly) cannot orphan ``users.api_key_id``
during the dual-write window. Phase 5 reworks rekey to swap
``api_key_id`` to a *new* row instead of mutating it, at which point
``ON UPDATE CASCADE`` becomes belt-and-braces.

Reversible: ``downgrade()`` drops the FK and both columns.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0003_add_users_id_and_api_key_fk"
down_revision: Union[str, None] = "0002_add_api_keys_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # users.id — opaque, immutable user identity.
    op.execute(
        """
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid()
        """
    )
    op.execute("UPDATE users SET id = gen_random_uuid() WHERE id IS NULL")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'users_id_key'
            ) THEN
                ALTER TABLE users ADD CONSTRAINT users_id_key UNIQUE (id);
            END IF;
        END$$;
        """
    )

    # users.api_key_id — typed FK at api_keys.id, backfilled by joining on
    # the legacy text key. NOT NULL is asserted after backfill.
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_id UUID")
    op.execute(
        """
        UPDATE users u
           SET api_key_id = k.id
          FROM api_keys k
         WHERE u.api_key = k.key
           AND u.api_key_id IS NULL
        """
    )
    # Sanity: every user must have a matching api_keys row (FK from PRE-
    # baseline schema enforces this). Fail loudly if not.
    op.execute(
        """
        DO $$
        DECLARE
            orphans INT;
        BEGIN
            SELECT COUNT(*) INTO orphans FROM users WHERE api_key_id IS NULL;
            IF orphans > 0 THEN
                RAISE EXCEPTION
                    'Cannot apply 0003: % user row(s) have no matching '
                    'api_keys.id after backfill', orphans;
            END IF;
        END$$;
        """
    )
    op.execute("ALTER TABLE users ALTER COLUMN api_key_id SET NOT NULL")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'users_api_key_id_fkey'
            ) THEN
                ALTER TABLE users
                    ADD CONSTRAINT users_api_key_id_fkey
                    FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
                    ON UPDATE CASCADE ON DELETE RESTRICT;
            END IF;
        END$$;
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key_id "
        "ON users (api_key_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_users_api_key_id")
    op.execute(
        "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_api_key_id_fkey"
    )
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS api_key_id")
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_id_key")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS id")
