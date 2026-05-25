"""contributions: region-pruned archive metadata

Revision ID: 0019_archive_pruned
Revises: 0018_feature_flag_value_int
Create Date: 2026-05-22

Adds four columns to ``contributions`` recording the result of the
post-approval region-pruned archive job (Phase 3 of region-overwrite):

- ``archived_is_region_pruned`` — TRUE when the archive at
  ``archived/<id>.db[.zst]`` contains only the in-region tiles rather
  than the full upload. NULL on legacy / gap-fill rows.
- ``archived_kept_tiles`` — count of mappiece rows in the pruned archive.
- ``archived_src_bytes`` — size of the original pending .db before pruning.
- ``archived_dst_bytes`` — size of the pruned .db (pre-compression).

All columns are nullable so existing rows (and future gap-fill
contributions, which skip pruning) keep working without backfill.
"""

from __future__ import annotations

from typing import Sequence, Union
import sqlalchemy as sa

from alembic import op


revision: str = "0019_archive_pruned"
down_revision: Union[str, None] = "0018_feature_flag_value_int"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "contributions",
        sa.Column("archived_is_region_pruned", sa.Boolean(), nullable=True),
    )
    op.add_column(
        "contributions",
        sa.Column("archived_kept_tiles", sa.Integer(), nullable=True),
    )
    op.add_column(
        "contributions",
        sa.Column("archived_src_bytes", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "contributions",
        sa.Column("archived_dst_bytes", sa.BigInteger(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("contributions", "archived_is_region_pruned")
    op.drop_column("contributions", "archived_kept_tiles")
    op.drop_column("contributions", "archived_src_bytes")
    op.drop_column("contributions", "archived_dst_bytes")
