"""page_entity_labels: human names for viewed market entities

Revision ID: 0034_page_entity_labels
Revises: 0033_order_fills_offerer_flag
Create Date: 2026-07-27

Backs the admin Usage "Items & Players" tab, which surfaces the most-viewed
market item and player-profile pages.

Design:
  * ``page.view`` events now carry an optional ``metadata->>'ref'`` — the raw
    item id / player uid that the route normalizer would otherwise strip. That
    is enough to *count* views per entity, but a bare numeric id / opaque uid
    is not human-readable.
  * This table maps ``(path_template, ref) -> label`` (e.g.
    ``('/market/players/:uid', 'abc123', 'SomePlayer')``). It is populated
    opportunistically by the item/player pages once they know a display name,
    so counting a view never depends on the label being known yet (and the two
    concerns can't double-count each other).
  * Bounded cardinality: at most one row per distinct entity ever labelled.

Also adds a partial expression index on ``usage_events(metadata->>'ref')`` so
the per-entity aggregation stays cheap, mirroring the existing
``idx_usage_events_page_path`` from 0020.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0034_page_entity_labels"
down_revision: Union[str, None] = "0033_order_fills_offerer_flag"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "page_entity_labels",
        sa.Column("path", sa.String(length=128), nullable=False),
        sa.Column("ref", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("path", "ref"),
    )
    op.execute(
        """CREATE INDEX IF NOT EXISTS idx_usage_events_page_ref
               ON usage_events ((metadata->>'ref'))
            WHERE event_type = 'page.view' AND metadata ? 'ref'"""
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_usage_events_page_ref")
    op.drop_table("page_entity_labels")
