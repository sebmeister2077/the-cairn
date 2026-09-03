"""log over-limit license activation attempts

Revision ID: 0040_license_over_limit_attempts
Revises: 0039_program_downloads
Create Date: 2026-09-03

Records every denied ``POST /license/activate`` where the caller tried to bind a
new machine past the license's ``max_activations`` cap. Surfaced in the admin
Licenses view so an admin can spot a friend sharing a key across too many
machines. See ``app/routes/licenses.py``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0040_license_over_limit_attempts"
down_revision: Union[str, None] = "0039_program_downloads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "license_activation_attempts",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("license_code", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=True),
        sa.Column("app_version", sa.Text(), nullable=True),
        sa.Column("ip_hash", sa.Text(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False, server_default=sa.text("'limit_reached'")),
        sa.Column(
            "attempted_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["license_code"], ["licenses.license_code"], ondelete="CASCADE"
        ),
    )
    op.create_index(
        "idx_license_activation_attempts_code",
        "license_activation_attempts",
        ["license_code", "attempted_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "idx_license_activation_attempts_code",
        table_name="license_activation_attempts",
    )
    op.drop_table("license_activation_attempts")
