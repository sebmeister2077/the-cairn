"""seed manual_translocators + translocators_manual_daily_cap flags

Revision ID: 0023_manual_translocators_flag
Revises: 0022_contributions_archive_superseded
Create Date: 2026-05-30

Seeds two rows so the new "Manual TL entry" feature is visible in the
Manage → Feature Flags page:

- ``manual_translocators`` (boolean, default FALSE): gates POST
  /api/contribute-tls/manual. When OFF the endpoint returns 503.
- ``translocators_manual_daily_cap`` (quota row, value_int NULL → handler
  default 15 applies): per-API-key max manual TL submissions per rolling
  24h window. Admins bypass.

Idempotent — uses ``ON CONFLICT (key) DO NOTHING`` so explicit operator
toggles are preserved.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0023_manual_translocators_flag"
down_revision: Union[str, None] = "0022_archive_superseded"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO feature_flags (key, enabled) VALUES
            ('manual_translocators', TRUE),
            ('translocators_manual_daily_cap', TRUE)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM feature_flags WHERE key IN "
        "('manual_translocators', 'translocators_manual_daily_cap')"
    )
