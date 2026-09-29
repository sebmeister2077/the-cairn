"""program builds: per-platform current build, purge flag, and version-gate settings

Revision ID: 0044_program_platform_settings
Revises: 0043_usage_events_layer_index
Create Date: 2026-09-29

Two changes that back the streamlined, self-serve VSProxy distribution:

* ``program_builds`` gains a ``platform`` column (e.g. ``win-x64`` /
  ``linux-x64``) so exactly one build per platform can be *current*. Old builds
  are kept as an audit trail (version / size / sha256 / uploaded_at) but their
  R2 object is purged when superseded — ``r2_deleted`` records that the blob is
  gone while the log row remains, so a compromised version is still traceable.
* ``program_settings`` is a small key/value store for the client version gate
  (minimum supported version + the human messages) so an admin can edit it from
  the Program Downloads page instead of redeploying env vars.

See ``app/routes/admin_program.py`` and ``app/routes/licenses.py``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0044_program_platform_settings"
down_revision: Union[str, None] = "0043_usage_events_layer_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. program_builds: platform + purge flag, current is now per-platform.
    op.add_column(
        "program_builds",
        sa.Column(
            "platform",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'win-x64'"),
        ),
    )
    op.add_column(
        "program_builds",
        sa.Column(
            "r2_deleted",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.drop_index("idx_program_builds_current", table_name="program_builds")
    # At most one current build *per platform*.
    op.create_index(
        "idx_program_builds_current",
        "program_builds",
        ["platform"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )
    op.create_index(
        "idx_program_builds_platform",
        "program_builds",
        ["platform", "uploaded_at"],
        unique=False,
    )

    # 2. program_settings key/value store.
    op.create_table(
        "program_settings",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("updated_by_key_id", sa.Text(), nullable=True),
    )

    op.execute("ALTER TABLE program_settings ENABLE ROW LEVEL SECURITY;")



def downgrade() -> None:
    op.drop_table("program_settings")
    op.drop_index("idx_program_builds_platform", table_name="program_builds")
    op.drop_index("idx_program_builds_current", table_name="program_builds")
    op.create_index(
        "idx_program_builds_current",
        "program_builds",
        ["is_current"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )
    op.drop_column("program_builds", "r2_deleted")
    op.drop_column("program_builds", "platform")
