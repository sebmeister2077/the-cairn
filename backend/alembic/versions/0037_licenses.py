"""license activation tables for the VSProxy client

Revision ID: 0037_licenses
Revises: 0036_auction_contributor_keys
Create Date: 2026-08-18

Adds two tables backing the VSProxy online license gate:

* ``licenses``            — one row per issued key (per friend). Holds the
  activation cap, optional expiry, and the revocation switch.
* ``license_activations`` — one row per (license, machine fingerprint) pair.
  Bounds a key to a limited number of machines and lets a single machine be
  unbound without revoking the whole key.

See ``app/routes/licenses.py`` and ``app/core/license_signing.py``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0037_licenses"
down_revision: Union[str, None] = "0036_auction_contributor_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "licenses",
        sa.Column("license_code", sa.Text(), primary_key=True),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'active'")),
        sa.Column("max_activations", sa.Integer(), nullable=False, server_default=sa.text("2")),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_table(
        "license_activations",
        sa.Column("license_code", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.Column("app_version", sa.Text(), nullable=True),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("first_seen", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("last_seen", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("license_code", "fingerprint"),
        sa.ForeignKeyConstraint(
            ["license_code"], ["licenses.license_code"], ondelete="CASCADE"
        ),
    )
    op.create_index(
        "idx_license_activations_code",
        "license_activations",
        ["license_code"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_license_activations_code", table_name="license_activations")
    op.drop_table("license_activations")
    op.drop_table("licenses")
