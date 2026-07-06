"""orders marketplace: community buy/sell orders + requests + negotiation + fills

Revision ID: 0030_orders_marketplace
Revises: 0029_grouping_library_edit_cap
Create Date: 2026-07-06

Backs the community "Orders" marketplace (Market > Orders) — a live, account-
gated market that is 100% independent of the static Auction House capture data.
Account holders post Buy or Sell orders for catalog items; anyone can browse.
Buyers/sellers send structured requests (qty + optional proposed price + note)
and negotiate via counter-offers; after a trade the order owner logs a fill
(stock reduced + optional price + publish-for-analytics flag).

Design:
  * ``orders`` holds one row per listing. ``location`` JSONB carries
    ``{source, x, z, label?, landmark_id?}`` where ``source`` is one of
    ``manual`` / ``landmark`` / ``favorite``. ``mobility`` is one of
    ``stationary`` / ``occasional`` / ``frequent``. ``item_name`` is a
    snapshot of the catalog name at post time (so a later catalog change
    doesn't silently rewrite listings). Denormalised ``quantity_remaining``
    is maintained by the fill helper.
  * ``order_requests`` is the head of a negotiation thread — one row per
    buy/sell request against an order.
  * ``order_negotiation_messages`` is the append-only thread of turns
    (offer / counter / message / accept / reject), each optionally carrying
    a proposed qty + price.
  * ``order_fills`` records post-trade stock reductions with an optional
    published price for the order-local price analytics.
  * Identity columns store the ``api_keys.id`` UUID as text (no FK so a rekey
    never orphans a row; display names are resolved live via a JOIN on
    ``users.api_key_id``), matching the grouping-library / saved-routes
    convention (see /memories/repo/project-notes.md).

Also extends ``users`` with a per-trader profile default (location + mobility)
plus an ``orders_last_seen_at`` marker used to compute the unread "dot" on the
Orders nav button, and seeds the ``orders_enabled`` feature flag (default FALSE
so the whole feature is invisible until switched on).
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0030_orders_marketplace"
down_revision: Union[str, None] = "0029_grouping_library_edit_cap"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- users: per-trader profile default + unread marker ----------------
    op.add_column(
        "users",
        sa.Column("orders_last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "orders_default_location",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.add_column(
        "users",
        sa.Column("orders_default_mobility", sa.String(), nullable=True),
    )

    # --- orders (one row per listing) -------------------------------------
    op.create_table(
        "orders",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("author_api_key_id", sa.String(), nullable=True),
        sa.Column("side", sa.String(), nullable=False),
        sa.Column("item_id", sa.Integer(), nullable=False),
        sa.Column("item_name", sa.Text(), nullable=False),
        sa.Column("preview_text", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("unit_price", sa.Numeric(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("quantity_remaining", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.String(),
            nullable=False,
            server_default=sa.text("'open'"),
        ),
        sa.Column("location", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("mobility", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_orders_status_created",
        "orders",
        ["status", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_orders_side_status",
        "orders",
        ["side", "status"],
    )
    op.create_index("idx_orders_item", "orders", ["item_id"])
    op.create_index(
        "idx_orders_author",
        "orders",
        ["author_api_key_id", sa.text("created_at DESC")],
    )
    # Trigram index for case-insensitive item-name search (pg_trgm enabled by
    # the accounts migration that added the users display_name trgm index).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_orders_item_name_trgm "
        "ON orders USING gin (item_name gin_trgm_ops)"
    )
    op.execute("ALTER TABLE orders ENABLE ROW LEVEL SECURITY;")

    # --- order_requests (negotiation thread head) -------------------------
    op.create_table(
        "order_requests",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("requester_api_key_id", sa.String(), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("proposed_unit_price", sa.Numeric(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.String(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_order_requests_order",
        "order_requests",
        ["order_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_order_requests_requester",
        "order_requests",
        ["requester_api_key_id", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE order_requests ENABLE ROW LEVEL SECURITY;")

    # --- order_negotiation_messages (append-only thread) ------------------
    op.create_table(
        "order_negotiation_messages",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("request_id", sa.BigInteger(), nullable=False),
        sa.Column("author_api_key_id", sa.String(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("proposed_quantity", sa.Integer(), nullable=True),
        sa.Column("proposed_unit_price", sa.Numeric(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["request_id"], ["order_requests.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_order_messages_request",
        "order_negotiation_messages",
        ["request_id", "created_at"],
    )
    op.execute(
        "ALTER TABLE order_negotiation_messages ENABLE ROW LEVEL SECURITY;"
    )

    # --- order_fills (post-trade stock reductions) ------------------------
    op.create_table(
        "order_fills",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("reporter_api_key_id", sa.String(), nullable=True),
        sa.Column("quantity_reduced", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("unit_price", sa.Numeric(), nullable=True),
        sa.Column(
            "publish_analytics",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_order_fills_order",
        "order_fills",
        ["order_id", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE order_fills ENABLE ROW LEVEL SECURITY;")

    # --- feature flag -----------------------------------------------------
    op.execute(
        """
        INSERT INTO feature_flags (key, enabled) VALUES
            ('orders_enabled', FALSE)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM feature_flags WHERE key = 'orders_enabled'")
    op.drop_index("idx_order_fills_order", table_name="order_fills")
    op.drop_table("order_fills")
    op.drop_index(
        "idx_order_messages_request", table_name="order_negotiation_messages"
    )
    op.drop_table("order_negotiation_messages")
    op.drop_index("idx_order_requests_requester", table_name="order_requests")
    op.drop_index("idx_order_requests_order", table_name="order_requests")
    op.drop_table("order_requests")
    op.execute("DROP INDEX IF EXISTS idx_orders_item_name_trgm")
    op.drop_index("idx_orders_author", table_name="orders")
    op.drop_index("idx_orders_item", table_name="orders")
    op.drop_index("idx_orders_side_status", table_name="orders")
    op.drop_index("idx_orders_status_created", table_name="orders")
    op.drop_table("orders")
    op.drop_column("users", "orders_default_mobility")
    op.drop_column("users", "orders_default_location")
    op.drop_column("users", "orders_last_seen_at")
