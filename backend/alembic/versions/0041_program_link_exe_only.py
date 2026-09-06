"""program download links: optional exe-only (update) links

Revision ID: 0041_program_link_exe_only
Revises: 0040_license_over_limit_attempts
Create Date: 2026-09-06

Adds ``include_keys`` to ``program_download_links``. When false the link is an
"update only" link: the downloaded zip ships just the exe, with no per-recipient
``license.key`` / ``publish.key``. Such links don't mint a license or API key, so
``license_code`` and ``api_key`` become nullable. See
``app/routes/admin_program.py`` and ``app/routes/public_program_download.py``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0041_program_link_exe_only"
down_revision: Union[str, None] = "0040_license_over_limit_attempts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "program_download_links",
        sa.Column(
            "include_keys",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    op.alter_column("program_download_links", "license_code", nullable=True)
    op.alter_column("program_download_links", "api_key", nullable=True)


def downgrade() -> None:
    # Exe-only links have NULL license/api_key; clear them so the NOT NULL
    # restore can't fail. They can't ship keys anyway.
    op.execute("DELETE FROM program_download_links WHERE include_keys = false")
    op.alter_column("program_download_links", "api_key", nullable=False)
    op.alter_column("program_download_links", "license_code", nullable=False)
    op.drop_column("program_download_links", "include_keys")
