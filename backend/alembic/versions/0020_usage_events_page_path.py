"""usage_events: partial expression index on metadata->>'path'

Revision ID: 0020_usage_page_path
Revises: 0019_archive_pruned
Create Date: 2026-05-25

Speeds up the admin Usage "Pages" section, which aggregates
``page.view`` events grouped by the route template stored in
``metadata->>'path'``. The index is partial so it only covers
page-view rows and stays cheap to maintain.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0020_usage_page_path"
down_revision: Union[str, None] = "0019_archive_pruned"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """CREATE INDEX IF NOT EXISTS idx_usage_events_page_path
               ON usage_events ((metadata->>'path'))
            WHERE event_type = 'page.view'"""
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_usage_events_page_path")
