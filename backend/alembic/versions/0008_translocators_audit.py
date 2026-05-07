"""translocators_audit table

Revision ID: 0008_translocators_audit
Revises: 0007_landmarks_tables
Create Date: 2026-05-07

Backs the user-contributed translocators feature. The geojson file in R2
remains the single source of truth for what's rendered; this table holds
the audit trail (add + admin delete) and the user-supplied submission
stats. See ``app/db/models/translocators.py`` for documentation.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0008_translocators_audit"
down_revision: Union[str, None] = "0007_landmarks_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "translocators_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("segment_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("actor_display_name", sa.String(), nullable=True),
        sa.Column("before_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("submission_stats", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_translocators_audit_segment",
        "translocators_audit",
        ["segment_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_translocators_audit_actor",
        "translocators_audit",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_translocators_audit_created",
        "translocators_audit",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_translocators_audit_action",
        "translocators_audit",
        ["action", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE translocators_audit ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.drop_index("idx_translocators_audit_action", table_name="translocators_audit")
    op.drop_index("idx_translocators_audit_created", table_name="translocators_audit")
    op.drop_index("idx_translocators_audit_actor", table_name="translocators_audit")
    op.drop_index("idx_translocators_audit_segment", table_name="translocators_audit")
    op.drop_table("translocators_audit")
