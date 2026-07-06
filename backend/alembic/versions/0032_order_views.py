"""orders marketplace: per-order "seen" tracking for unread indicators

Revision ID: 0032_order_views
Revises: 0031_orders_sell_unit
Create Date: 2026-07-06

Adds ``order_views`` so each trader has a *per-order* last-seen marker instead
of only the single global ``users.orders_last_seen_at``. This lets the UI show
*which* orders have unseen activity (new requests / negotiation replies) rather
than just a global "you have news" dot — for both the order owner and the
visitors party to a negotiation. The global marker is still used as the initial
fallback threshold so existing "seen" state isn't lost on rollout.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0032_order_views"
down_revision: Union[str, None] = "0031_orders_sell_unit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "order_views",
        sa.Column("api_key_id", sa.String(), nullable=False),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("api_key_id", "order_id"),
    )
    op.create_index("idx_order_views_key", "order_views", ["api_key_id"])


def downgrade() -> None:
    op.drop_index("idx_order_views_key", table_name="order_views")
    op.drop_table("order_views")
