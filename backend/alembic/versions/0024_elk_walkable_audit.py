"""elk_walkable_audit table + feature flag

Revision ID: 0024_elk_walkable_audit
Revises: 0023_manual_translocators_flag
Create Date: 2026-06-01

Backs the "elk-accessible walkable edges between TLs" feature. The JSON
file in R2 (``elk_walkable.json``) is the source of truth for confirmed
edges; this table records every attest / unattest / admin revert /
admin snapshot restore for audit + revert capability. See
``app/db/models/elk_walkable.py`` for documentation.

Also seeds two feature-flag rows so the new UI is discoverable in the
admin Manage → Feature Flags page:

- ``elk_walkable_contributions`` (boolean, default FALSE): gates the
  POST /api/elk-walkable/submit endpoint + the Route-Planner draft UI.
- ``elk_walkable_daily_cap`` (quota row, value_int NULL → handler
  default 10 applies): per-API-key max submissions per 24h.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0024_elk_walkable_audit"
down_revision: Union[str, None] = "0023_manual_translocators_flag"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "elk_walkable_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("change_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("edge_key", sa.String(), nullable=True),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("actor_display_name", sa.String(), nullable=True),
        sa.Column("before_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("snapshot_key", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_elk_walkable_audit_edge",
        "elk_walkable_audit",
        ["edge_key", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_elk_walkable_audit_change",
        "elk_walkable_audit",
        ["change_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_elk_walkable_audit_actor",
        "elk_walkable_audit",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_elk_walkable_audit_created",
        "elk_walkable_audit",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_elk_walkable_audit_action",
        "elk_walkable_audit",
        ["action", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE elk_walkable_audit ENABLE ROW LEVEL SECURITY;")

    op.execute(
        """
        INSERT INTO feature_flags (key, enabled) VALUES
            ('elk_walkable_contributions', FALSE),
            ('elk_walkable_daily_cap', TRUE)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM feature_flags WHERE key IN "
        "('elk_walkable_contributions', 'elk_walkable_daily_cap')"
    )
    op.execute("DELETE FROM geojson_lock WHERE resource = 'elk_walkable'")
    op.drop_index("idx_elk_walkable_audit_action", table_name="elk_walkable_audit")
    op.drop_index("idx_elk_walkable_audit_created", table_name="elk_walkable_audit")
    op.drop_index("idx_elk_walkable_audit_actor", table_name="elk_walkable_audit")
    op.drop_index("idx_elk_walkable_audit_change", table_name="elk_walkable_audit")
    op.drop_index("idx_elk_walkable_audit_edge", table_name="elk_walkable_audit")
    op.drop_table("elk_walkable_audit")
