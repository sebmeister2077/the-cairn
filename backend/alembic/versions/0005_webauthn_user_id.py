"""add webauthn_credentials.user_id with FK to users.id

Revision ID: 0005_webauthn_user_id
Revises: 0004_add_audit_id_columns
Create Date: 2026-05-05

EXPAND step: WebAuthn credentials get a typed FK at ``users.id``. The
legacy ``api_key`` column stays for now and is dropped in Phase 4.

The FK uses ``ON DELETE CASCADE`` so deleting a user (or, in Phase 5,
the rekey flow which explicitly DELETEs the user's passkeys before
swapping ``users.api_key_id``) cleans up automatically. ``ON UPDATE
CASCADE`` is included for symmetry; ``users.id`` is immutable so it
never fires.

Backfill is *partial*: rows whose ``api_key`` no longer matches a row
in ``users`` (orphaned passkeys) stay with ``user_id IS NULL``. A
cleanup step in Phase 4 will hard-delete those rows.

Reversible: ``downgrade()`` drops the FK + column.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0005_webauthn_user_id"
down_revision: Union[str, None] = "0004_add_audit_id_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE webauthn_credentials ADD COLUMN IF NOT EXISTS user_id UUID"
    )
    op.execute(
        """
        UPDATE webauthn_credentials w
           SET user_id = u.id
          FROM users u
         WHERE u.api_key = w.api_key
           AND w.user_id IS NULL
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'webauthn_credentials_user_id_fkey'
            ) THEN
                ALTER TABLE webauthn_credentials
                    ADD CONSTRAINT webauthn_credentials_user_id_fkey
                    FOREIGN KEY (user_id) REFERENCES users(id)
                    ON UPDATE CASCADE ON DELETE CASCADE;
            END IF;
        END$$;
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_webauthn_user_id "
        "ON webauthn_credentials (user_id) WHERE user_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_webauthn_user_id")
    op.execute(
        "ALTER TABLE webauthn_credentials "
        "DROP CONSTRAINT IF EXISTS webauthn_credentials_user_id_fkey"
    )
    op.execute("ALTER TABLE webauthn_credentials DROP COLUMN IF EXISTS user_id")
