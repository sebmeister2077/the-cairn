"""process_lifecycle crash/boot audit table

Revision ID: 0056_process_lifecycle
Revises: 0055_merge_license_overrides
Create Date: 2026-11-04

Records one row per process start so that an *ungraceful* death — an OOM /
SIGKILL, a native segfault, or any hard crash that cannot be caught
in-process — is still captured. A graceful stop marks its row
``stopped_clean``; anything else leaves the row ``running`` and the next
boot of the same replica reconciles it to ``crashed_ungraceful`` (the
tell-tale of an OOM kill, which SIGKILL makes impossible to observe
in-process).

Design notes:
  * One row per process start, keyed by a random ``boot_id``.
  * ``replica`` is the stable per-instance identity (Railway
    ``RAILWAY_REPLICA_ID`` when present, else the configured instance
    label / hostname) used to reconcile a dead predecessor on the next
    boot without touching a healthy sibling.
  * ``last_heartbeat_at`` + ``rss_mb`` / ``rss_mb_peak`` are refreshed by a
    lightweight background thread so a reconciled crash row still carries
    the memory high-water mark and an accurate time-of-death.
  * ``detail`` is a small JSONB payload (exception class, traceback tail,
    signal name, …). Writes are best-effort and must never block startup.

Retention is handled at runtime (the recorder keeps the newest ~500 rows),
so this migration adds no automatic prune.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0056_process_lifecycle"
down_revision: Union[str, None] = "0055_merge_license_overrides"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "process_lifecycle",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("boot_id", sa.String(), nullable=False),
        sa.Column("replica", sa.String(), nullable=True),
        sa.Column("instance_label", sa.String(), nullable=True),
        sa.Column("pid", sa.Integer(), nullable=True),
        sa.Column("app_env", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default=sa.text("'running'")),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("stopped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rss_mb", sa.Integer(), nullable=True),
        sa.Column("rss_mb_peak", sa.Integer(), nullable=True),
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("boot_id", name="uq_process_lifecycle_boot_id"),
    )
    op.create_index(
        "idx_process_lifecycle_started",
        "process_lifecycle",
        [sa.text("started_at DESC")],
    )
    op.create_index(
        "idx_process_lifecycle_replica_status",
        "process_lifecycle",
        ["replica", "status"],
    )
    op.execute("ALTER TABLE process_lifecycle ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.drop_index("idx_process_lifecycle_replica_status", table_name="process_lifecycle")
    op.drop_index("idx_process_lifecycle_started", table_name="process_lifecycle")
    op.drop_table("process_lifecycle")
