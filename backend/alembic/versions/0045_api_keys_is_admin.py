"""api_keys.is_admin — DB-backed multiple admins

Revision ID: 0045_api_keys_is_admin
Revises: 0044_program_platform_settings
Create Date: 2026-10-04

Historically "admin" meant exactly one key — the env-var ``ADMIN_API_KEY``.
This adds a per-key ``is_admin`` boolean so additional admins can be promoted
from the admin panel (Phase 4d). The env-var key remains the permanent
bootstrap/super-admin and is marked ``is_admin = TRUE`` on every startup by
``api_key_cache.bootstrap_env_keys``.

Reversible: ``downgrade()`` drops the column.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0045_api_keys_is_admin"
down_revision: Union[str, None] = "0044_program_platform_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "api_keys",
        sa.Column(
            "is_admin",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_index(
        "idx_api_keys_is_admin",
        "api_keys",
        ["is_admin"],
        unique=False,
        postgresql_where=sa.text("is_admin"),
    )


def downgrade() -> None:
    op.drop_index("idx_api_keys_is_admin", table_name="api_keys")
    op.drop_column("api_keys", "is_admin")
