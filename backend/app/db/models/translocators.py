"""Models for the user-contributed translocators feature.

The geojson file in R2 (``translocators.geojson``) is the single source of
truth for what the map renders. This table holds the audit trail for
user-contributed TLs: every successful add and every admin delete inserts
one row. ``actor_display_name`` is snapshotted at action time so the log
stays readable after a rename or account deletion.

``submission_stats`` carries the user-supplied (frontend-computed) match
statistics for the batch: ``existing_match_pct``, ``existing_pair_count``
and ``batch_id``. Trusted as-is — no server-side recomputation.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class TranslocatorsAudit(Base):
    __tablename__ = "translocators_audit"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    segment_id: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    actor_api_key_id: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    before_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    submission_stats: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    __table_args__ = (
        Index("idx_translocators_audit_segment", "segment_id", text("created_at DESC")),
        Index("idx_translocators_audit_actor", "actor_api_key_id", text("created_at DESC")),
        Index("idx_translocators_audit_created", text("created_at DESC")),
        Index("idx_translocators_audit_action", "action", text("created_at DESC")),
    )
