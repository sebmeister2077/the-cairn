"""landmarks audit + edit-request tables

Revision ID: 0007_landmarks_tables
Revises: 0006_dualwrite_triggers
Create Date: 2026-05-06

First model-driven revision in this project: tables are defined in
``app/db/models/landmarks.py`` and the operations below mirror what
``alembic revision --autogenerate`` would emit. From now on, prefer
adding a model + running autogenerate over hand-writing DDL strings.

Backs the user-editable landmarks/translocators feature: the geojson
file in R2 is the single source of truth for what's rendered, while
these tables hold the audit trail and the pending-rename approval
queue. See ``app/db/models/landmarks.py`` for the field-by-field
documentation.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0007_landmarks_tables"
down_revision: Union[str, None] = "0006_dualwrite_triggers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "landmarks_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("landmark_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
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
        "idx_landmarks_audit_landmark",
        "landmarks_audit",
        ["landmark_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_landmarks_audit_actor",
        "landmarks_audit",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_landmarks_audit_created",
        "landmarks_audit",
        [sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE landmarks_audit ENABLE ROW LEVEL SECURITY;")

    op.create_table(
        "landmark_edit_requests",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("landmark_id", sa.String(), nullable=False),
        sa.Column("submitted_by_api_key_id", sa.String(), nullable=False),
        sa.Column("submitted_by_display_name", sa.String(), nullable=False),
        sa.Column("current_label", sa.String(), nullable=False),
        sa.Column("proposed_label", sa.String(), nullable=False),
        sa.Column(
            "status",
            sa.String(),
            server_default=sa.text("'pending'"),
            nullable=False,
        ),
        sa.Column("reviewed_by_api_key_id", sa.String(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_note", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_landmark_edit_requests_status",
        "landmark_edit_requests",
        ["status", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_landmark_edit_requests_landmark",
        "landmark_edit_requests",
        ["landmark_id"],
    )
    op.create_index(
        "idx_landmark_edit_requests_submitter",
        "landmark_edit_requests",
        ["submitted_by_api_key_id", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE landmark_edit_requests ENABLE ROW LEVEL SECURITY;")

def downgrade() -> None:
    op.drop_index("idx_landmark_edit_requests_submitter", table_name="landmark_edit_requests")
    op.drop_index("idx_landmark_edit_requests_landmark", table_name="landmark_edit_requests")
    op.drop_index("idx_landmark_edit_requests_status", table_name="landmark_edit_requests")
    op.drop_table("landmark_edit_requests")

    op.drop_index("idx_landmarks_audit_created", table_name="landmarks_audit")
    op.drop_index("idx_landmarks_audit_actor", table_name="landmarks_audit")
    op.drop_index("idx_landmarks_audit_landmark", table_name="landmarks_audit")
    op.drop_table("landmarks_audit")
