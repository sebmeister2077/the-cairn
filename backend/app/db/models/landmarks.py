"""Models for the user-editable landmarks/translocators feature.

The geojson file in R2 (``landmarks.geojson``) is the single source of
truth for what the map renders. These tables hold the audit trail and
the admin approval queue for landmark renames.

* ``landmarks_audit`` — append-only log. Every mutation (add by user,
  rename by owner, rename approved/rejected by admin, admin delete)
  writes one row. ``actor_display_name`` is snapshotted at action time
  so the log stays readable after a rename or account deletion.

* ``landmark_edit_requests`` — pending-approval queue for renames of
  landmarks the user did NOT add (seeded or another user's). Renaming
  one's own landmark applies live and never inserts here. Status
  transitions:
    pending → approved   (admin approve)
    pending → rejected   (admin reject)
    pending → superseded (newer request from same user for same landmark)
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class LandmarksAudit(Base):
    __tablename__ = "landmarks_audit"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    landmark_id: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    actor_api_key_id: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    before_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    __table_args__ = (
        Index("idx_landmarks_audit_landmark", "landmark_id", text("created_at DESC")),
        Index("idx_landmarks_audit_actor", "actor_api_key_id", text("created_at DESC")),
        Index("idx_landmarks_audit_created", text("created_at DESC")),
    )


class LandmarkEditRequest(Base):
    __tablename__ = "landmark_edit_requests"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    landmark_id: Mapped[str] = mapped_column(String, nullable=False)
    submitted_by_api_key_id: Mapped[str] = mapped_column(String, nullable=False)
    submitted_by_display_name: Mapped[str] = mapped_column(String, nullable=False)
    current_label: Mapped[str] = mapped_column(String, nullable=False)
    proposed_label: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'pending'")
    )
    reviewed_by_api_key_id: Mapped[str | None] = mapped_column(String, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_note: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    __table_args__ = (
        Index(
            "idx_landmark_edit_requests_status",
            "status",
            text("created_at DESC"),
        ),
        Index("idx_landmark_edit_requests_landmark", "landmark_id"),
        Index(
            "idx_landmark_edit_requests_submitter",
            "submitted_by_api_key_id",
            text("created_at DESC"),
        ),
    )
