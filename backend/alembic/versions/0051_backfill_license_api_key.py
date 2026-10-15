"""backfill licenses.api_key_id from program download links

Revision ID: 0051_backfill_license_api_key
Revises: 0050_map_features_audit_category
Create Date: 2026-10-15

``licenses.api_key_id`` (added in 0049) is set going forward when a program
download link mints a license + contributor API key together. This backfills
the mapping for links that already exist: each ``program_download_links`` row
pairs a ``license_code`` with the ``api_key`` it shipped, and ``api_keys.key``
resolves that to the key's UUID ``id`` (stored as text, matching how the
map-features audit records ``actor_api_key_id``).
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0051_backfill_license_api_key"
down_revision: Union[str, None] = "0050_map_features_audit_category"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE licenses l
           SET api_key_id = k.id::text
          FROM program_download_links dl
          JOIN api_keys k ON k.key = dl.api_key
         WHERE dl.license_code = l.license_code
           AND dl.api_key IS NOT NULL
           AND l.api_key_id IS NULL
        """
    )


def downgrade() -> None:
    # Data-only backfill — nothing to reverse (the column itself is dropped by
    # 0049's downgrade).
    pass
