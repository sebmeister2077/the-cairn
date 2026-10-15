"""add nullable api_key_id to licenses

Revision ID: 0049_license_api_key_id
Revises: 0048_planned_routes
Create Date: 2026-10-15

Links a license to the API key it contributes through, so moderation views
(e.g. the map-features traders audit) can label a contribution with the
friendly license ``label`` instead of only the raw API-key actor name.

The column is nullable and unconstrained (no FK) — it is mapped lazily when a
license is actually used, mirroring how ``actor_api_key_id`` is stored on the
audit tables. ``api_key_id`` holds the stringified ``api_keys.id`` so it can be
compared directly against ``map_features_traders_audit.actor_api_key_id``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0049_license_api_key_id"
down_revision: Union[str, None] = "0048_planned_routes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "licenses",
        sa.Column("api_key_id", sa.Text(), nullable=True),
    )
    op.create_index(
        "idx_licenses_api_key_id",
        "licenses",
        ["api_key_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_licenses_api_key_id", table_name="licenses")
    op.drop_column("licenses", "api_key_id")
