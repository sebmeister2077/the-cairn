"""Models for the user-contributed Traders feature.

The geojson file in R2 (``traders.geojson``) is the single source of truth
for what the map renders. This table holds the audit trail: every successful
add / edit / delete / revert inserts one row. ``actor_display_name`` is
snapshotted at action time so the log stays readable after a rename or
account deletion.

Action set:
    add          — user contribution accepted (source: chatlog | manual)
    edit         — coords / type / name modified (user or admin)
    delete       — feature removed by submitter or admin
    admin_delete — admin-initiated removal (separate action for filtering)
    admin_edit   — admin-initiated edit (separate action for filtering)
    revert       — per-submission revert (Phase 4b style); the
                   ``before_payload`` is restored from the inverted audit
                   row, see admin_traders.revert_trader_audit.

``submission_stats`` carries the user-supplied (frontend-computed) batch
statistics: ``{batch_id, submitted_count, accepted_count, duplicate_count,
chatlog_parsed_count?, inferred_confidence?}``. Trusted as-is.

``duplicate_flagged`` is set TRUE when the dedupe scan found another trader
within ``_DUPLICATE_RADIUS`` (200 blocks) at submit time — the row is still
inserted, but the admin review UI surfaces the flag.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class TradersAudit(Base):
    __tablename__ = "traders_audit"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    trader_id: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    source: Mapped[str | None] = mapped_column(String, nullable=True)
    trader_type: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_api_key_id: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    before_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    submission_stats: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    duplicate_flagged: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("FALSE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    __table_args__ = (
        Index("idx_traders_audit_trader", "trader_id", text("created_at DESC")),
        Index("idx_traders_audit_actor", "actor_api_key_id", text("created_at DESC")),
        Index("idx_traders_audit_created", text("created_at DESC")),
        Index("idx_traders_audit_action", "action", text("created_at DESC")),
        Index("idx_traders_audit_type", "trader_type", text("created_at DESC")),
        Index(
            "idx_traders_audit_duplicate",
            "duplicate_flagged",
            text("created_at DESC"),
            postgresql_where=text("duplicate_flagged = TRUE"),
        ),
    )
