"""orders marketplace: per-crate / per-stack pricing

Revision ID: 0031_orders_sell_unit
Revises: 0030_orders_marketplace
Create Date: 2026-07-06

Lets a seller price and stock an order by ``unit`` / ``stack`` / ``crate``
instead of only by individual item. The order's ``unit_price`` and ``quantity``
are stored in terms of the chosen ``sell_unit`` (so a "12 gears per crate"
order stores ``unit_price = 12``); ``stack_size`` records the item's stack size
at post time so the UI can also show the individual-unit total (a crate holds a
fixed 20 stacks). Legacy rows default to ``sell_unit = 'unit'`` /
``stack_size = NULL`` — i.e. unchanged per-item behaviour.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0031_orders_sell_unit"
down_revision: Union[str, None] = "0030_orders_marketplace"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "orders",
        sa.Column(
            "sell_unit",
            sa.String(),
            nullable=False,
            server_default="unit",
        ),
    )
    op.add_column(
        "orders",
        sa.Column("stack_size", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("orders", "stack_size")
    op.drop_column("orders", "sell_unit")
