"""trader_claim_empty_audit table + no-trader-claim feature flags

Revision ID: 0042_trader_claim_empty
Revises: 0041_program_link_exe_only
Create Date: 2026-09-14

Backs the "no-trader claims" overlay: trader-*claim* boxes that are known to
have NO actual trader inside (leftovers from beta worldgen where a claim was
placed but its trader never persisted). The claim boxes ship as a static
frontend asset (``map-features.traderclaims.json``); the live set of empty
claims lives in the R2 object ``trader_claim_empty.json`` and this table is
the append-only audit trail. Structurally a twin of
``trader_claim_types_audit`` (see ``0035_trader_claim_types``), minus
``trader_type`` since an empty claim has no type. See
``app/db/models/traders.py::TraderClaimEmptyAudit``.

Also seeds the no-trader-claim feature flags (all default OFF):
    trader_claim_empty_viewer            -- public overlay download gate
    trader_claim_empty_manual            -- allow logged-in manual marking
    trader_claim_empty_authoritative     -- allow proxy authoritative submissions
    trader_claim_empty_manual_daily_cap  -- numeric per-user manual cap (value_int)
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0042_trader_claim_empty"
down_revision: Union[str, None] = "0041_program_link_exe_only"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_EMPTY_FLAGS = (
    "trader_claim_empty_viewer",
    "trader_claim_empty_manual",
    "trader_claim_empty_authoritative",
    "trader_claim_empty_manual_daily_cap",
)


def upgrade() -> None:
    op.create_table(
        "trader_claim_empty_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("claim_id", sa.String(), nullable=False),
        # 'add' (marked empty) | 'remove' (trader found / unmarked) |
        # 'admin_delete' (admin unmark)
        sa.Column("action", sa.String(), nullable=False),
        # 'authoritative' (proxy) | 'manual' (user) | 'admin'
        sa.Column("source", sa.String(), nullable=True),
        sa.Column("center_x", sa.Float(), nullable=True),
        sa.Column("center_y", sa.Float(), nullable=True),
        sa.Column("center_z", sa.Float(), nullable=True),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("actor_display_name", sa.String(), nullable=True),
        sa.Column("before_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_trader_claim_empty_claim",
        "trader_claim_empty_audit",
        ["claim_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_trader_claim_empty_actor",
        "trader_claim_empty_audit",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_trader_claim_empty_created",
        "trader_claim_empty_audit",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_trader_claim_empty_action",
        "trader_claim_empty_audit",
        ["action", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_trader_claim_empty_source",
        "trader_claim_empty_audit",
        ["source", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE trader_claim_empty_audit ENABLE ROW LEVEL SECURITY;")

    for flag in _EMPTY_FLAGS:
        op.execute(
            sa.text(
                "INSERT INTO feature_flags (key, enabled) VALUES (:k, FALSE) "
                "ON CONFLICT (key) DO NOTHING"
            ).bindparams(k=flag)
        )


def downgrade() -> None:
    for flag in _EMPTY_FLAGS:
        op.execute(
            sa.text("DELETE FROM feature_flags WHERE key = :k").bindparams(k=flag)
        )
    op.drop_index("idx_trader_claim_empty_source", table_name="trader_claim_empty_audit")
    op.drop_index("idx_trader_claim_empty_action", table_name="trader_claim_empty_audit")
    op.drop_index("idx_trader_claim_empty_created", table_name="trader_claim_empty_audit")
    op.drop_index("idx_trader_claim_empty_actor", table_name="trader_claim_empty_audit")
    op.drop_index("idx_trader_claim_empty_claim", table_name="trader_claim_empty_audit")
    op.drop_table("trader_claim_empty_audit")
