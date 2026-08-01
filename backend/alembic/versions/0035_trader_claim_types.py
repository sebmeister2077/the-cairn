"""trader_claim_types_audit table + trader-claim feature flags

Revision ID: 0035_trader_claim_types
Revises: 0034_page_entity_labels
Create Date: 2026-08-01

Backs the trader-*claim* type overlay. The claim boxes ship as a static
frontend asset (``map-features.traderclaims.json``) with no trader type; the
live merged type assignments live in the R2 object ``trader_claim_types.json``
and this table is the append-only audit trail. See
``app/db/models/traders.py::TraderClaimTypesAudit``.

Also seeds the trader-claim feature flags (all default OFF):
    trader_claims_viewer            -- public overlay download gate
    trader_claims_manual            -- allow logged-in manual type marking
    trader_claims_authoritative     -- allow proxy authoritative submissions
    trader_claims_manual_daily_cap  -- numeric per-user manual cap (value_int)
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0035_trader_claim_types"
down_revision: Union[str, None] = "0034_page_entity_labels"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_CLAIM_FLAGS = (
    "trader_claims_viewer",
    "trader_claims_manual",
    "trader_claims_authoritative",
    "trader_claims_manual_daily_cap",
)


def upgrade() -> None:
    op.create_table(
        "trader_claim_types_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("claim_id", sa.String(), nullable=False),
        # 'add' | 'edit' | 'delete' | 'admin_delete' | 'admin_edit'
        sa.Column("action", sa.String(), nullable=False),
        # 'authoritative' (proxy) | 'manual' (user)
        sa.Column("source", sa.String(), nullable=True),
        sa.Column("trader_type", sa.String(), nullable=True),
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
        "idx_trader_claim_types_claim",
        "trader_claim_types_audit",
        ["claim_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_trader_claim_types_actor",
        "trader_claim_types_audit",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_trader_claim_types_created",
        "trader_claim_types_audit",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_trader_claim_types_type",
        "trader_claim_types_audit",
        ["trader_type", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_trader_claim_types_source",
        "trader_claim_types_audit",
        ["source", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE trader_claim_types_audit ENABLE ROW LEVEL SECURITY;")

    for flag in _CLAIM_FLAGS:
        op.execute(
            sa.text(
                "INSERT INTO feature_flags (key, enabled) VALUES (:k, FALSE) "
                "ON CONFLICT (key) DO NOTHING"
            ).bindparams(k=flag)
        )


def downgrade() -> None:
    for flag in _CLAIM_FLAGS:
        op.execute(
            sa.text("DELETE FROM feature_flags WHERE key = :k").bindparams(k=flag)
        )
    op.drop_index("idx_trader_claim_types_source", table_name="trader_claim_types_audit")
    op.drop_index("idx_trader_claim_types_type", table_name="trader_claim_types_audit")
    op.drop_index("idx_trader_claim_types_created", table_name="trader_claim_types_audit")
    op.drop_index("idx_trader_claim_types_actor", table_name="trader_claim_types_audit")
    op.drop_index("idx_trader_claim_types_claim", table_name="trader_claim_types_audit")
    op.drop_table("trader_claim_types_audit")
