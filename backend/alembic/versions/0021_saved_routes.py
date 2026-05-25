"""saved_routes table for the route planner analytics feature

Revision ID: 0021_saved_routes
Revises: 0020_usage_page_path
Create Date: 2026-05-25

Stores user-submitted route-planner results so admins (and a public,
unlisted page) can surface high-demand routes / translocator edges to
road-worker contributors.

Design:
  * One row per *distinct* (actor_or_ip_hash, route_signature) within a
    24h soft-dedup window. Within that window, repeated saves bump
    ``save_count`` + ``last_saved_at`` instead of inserting a new row.
  * ``route_signature`` is a sha1 over (quantized_from, quantized_to,
    tl_hop_sequence). Endpoints are quantized to a 32-block grid for the
    signature ONLY so trivial pixel-jitter doesn't fragment dedup; the
    raw exact coords are still stored in ``from_x/z`` + ``to_x/z`` and
    in ``legs`` for fidelity.
  * ``legs`` JSONB carries the full ordered leg list (walk + tl) so the
    public page can render a route preview without recomputing.
  * No FK on ``actor_api_key_id`` — matches the convention from
    ``usage_events`` and the existing audit tables (see
    /memories/repo/project-notes.md).
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0021_saved_routes"
down_revision: Union[str, None] = "0020_usage_page_path"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "saved_routes",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_saved_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "save_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("ip_hash", sa.String(), nullable=True),
        sa.Column("from_x", sa.Integer(), nullable=False),
        sa.Column("from_z", sa.Integer(), nullable=False),
        sa.Column("to_x", sa.Integer(), nullable=False),
        sa.Column("to_z", sa.Integer(), nullable=False),
        sa.Column("from_label", sa.Text(), nullable=True),
        sa.Column("to_label", sa.Text(), nullable=True),
        sa.Column("total_seconds", sa.Float(), nullable=False),
        sa.Column("walk_blocks", sa.Float(), nullable=False),
        sa.Column("tl_hops", sa.Integer(), nullable=False),
        sa.Column("walk_speed", sa.Float(), nullable=True),
        sa.Column("tl_penalty_seconds", sa.Float(), nullable=True),
        sa.Column("k_neighbors", sa.Integer(), nullable=True),
        sa.Column("tl_hop_sequence", sa.Text(), nullable=False),
        sa.Column("route_signature", sa.String(length=40), nullable=False),
        sa.Column("legs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("straight_line_blocks", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_saved_routes_signature",
        "saved_routes",
        ["route_signature"],
    )
    op.create_index(
        "idx_saved_routes_created",
        "saved_routes",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_saved_routes_last_saved",
        "saved_routes",
        [sa.text("last_saved_at DESC")],
    )
    op.create_index(
        "idx_saved_routes_actor_created",
        "saved_routes",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_saved_routes_ip_created",
        "saved_routes",
        ["ip_hash", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE saved_routes ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.drop_index("idx_saved_routes_ip_created", table_name="saved_routes")
    op.drop_index("idx_saved_routes_actor_created", table_name="saved_routes")
    op.drop_index("idx_saved_routes_last_saved", table_name="saved_routes")
    op.drop_index("idx_saved_routes_created", table_name="saved_routes")
    op.drop_index("idx_saved_routes_signature", table_name="saved_routes")
    op.drop_table("saved_routes")
