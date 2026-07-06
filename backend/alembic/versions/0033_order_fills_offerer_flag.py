"""order_fills: link to negotiation, offerer identity, and flaggable trades

Revision ID: 0033_order_fills_offerer_flag
Revises: 0032_order_views
Create Date: 2026-07-06

Reworks how trades are recorded for the community Orders marketplace. Instead of
the order owner manually logging a fill (and thus being able to invent a sale
price), a trade is now recorded automatically when a negotiation is accepted.
The recorded price is the latest agreed offer/counter and the trade is attributed
to the *offerer* (the requester), whose public name is shown to everyone so the
counterparty can be asked to verify the price.

New ``order_fills`` columns:
  * ``request_id`` — the negotiation thread that produced the trade (nullable so
    legacy owner-logged fills keep working; FK ``ON DELETE SET NULL``).
  * ``counterparty_api_key_id`` — the offerer's ``api_keys.id`` (stored as text,
    no FK, matching the marketplace convention). Used to resolve the public name
    and to authorize flagging.
  * ``flagged`` / ``flagged_at`` — the offerer may flag their own trade as false
    (e.g. the owner accepted at a price that differs from the real in-game deal).
    Flagged trades are excluded from the price analytics aggregate but stay
    visible in the trade list with a "Flagged" marker.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0033_order_fills_offerer_flag"
down_revision: Union[str, None] = "0032_order_views"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "order_fills",
        sa.Column("request_id", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "order_fills",
        sa.Column("counterparty_api_key_id", sa.String(), nullable=True),
    )
    op.add_column(
        "order_fills",
        sa.Column(
            "flagged",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "order_fills",
        sa.Column("flagged_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_order_fills_request",
        "order_fills",
        "order_requests",
        ["request_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "idx_order_fills_counterparty",
        "order_fills",
        ["counterparty_api_key_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_order_fills_counterparty", table_name="order_fills")
    op.drop_constraint("fk_order_fills_request", "order_fills", type_="foreignkey")
    op.drop_column("order_fills", "flagged_at")
    op.drop_column("order_fills", "flagged")
    op.drop_column("order_fills", "counterparty_api_key_id")
    op.drop_column("order_fills", "request_id")
