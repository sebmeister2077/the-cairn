"""planned_routes table for route-planner usage analytics

Revision ID: 0048_planned_routes
Revises: 0047_map_features_traders_audit
Create Date: 2026-10-05

Captures *every* completed route-planner computation (not just the ones a
user explicitly "saves for road workers" — that is ``saved_routes``). One
row per distinct (identity, route_signature) within a 24h soft-dedup
window; repeats bump ``plan_count`` + ``last_planned_at``.

Beyond the geometry mirrored from ``saved_routes`` this table records the
analytics the admin "Route Planner" audit page surfaces:
  * ``mode``          — 'route' | 'rendezvous'
  * ``from_source`` / ``to_source`` — how the endpoint was set
    ('map-click' | 'landmark' | 'paste' | 'favorite' | 'url' | null)
  * ``settings``      — JSONB of ONLY the settings that differ from the
    client defaults (walk_speed / tl_penalty_seconds / k_neighbors /
    number_of_routes / elk_friendly_only / rendezvous_objective)
  * ``selected_index``   — rank of the chosen alternative (0 = best)
  * ``num_alternatives`` — how many alternatives were offered

No FK on ``actor_api_key_id`` — matches ``usage_events`` / ``saved_routes``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0048_planned_routes"
down_revision: Union[str, None] = "0047_map_features_traders_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "planned_routes",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_planned_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "plan_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("ip_hash", sa.String(), nullable=True),
        sa.Column("mode", sa.String(length=16), nullable=False, server_default="route"),
        sa.Column("from_x", sa.Integer(), nullable=False),
        sa.Column("from_z", sa.Integer(), nullable=False),
        sa.Column("to_x", sa.Integer(), nullable=False),
        sa.Column("to_z", sa.Integer(), nullable=False),
        sa.Column("from_label", sa.Text(), nullable=True),
        sa.Column("to_label", sa.Text(), nullable=True),
        sa.Column("from_source", sa.String(length=24), nullable=True),
        sa.Column("to_source", sa.String(length=24), nullable=True),
        sa.Column("total_seconds", sa.Float(), nullable=False),
        sa.Column("walk_blocks", sa.Float(), nullable=False),
        sa.Column("tl_hops", sa.Integer(), nullable=False),
        sa.Column("walk_speed", sa.Float(), nullable=True),
        sa.Column("tl_penalty_seconds", sa.Float(), nullable=True),
        sa.Column("k_neighbors", sa.Integer(), nullable=True),
        sa.Column("number_of_routes", sa.Integer(), nullable=True),
        sa.Column("elk_friendly_only", sa.Boolean(), nullable=True),
        sa.Column("settings", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("selected_index", sa.Integer(), nullable=True),
        sa.Column("num_alternatives", sa.Integer(), nullable=True),
        sa.Column("tl_hop_sequence", sa.Text(), nullable=False),
        sa.Column("route_signature", sa.String(length=40), nullable=False),
        sa.Column("legs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("straight_line_blocks", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_planned_routes_signature",
        "planned_routes",
        ["route_signature"],
    )
    op.create_index(
        "idx_planned_routes_created",
        "planned_routes",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_planned_routes_last_planned",
        "planned_routes",
        [sa.text("last_planned_at DESC")],
    )
    op.create_index(
        "idx_planned_routes_actor_created",
        "planned_routes",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_planned_routes_ip_created",
        "planned_routes",
        ["ip_hash", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE planned_routes ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.drop_index("idx_planned_routes_ip_created", table_name="planned_routes")
    op.drop_index("idx_planned_routes_actor_created", table_name="planned_routes")
    op.drop_index("idx_planned_routes_last_planned", table_name="planned_routes")
    op.drop_index("idx_planned_routes_created", table_name="planned_routes")
    op.drop_index("idx_planned_routes_signature", table_name="planned_routes")
    op.drop_table("planned_routes")
