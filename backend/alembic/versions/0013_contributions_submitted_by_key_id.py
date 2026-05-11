"""add contributions.submitted_by_key_id (FK -> api_keys.id)

Revision ID: 0013_contrib_submitted_by_key_id
Revises: 0012_drop_dualwrite_triggers
Create Date: 2026-05-11

Migration 0004 added ``contributions.submitted_by_user_id`` (FK ->
``users.id``) as the typed replacement for the legacy
``submitted_by_key`` text column, and 0010 dropped the legacy column.
However, the application code (``database.create_contribution`` and
all account/contribution lookups) was written against
``submitted_by_key_id`` (FK -> ``api_keys.id``) — matching the pattern
used for every other audit column on the table
(``approval_requested_by_key_id``, ``revert_requested_by_key_id``,
``reverted_by_key_id``). The column was never actually created, so
``/contribute/complete`` started 500'ing with::

    psycopg2.errors.UndefinedColumn: column "submitted_by_key_id" of
    relation "contributions" does not exist

This migration adds the missing column, backfills it from
``submitted_by_user_id`` via ``users.api_key_id``, attaches the FK,
and drops the now-unused ``submitted_by_user_id``.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa  # noqa: F401


revision: str = "0013_contrib_submitted_by_key_id"
down_revision: Union[str, None] = "0012_drop_dualwrite_triggers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add the new column (nullable: anonymous / legacy submissions
    #    have no resolvable api key).
    op.execute(
        "ALTER TABLE contributions "
        "ADD COLUMN IF NOT EXISTS submitted_by_key_id UUID"
    )

    # 2. Backfill from the existing submitted_by_user_id column by
    #    walking users.api_key_id back to the api_keys row. Tolerant of
    #    rows whose user has since been deleted / re-keyed.
    op.execute(
        """
        UPDATE contributions c
           SET submitted_by_key_id = u.api_key_id
          FROM users u
         WHERE u.id = c.submitted_by_user_id
           AND c.submitted_by_user_id IS NOT NULL
           AND c.submitted_by_key_id  IS NULL
        """
    )

    # 3. Attach the FK at api_keys.id (SET NULL on key deletion mirrors
    #    the policy used for the other *_by_key_id columns on this table).
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'contributions_submitted_by_key_id_fkey'
            ) THEN
                ALTER TABLE contributions
                    ADD CONSTRAINT contributions_submitted_by_key_id_fkey
                    FOREIGN KEY (submitted_by_key_id) REFERENCES api_keys(id)
                    ON UPDATE CASCADE ON DELETE SET NULL;
            END IF;
        END$$;
        """
    )

    # 4. Partial index mirroring the lookup pattern in
    #    list_contributions_for_user / list_pending_contributions.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_contributions_submitted_by_key_id "
        "ON contributions (submitted_by_key_id) "
        "WHERE submitted_by_key_id IS NOT NULL"
    )

    # 5. Drop the now-unused submitted_by_user_id column (and its FK +
    #    partial index installed by 0004). No application code reads it.
    op.execute("DROP INDEX IF EXISTS idx_contributions_submitted_by_user_id")
    op.execute(
        "ALTER TABLE contributions "
        "DROP CONSTRAINT IF EXISTS contributions_submitted_by_user_id_fkey"
    )
    op.execute(
        "ALTER TABLE contributions DROP COLUMN IF EXISTS submitted_by_user_id"
    )


def downgrade() -> None:
    # Recreate submitted_by_user_id (FK -> users.id), backfill from
    # submitted_by_key_id by walking users.api_key_id, then drop the
    # _key_id column.
    op.execute(
        "ALTER TABLE contributions "
        "ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID"
    )
    op.execute(
        """
        UPDATE contributions c
           SET submitted_by_user_id = u.id
          FROM users u
         WHERE u.api_key_id = c.submitted_by_key_id
           AND c.submitted_by_key_id  IS NOT NULL
           AND c.submitted_by_user_id IS NULL
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'contributions_submitted_by_user_id_fkey'
            ) THEN
                ALTER TABLE contributions
                    ADD CONSTRAINT contributions_submitted_by_user_id_fkey
                    FOREIGN KEY (submitted_by_user_id) REFERENCES users(id)
                    ON UPDATE CASCADE ON DELETE SET NULL;
            END IF;
        END$$;
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_contributions_submitted_by_user_id "
        "ON contributions (submitted_by_user_id) "
        "WHERE submitted_by_user_id IS NOT NULL"
    )

    op.execute("DROP INDEX IF EXISTS idx_contributions_submitted_by_key_id")
    op.execute(
        "ALTER TABLE contributions "
        "DROP CONSTRAINT IF EXISTS contributions_submitted_by_key_id_fkey"
    )
    op.execute(
        "ALTER TABLE contributions DROP COLUMN IF EXISTS submitted_by_key_id"
    )
