"""Models for the user-attested "elk-accessible walkable edges" feature.

The JSON file in R2 (``elk_walkable.json``) is the single source of truth
for which TL-endpoint pairs are confirmed walkable by an elk. This table
holds the audit trail (one row per attest / unattest / admin_revert /
admin_restore_snapshot) and a pointer to the pre-mutation R2 snapshot so
admins can either revert a single change or restore the whole file to a
prior state.

``edge_key`` is the canonical, orientation-independent identifier of an
edge between two TL endpoints — see ``app/core/elk_walkable_store.py``
for the formula.

``snapshot_key`` is the R2 object key of the full ``elk_walkable.json``
copied *before* this row's mutation was applied. Restoring that key
recreates the file as it existed immediately prior.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ElkWalkableAudit(Base):
    __tablename__ = "elk_walkable_audit"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    change_id: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    edge_key: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_api_key_id: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    before_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    snapshot_key: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    __table_args__ = (
        Index("idx_elk_walkable_audit_edge", "edge_key", text("created_at DESC")),
        Index("idx_elk_walkable_audit_change", "change_id", text("created_at DESC")),
        Index("idx_elk_walkable_audit_actor", "actor_api_key_id", text("created_at DESC")),
        Index("idx_elk_walkable_audit_created", text("created_at DESC")),
        Index("idx_elk_walkable_audit_action", "action", text("created_at DESC")),
    )
