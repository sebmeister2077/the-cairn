"""elk_walkable snapshot interval flag

Revision ID: 0028_elk_walkable_config
Revises: 0027_elk_walkable_reports
Create Date: 2026-06-26

Seeds the ``elk_walkable_snapshot_interval_days`` feature flag. The
elk_walkable store previously wrote a fresh R2 snapshot of
``elk_walkable.json`` for every mutation (submit, admin revert, admin
restore). The audit log already lets us reconstruct any prior state
edge-by-edge, so the per-mutation snapshots were redundant and noisy
in the admin Snapshots list. The store now reuses the most recent
snapshot until ``value_int`` days have elapsed; default 14.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0028_elk_walkable_config"
down_revision: Union[str, None] = "0027_elk_walkable_reports"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO feature_flags (key, enabled, value_int) VALUES
            ('elk_walkable_snapshot_interval_days', TRUE, 14)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM feature_flags WHERE key = 'elk_walkable_snapshot_interval_days'"
    )
