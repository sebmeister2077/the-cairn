"""usage_events analytics fact table

Revision ID: 0016_usage_events
Revises: 0015_traders_audit
Create Date: 2026-05-20

Adds a denormalised analytics fact table that the admin "Usage" dashboard
queries to render time-series, heatmaps, and per-category counts.

Design notes:
  * One row per user-visible action (contribution submit, landmark add,
    admin ban, backup redeem, ...). Rows are append-only; recorder writes
    are best-effort and must never block the originating request.
  * ``actor_api_key_id`` is intentionally NOT a foreign key — matches the
    existing audit-table conventions in this codebase and avoids cascading
    on admin rekey (see /memories/repo/project-notes.md).
  * ``category`` is a coarse bucket (``contribution`` | ``admin`` |
    ``moderation`` | ``download`` | ``auth`` | ``system``) used for the
    overview chart's stacking. ``event_type`` is the fine-grained label.
  * ``metadata`` is a small JSONB payload (target id, duration_ms, etc.).
    Keep it tiny — this table is sized for many rows.
  * ``ip_hash`` is the HMAC-SHA256 digest produced by ``app.auth._hash_ip``
    when callers choose to record it. Raw IPs are never stored.

Retention: no automatic prune in this migration. A future revision can add
a nightly sweep (suggested >180 days) once a real volume signal exists.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0016_usage_events"
down_revision: Union[str, None] = "0015_traders_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "usage_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("category", sa.String(), nullable=False),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("ip_hash", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_usage_events_created",
        "usage_events",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_usage_events_type_created",
        "usage_events",
        ["event_type", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_usage_events_category_created",
        "usage_events",
        ["category", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_usage_events_actor_created",
        "usage_events",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.drop_index("idx_usage_events_actor_created", table_name="usage_events")
    op.drop_index("idx_usage_events_category_created", table_name="usage_events")
    op.drop_index("idx_usage_events_type_created", table_name="usage_events")
    op.drop_index("idx_usage_events_created", table_name="usage_events")
    op.drop_table("usage_events")
