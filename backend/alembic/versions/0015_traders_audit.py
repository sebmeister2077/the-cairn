"""traders_audit table + Traders feature flags

Revision ID: 0015_traders_audit
Revises: 0014_landmark_additions_flag
Create Date: 2026-05-18

Backs the user-contributed Traders feature. Mirrors ``translocators_audit``:
the geojson file in R2 (``traders.geojson``) is the source of truth for
what's rendered; this table holds the audit trail (add / edit / delete /
revert) and submission metadata. See ``app/db/models/traders.py``.

Also seeds the four Traders feature flags (all default OFF):
    traders_viewer
    traders_chatlog_contributions
    traders_manual_contributions
    per_traders_revert
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0015_traders_audit"
down_revision: Union[str, None] = "0014_landmark_additions_flag"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TRADER_FLAGS = (
    "traders_viewer",
    "traders_chatlog_contributions",
    "traders_manual_contributions",
    "per_traders_revert",
)


def upgrade() -> None:
    op.create_table(
        "traders_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("trader_id", sa.String(), nullable=False),
        # 'add' | 'edit' | 'delete' | 'revert' | 'admin_delete' | 'admin_edit'
        sa.Column("action", sa.String(), nullable=False),
        # 'chatlog' | 'manual' | 'admin' — populated for 'add' rows.
        sa.Column("source", sa.String(), nullable=True),
        sa.Column("trader_type", sa.String(), nullable=True),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("actor_display_name", sa.String(), nullable=True),
        sa.Column("before_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("submission_stats", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("duplicate_flagged", sa.Boolean(), nullable=False, server_default=sa.text("FALSE")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_traders_audit_trader",
        "traders_audit",
        ["trader_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_traders_audit_actor",
        "traders_audit",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_traders_audit_created",
        "traders_audit",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_traders_audit_action",
        "traders_audit",
        ["action", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_traders_audit_type",
        "traders_audit",
        ["trader_type", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_traders_audit_duplicate",
        "traders_audit",
        ["duplicate_flagged", sa.text("created_at DESC")],
        postgresql_where=sa.text("duplicate_flagged = TRUE"),
    )
    op.execute("ALTER TABLE traders_audit ENABLE ROW LEVEL SECURITY;")

    # Seed feature flag rows so they appear in the admin UI even before the
    # app's idempotent CREATE_TABLES_SQL runs them on next boot.
    for flag in _TRADER_FLAGS:
        op.execute(
            sa.text(
                "INSERT INTO feature_flags (key, enabled) VALUES (:k, FALSE) "
                "ON CONFLICT (key) DO NOTHING"
            ).bindparams(k=flag)
        )


def downgrade() -> None:
    for flag in _TRADER_FLAGS:
        op.execute(
            sa.text("DELETE FROM feature_flags WHERE key = :k").bindparams(k=flag)
        )
    op.drop_index("idx_traders_audit_duplicate", table_name="traders_audit")
    op.drop_index("idx_traders_audit_type", table_name="traders_audit")
    op.drop_index("idx_traders_audit_action", table_name="traders_audit")
    op.drop_index("idx_traders_audit_created", table_name="traders_audit")
    op.drop_index("idx_traders_audit_actor", table_name="traders_audit")
    op.drop_index("idx_traders_audit_trader", table_name="traders_audit")
    op.drop_table("traders_audit")
