"""geojson_lock + instance_leader

Revision ID: 0017_coord_locks
Revises: 0016_usage_events
Create Date: 2026-05-20

Adds two cross-process coordination tables:

* ``geojson_lock`` — per-resource mutex (translocators / traders /
  landmarks) used by the contribute + admin routes to serialise the
  read-modify-upload of the geojson files in R2 across multiple
  backend replicas. Mirrors the single-row ``map_lock`` pattern but
  is keyed by resource name. Lease auto-expires via ``expires_at``.

* ``instance_leader`` — single-row leader-election lease. Periodic
  scheduled jobs that touch shared R2 keys (weekly backup, history
  cleanup) only fire on the instance currently holding this lease.
  The leader refreshes the lease from a background asyncio loop; if
  the leader crashes, ``expires_at`` causes the lease to fall over
  to whoever next calls ``acquire_or_refresh_instance_leader``.

Both tables are created idempotently so a freshly stamped DB and a
legacy ``ensure_schema()`` run produce the same result.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0017_coord_locks"
down_revision: Union[str, None] = "0016_usage_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS geojson_lock (
            resource        TEXT PRIMARY KEY,
            holder_token    TEXT NOT NULL,
            holder_action   TEXT NOT NULL,
            acquired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at      TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS instance_leader (
            id              TEXT PRIMARY KEY,
            holder_token    TEXT NOT NULL,
            instance_label  TEXT NOT NULL,
            acquired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at      TIMESTAMPTZ NOT NULL
        )
        """
    )

    op.execute("ALTER TABLE geojson_lock ENABLE ROW LEVEL SECURITY;")
    op.execute("ALTER TABLE instance_leader ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS instance_leader")
    op.execute("DROP TABLE IF EXISTS geojson_lock")
