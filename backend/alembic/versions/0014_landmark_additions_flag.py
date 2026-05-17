"""seed landmark_additions_enabled feature flag

Revision ID: 0014_landmark_additions_flag
Revises: 0013_contrib_submitted_by_key_id
Create Date: 2026-05-18

Seeds the ``landmark_additions_enabled`` feature flag (default TRUE) so
admins can disable non-admin POST /api/landmarks from the Manage →
Feature Flags page. The flag is consulted by
``backend.app.routes.landmarks.add_landmark`` via
``feature_flags.is_feature_enabled_default("landmark_additions_enabled",
True)``. Admins always bypass; rename / edit-request flow is unaffected.

Idempotent — uses ``ON CONFLICT (key) DO NOTHING`` so existing rows
(explicit operator toggles) are preserved.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0014_landmark_additions_flag"
down_revision: Union[str, None] = "0013_contrib_submitted_by_key_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO feature_flags (key, enabled)
        VALUES ('landmark_additions_enabled', TRUE)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM feature_flags WHERE key = 'landmark_additions_enabled'"
    )
