"""use in-game name as display name

Revision ID: 0009_use_ingame_as_display
Revises: 0008_translocators_audit
Create Date: 2026-05-07

Adds the ``users.use_in_game_name`` toggle and drops the UNIQUE
constraint on ``users.display_name`` so two players who legitimately
share an in-game name can both opt into it as their public display
name. The trigram GIN index on ``display_name`` is unaffected and
duplicate-detection still happens via the existing user-flag system.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0009_use_ingame_as_display"
down_revision: Union[str, None] = "0008_translocators_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _find_display_name_unique_constraint(bind) -> str | None:
    """Return the actual constraint name for the UNIQUE on users.display_name.

    Defensive lookup: depending on how the table was first created the
    constraint may be the auto-generated ``users_display_name_key`` or
    something custom. We query pg_constraint to find whichever it is.
    """
    row = bind.execute(
        sa.text(
            """
            SELECT conname
              FROM pg_constraint c
              JOIN pg_class t       ON t.oid = c.conrelid
              JOIN pg_namespace n   ON n.oid = t.relnamespace
              JOIN pg_attribute a   ON a.attrelid = t.oid
                                    AND a.attnum = ANY(c.conkey)
             WHERE t.relname = 'users'
               AND n.nspname = current_schema()
               AND c.contype = 'u'
               AND a.attname = 'display_name'
               AND array_length(c.conkey, 1) = 1
             LIMIT 1
            """
        )
    ).fetchone()
    return row[0] if row else None


def upgrade() -> None:
    bind = op.get_bind()

    op.add_column(
        "users",
        sa.Column(
            "use_in_game_name",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    constraint_name = _find_display_name_unique_constraint(bind)
    if constraint_name:
        op.drop_constraint(constraint_name, "users", type_="unique")


def downgrade() -> None:
    # Re-establish uniqueness. If duplicates exist by the time someone
    # downgrades, this will fail loudly — that's intentional, the operator
    # needs to resolve the duplicates manually.
    op.create_unique_constraint(
        "users_display_name_key", "users", ["display_name"]
    )
    op.drop_column("users", "use_in_game_name")
