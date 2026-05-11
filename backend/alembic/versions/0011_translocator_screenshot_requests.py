"""translocator_screenshot_requests table

Revision ID: 0011_tl_screenshot_requests
Revises: 0010_api_key_fk_migration
Create Date: 2026-05-11

Backs the screenshot-based TL contribution flow. Users submit two
screenshots showing the coordinate HUD + minimap; backend OCRs and
matches against the level-5 TOPS cache; admin reviews validations as
**warnings** and approves into the existing translocators.geojson
plumbing. Screenshots are deleted on approve/reject; only OCR'd coords
+ audit row survive.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0011_tl_screenshot_requests"
down_revision: Union[str, None] = "0010_api_key_fk_migration"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "translocator_screenshot_requests",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column(
            "status",
            sa.String(),
            server_default=sa.text("'pending'"),
            nullable=False,
        ),
        sa.Column("submitter_api_key_id", sa.String(), nullable=True),
        sa.Column("submitter_display_name", sa.String(), nullable=True),
        sa.Column("screenshot_a_key", sa.String(), nullable=True),
        sa.Column("screenshot_b_key", sa.String(), nullable=True),
        sa.Column("minimap_crop_a_key", sa.String(), nullable=True),
        sa.Column("minimap_crop_b_key", sa.String(), nullable=True),
        sa.Column("screenshot_a_taken_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("screenshot_b_taken_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ocr_a", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("ocr_b", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("coords_a", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("coords_b", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column(
            "analysis_status",
            sa.String(),
            server_default=sa.text("'queued'"),
            nullable=False,
        ),
        sa.Column("analysis_error", sa.String(), nullable=True),
        sa.Column(
            "validation_warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "minimap_match",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("decision_actor_api_key_id", sa.String(), nullable=True),
        sa.Column("decision_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_reason", sa.String(), nullable=True),
        sa.Column("resulting_segment_id", sa.String(), nullable=True),
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
        "idx_tl_ssr_status_created",
        "translocator_screenshot_requests",
        ["status", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_tl_ssr_submitter_created",
        "translocator_screenshot_requests",
        ["submitter_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_tl_ssr_analysis_status",
        "translocator_screenshot_requests",
        ["analysis_status"],
    )
    op.execute(
        "ALTER TABLE translocator_screenshot_requests ENABLE ROW LEVEL SECURITY;"
    )


def downgrade() -> None:
    op.drop_index(
        "idx_tl_ssr_analysis_status",
        table_name="translocator_screenshot_requests",
    )
    op.drop_index(
        "idx_tl_ssr_submitter_created",
        table_name="translocator_screenshot_requests",
    )
    op.drop_index(
        "idx_tl_ssr_status_created",
        table_name="translocator_screenshot_requests",
    )
    op.drop_table("translocator_screenshot_requests")
