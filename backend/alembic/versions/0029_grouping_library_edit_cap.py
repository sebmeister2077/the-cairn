"""grouping_library edit daily cap flag

Revision ID: 0029_grouping_library_edit_cap
Revises: 0028_elk_walkable_config
Create Date: 2026-06-22

Seeds the ``grouping_library_edit_daily_cap`` quota flag. Previously the
PATCH endpoint hardcoded a single edit per grouping per 24h; the cap is
now admin-tunable via the standard quota flag UI. Default 10 — high
enough that authors iterating on a freshly published grouping aren't
blocked by the cooldown, low enough to still discourage edit spam.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0029_grouping_library_edit_cap"
down_revision: Union[str, None] = "0028_elk_walkable_config"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO feature_flags (key, enabled, value_int) VALUES
            ('grouping_library_edit_daily_cap', TRUE, 10)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM feature_flags WHERE key = 'grouping_library_edit_daily_cap'"
    )
