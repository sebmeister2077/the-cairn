"""generalise map-features audit to per-category change rows

Revision ID: 0050_map_features_audit_category
Revises: 0049_license_api_key_id
Create Date: 2026-10-15

The map-features audit no longer logs one row per contributor upload (the proxy
re-uploads its full export ~1/min, so almost every upload was a no-op). Instead
a row is written only when a *published* category actually changed, tagged with
which ``category`` changed and that category's new merged feature ``count``.

Existing rows predate the split and are all about the traders list, so they are
backfilled with ``category = 'traders'``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0050_map_features_audit_category"
down_revision: Union[str, None] = "0049_license_api_key_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "map_features_traders_audit",
        sa.Column(
            "category",
            sa.String(),
            nullable=False,
            server_default="traders",
        ),
    )
    op.add_column(
        "map_features_traders_audit",
        sa.Column("count", sa.Integer(), nullable=True),
    )
    op.create_index(
        "idx_map_features_traders_category",
        "map_features_traders_audit",
        ["category", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_map_features_traders_category",
        table_name="map_features_traders_audit",
    )
    op.drop_column("map_features_traders_audit", "count")
    op.drop_column("map_features_traders_audit", "category")
