"""map_features_traders_audit table

Revision ID: 0047_map_features_traders_audit
Revises: 0046_drop_webauthn_trigger
Create Date: 2026-10-05

Append-only audit trail for the crowd-sourced, merged traders list published
to the public map-features bucket as ``map-features.traders.json``. Every
accepted ``/contribute-map-features`` upload writes a ``contribute`` row (who
uploaded, how many traders were received/accepted), and every rebuild that
actually publishes a new version writes a ``rebuild_publish`` row (the new
version hash + the resulting trader count). Surfaced read-only on the admin
"Map-features traders" page next to Elk-walkable.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0047_map_features_traders_audit"
down_revision: Union[str, None] = "0046_drop_webauthn_trigger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "map_features_traders_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        # 'contribute' (an accepted upload) | 'rebuild_publish' (a new merged
        # version was published) | 'admin_snapshot' (manual backup created)
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("actor_display_name", sa.String(), nullable=True),
        sa.Column("upstream_host", sa.String(), nullable=True),
        sa.Column("traders_received", sa.Integer(), nullable=True),
        sa.Column("traders_accepted", sa.Integer(), nullable=True),
        sa.Column("total_accepted", sa.Integer(), nullable=True),
        sa.Column("published_version", sa.String(), nullable=True),
        sa.Column("note", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_map_features_traders_created",
        "map_features_traders_audit",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_map_features_traders_actor",
        "map_features_traders_audit",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_map_features_traders_action",
        "map_features_traders_audit",
        ["action", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE map_features_traders_audit ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.drop_index(
        "idx_map_features_traders_action", table_name="map_features_traders_audit"
    )
    op.drop_index(
        "idx_map_features_traders_actor", table_name="map_features_traders_audit"
    )
    op.drop_index(
        "idx_map_features_traders_created", table_name="map_features_traders_audit"
    )
    op.drop_table("map_features_traders_audit")
