"""feature_flags.value_int (admin-tunable quotas)

Revision ID: 0018_feature_flag_value_int
Revises: 0017_coord_locks
Create Date: 2026-05-20

Adds a nullable ``value_int`` column to ``feature_flags`` so admin-tunable
numeric quotas (per-day caps on trader / translocator submissions, max
batch sizes, dedupe radii, cooldowns) can live in the same table — and
the same admin page — as the existing boolean toggles.

A NULL ``value_int`` means "use the default baked into the route
handler". The handler reads through ``feature_flags.get_int(key, default)``
which falls back to its supplied default in that case. This keeps fresh
installs (no rows) and existing rows (NULL after the ALTER) behaving
exactly like today's hardcoded constants until an admin overrides.

Idempotent — uses ``ADD COLUMN IF NOT EXISTS``.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0018_feature_flag_value_int"
down_revision: Union[str, None] = "0017_coord_locks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE feature_flags
        ADD COLUMN IF NOT EXISTS value_int INTEGER
        """
    )
    # Seed quota flag rows so the admin UI surfaces them and the
    # ``set_feature_flag`` UPDATE has a row to hit. ``value_int`` stays
    # NULL so the route handler's hardcoded default applies until an
    # admin explicitly overrides. ``enabled`` is set to TRUE for these
    # rows but is unused by the quota lookup — the actual feature gate
    # is a separate boolean flag (e.g. ``traders_manual_contributions``).
    op.execute(
        """
        INSERT INTO feature_flags (key, enabled) VALUES
            ('traders_chatlog_daily_cap', TRUE),
            ('traders_manual_daily_cap', TRUE),
            ('traders_max_batch', TRUE),
            ('traders_dedupe_radius', TRUE),
            ('translocators_chatlog_daily_cap', TRUE),
            ('translocators_max_batch', TRUE),
            ('translocators_dedupe_radius', TRUE),
            ('translocator_screenshots_max_pending', TRUE),
            ('map_contribution_cooldown_days', TRUE)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM feature_flags WHERE key IN (
            'traders_chatlog_daily_cap',
            'traders_manual_daily_cap',
            'traders_max_batch',
            'traders_dedupe_radius',
            'translocators_chatlog_daily_cap',
            'translocators_max_batch',
            'translocators_dedupe_radius',
            'translocator_screenshots_max_pending',
            'map_contribution_cooldown_days'
        )
        """
    )
    op.execute("ALTER TABLE feature_flags DROP COLUMN IF EXISTS value_int")
