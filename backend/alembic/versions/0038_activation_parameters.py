"""runtime parameter tracking + change flag on license activations

Revision ID: 0038_activation_parameters
Revises: 0037_licenses
Create Date: 2026-08-29

The VSProxy client now sends its effective runtime parameters (CLI flags /
config, minus licensing secrets) on every ``activate``/``validate`` call. We
store the current snapshot per machine, keep the previous snapshot for diffing,
and raise ``params_changed`` when a key is added, removed, or its value differs.
Admins review the diff and clear the flag via a dismiss endpoint.

See ``app/routes/licenses.py`` and ``app/core/database.py``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0038_activation_parameters"
down_revision: Union[str, None] = "0037_licenses"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "license_activations",
        sa.Column("parameters", postgresql.JSONB(), nullable=True),
    )
    op.add_column(
        "license_activations",
        sa.Column("parameters_prev", postgresql.JSONB(), nullable=True),
    )
    op.add_column(
        "license_activations",
        sa.Column(
            "params_changed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "license_activations",
        sa.Column("params_changed_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("license_activations", "params_changed_at")
    op.drop_column("license_activations", "params_changed")
    op.drop_column("license_activations", "parameters_prev")
    op.drop_column("license_activations", "parameters")
