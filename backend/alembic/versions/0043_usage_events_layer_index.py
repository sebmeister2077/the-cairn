"""usage_events: partial expression index on metadata->>'layer'

Revision ID: 0043_usage_events_layer_index
Revises: 0042_trader_claim_empty
Create Date: 2026-09-17

Speeds up the admin Usage "Map Layers" section, which aggregates
``layer.*`` events (category ``map_layer``) grouped by the advanced-overlay
id stored in ``metadata->>'layer'``. The index is partial so it only covers
map-layer change-event rows and stays cheap to maintain. Snapshot rows carry
no top-level ``layer`` key so they are naturally excluded.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0043_usage_events_layer_index"
down_revision: Union[str, None] = "0042_trader_claim_empty"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """CREATE INDEX IF NOT EXISTS idx_usage_events_layer
               ON usage_events ((metadata->>'layer'))
            WHERE category = 'map_layer'"""
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_usage_events_layer")
