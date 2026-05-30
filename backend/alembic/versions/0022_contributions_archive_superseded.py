"""contributions: per-submitter archive dedupe (supersession metadata)

Revision ID: 0022_archive_superseded
Revises: 0021_saved_routes
Create Date: 2026-05-29

Adds three nullable columns + a partial index used by the
``dedupe_archive`` worker. When a user uploads a new full-map gap-fill
that strictly supersedes their previous approved upload, the worker:

  1. Downloads both archives, runs a SQLite anti-join on ``mappiece.position``.
  2. If the old archive's position set is a strict subset of the new one,
     deletes ``archived/<old_cid>.db[.zst]`` from R2.
  3. Stamps ``superseded_by_cid = new_cid``, ``superseded_at = now()`` and
     ``archive_deleted_at = now()`` so the row stays in ``contributions``
     for audit/UI even though its R2 blob is gone.

All columns are nullable: legacy rows, region-pruned archives, and rows
whose archive was retired by the daily cleanup sweep all leave them NULL.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0022_archive_superseded"
down_revision: Union[str, None] = "0021_saved_routes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "contributions",
        sa.Column("superseded_by_cid", sa.Text(), nullable=True),
    )
    op.add_column(
        "contributions",
        sa.Column("superseded_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "contributions",
        sa.Column("archive_deleted_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_contributions_supersedable
            ON contributions (submitted_by_key_id, approved_at DESC)
            WHERE status = 'approved'
              AND superseded_by_cid IS NULL
              AND archive_deleted_at IS NULL
              AND archived_is_region_pruned IS NOT TRUE
              AND update_region_min_x IS NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_contributions_supersedable")
    op.drop_column("contributions", "archive_deleted_at")
    op.drop_column("contributions", "superseded_at")
    op.drop_column("contributions", "superseded_by_cid")
