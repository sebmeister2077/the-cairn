"""elk_walkable_reports table + feature flag

Revision ID: 0027_elk_walkable_reports
Revises: 0026_grouping_library_dedup
Create Date: 2026-06-25

Adds a moderation queue for users to flag confirmed elk-walkable edges
as wrongly attested. Mirrors the ``shared_grouping_reports`` pattern
from the grouping library (post-moderation).

The ``edge_key`` column is *not* a foreign key — the source of truth
for the live attestation set is ``elk_walkable.json`` in R2, and an
edge may briefly disappear/reappear from there while a report is open.
We also denormalise ``reporter_display_name`` so the admin queue stays
readable after the reporter rotates their api key.

Also seeds the ``elk_walkable_reports_enabled`` flag (default TRUE)
so an admin can disable the feature without redeploying if it gets
abused.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0027_elk_walkable_reports"
down_revision: Union[str, None] = "0026_grouping_library_dedup"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "elk_walkable_reports",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("edge_key", sa.String(), nullable=False),
        sa.Column("reporter_api_key_id", sa.String(), nullable=True),
        sa.Column("reporter_display_name", sa.String(), nullable=True),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("details", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.String(),
            nullable=False,
            server_default=sa.text("'open'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by_api_key_id", sa.String(), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_elk_walkable_reports_open",
        "elk_walkable_reports",
        [sa.text("created_at DESC")],
        postgresql_where=sa.text("status = 'open'"),
    )
    op.create_index(
        "idx_elk_walkable_reports_status_created",
        "elk_walkable_reports",
        ["status", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_elk_walkable_reports_edge",
        "elk_walkable_reports",
        ["edge_key", "status"],
    )
    op.create_index(
        "idx_elk_walkable_reports_reporter",
        "elk_walkable_reports",
        ["reporter_api_key_id", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE elk_walkable_reports ENABLE ROW LEVEL SECURITY;")

    op.execute(
        """
        INSERT INTO feature_flags (key, enabled) VALUES
            ('elk_walkable_reports_enabled', TRUE)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM feature_flags WHERE key = 'elk_walkable_reports_enabled'"
    )
    op.drop_index(
        "idx_elk_walkable_reports_reporter", table_name="elk_walkable_reports"
    )
    op.drop_index(
        "idx_elk_walkable_reports_edge", table_name="elk_walkable_reports"
    )
    op.drop_index(
        "idx_elk_walkable_reports_status_created",
        table_name="elk_walkable_reports",
    )
    op.drop_index(
        "idx_elk_walkable_reports_open", table_name="elk_walkable_reports"
    )
    op.drop_table("elk_walkable_reports")
