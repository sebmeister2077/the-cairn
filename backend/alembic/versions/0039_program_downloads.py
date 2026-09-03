"""program distribution: uploaded builds + shareable download links

Revision ID: 0039_program_downloads
Revises: 0038_activation_parameters
Create Date: 2026-09-03

Backs the admin "program download links" feature. An admin uploads a VSProxy
build (``program_builds``, one row per upload, exactly one flagged current) and
mints per-recipient links (``program_download_links``). Each link references a
freshly issued license + API key (with the ``map_features_publish`` permission)
so the downloaded zip can ship ``license.key`` + ``publish.key`` next to the
exe. ``program_download_log`` records every redemption for the admin view.

See ``app/routes/admin_program.py`` and ``app/routes/public_program_download.py``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0039_program_downloads"
down_revision: Union[str, None] = "0038_activation_parameters"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "program_builds",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("r2_key", sa.Text(), nullable=False),
        sa.Column("original_filename", sa.Text(), nullable=True),
        sa.Column("version_label", sa.Text(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("sha256", sa.Text(), nullable=True),
        sa.Column("uploaded_by_key_id", sa.Text(), nullable=True),
        sa.Column(
            "uploaded_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "is_current",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    # At most one build may be the current one at a time.
    op.create_index(
        "idx_program_builds_current",
        "program_builds",
        ["is_current"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )

    op.create_table(
        "program_download_links",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("token", sa.Text(), nullable=False, unique=True),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("license_code", sa.Text(), nullable=False),
        sa.Column("api_key", sa.Text(), nullable=False),
        sa.Column("build_id", sa.BigInteger(), nullable=True),
        sa.Column("max_activations", sa.Integer(), nullable=False, server_default=sa.text("2")),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by_key_id", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("revoked_by_key_id", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["license_code"], ["licenses.license_code"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["build_id"], ["program_builds.id"], ondelete="SET NULL"
        ),
    )
    op.create_index(
        "idx_program_download_links_token",
        "program_download_links",
        ["token"],
        unique=False,
    )
    op.create_index(
        "idx_program_download_links_active",
        "program_download_links",
        ["expires_at"],
        unique=False,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    op.create_table(
        "program_download_log",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("link_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "redeemed_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("ip_hash", sa.Text(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["link_id"], ["program_download_links.id"], ondelete="CASCADE"
        ),
    )
    op.create_index(
        "idx_program_download_log_link",
        "program_download_log",
        ["link_id", "redeemed_at"],
        unique=False,
    )

    op.execute("ALTER TABLE program_builds ENABLE ROW LEVEL SECURITY;")
    op.execute("ALTER TABLE program_download_links ENABLE ROW LEVEL SECURITY;")
    op.execute("ALTER TABLE program_download_log ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.drop_index("idx_program_download_log_link", table_name="program_download_log")
    op.drop_table("program_download_log")
    op.drop_index(
        "idx_program_download_links_active", table_name="program_download_links"
    )
    op.drop_index(
        "idx_program_download_links_token", table_name="program_download_links"
    )
    op.drop_table("program_download_links")
    op.drop_index("idx_program_builds_current", table_name="program_builds")
    op.drop_table("program_builds")
