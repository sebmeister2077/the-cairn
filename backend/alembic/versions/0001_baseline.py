"""baseline schema (matches pre-Alembic ensure_schema())

Revision ID: 0001_baseline
Revises:
Create Date: 2026-05-05

This revision is the snapshot of the schema as it existed immediately
before Alembic was introduced. It re-runs the same idempotent DDL blocks
that ``backend.app.core.database.ensure_schema()`` used to execute on
startup, so:

* On a brand-new database, ``alembic upgrade head`` produces a schema
  byte-identical to today's.
* On the production database (which already has every object), this
  revision is applied via ``alembic stamp 0001_baseline`` instead of being
  executed — no DDL re-runs.

``downgrade()`` is intentionally a hard error: there is nothing to roll
back to. Future revisions must implement a real ``downgrade()``.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

# Pull the SQL blocks straight from the legacy module so this migration
# stays in lockstep with what older deployments built. Once Phase 4 lands
# and the legacy blocks are deleted, inline the SQL here.
from app.core.database import (
    _ACCOUNT_SCHEMA_SQL,
    _MIGRATIONS_SQL,
    _SCHEMA_SQL,
)

# revision identifiers, used by Alembic.
revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(_SCHEMA_SQL)
    op.execute(_MIGRATIONS_SQL)
    op.execute(_ACCOUNT_SCHEMA_SQL)
    # Mirror the user_flags FK repair from ensure_schema().
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.referential_constraints
                WHERE constraint_name = 'user_flags_flagged_user_fkey'
                  AND update_rule <> 'CASCADE'
            ) THEN
                ALTER TABLE user_flags
                    DROP CONSTRAINT user_flags_flagged_user_fkey,
                    ADD CONSTRAINT user_flags_flagged_user_fkey
                        FOREIGN KEY (flagged_user) REFERENCES users(api_key)
                        ON UPDATE CASCADE ON DELETE CASCADE;
            END IF;
            IF EXISTS (
                SELECT 1 FROM information_schema.referential_constraints
                WHERE constraint_name = 'user_flags_related_user_fkey'
                  AND update_rule <> 'CASCADE'
            ) THEN
                ALTER TABLE user_flags
                    DROP CONSTRAINT user_flags_related_user_fkey,
                    ADD CONSTRAINT user_flags_related_user_fkey
                        FOREIGN KEY (related_user) REFERENCES users(api_key)
                        ON UPDATE CASCADE ON DELETE SET NULL;
            END IF;
        END$$;
        """
    )


def downgrade() -> None:
    raise RuntimeError(
        "Cannot downgrade past the 0001_baseline revision: it is the "
        "schema snapshot captured when Alembic was introduced."
    )
