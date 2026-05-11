"""Models for the screenshot-based translocator contribution flow.

Users submit two screenshots (one per paired translocator endpoint),
each showing the in-game coordinate HUD and the top-right minimap.
Backend OCRs coords, edge-detects + matches the minimap against the
level-5 TOPS map cache, and surfaces validations as warnings to the
admin reviewer. Approved requests are written into the same
``translocators.geojson`` + ``translocators_audit`` plumbing as the
chat-log path, then the screenshots are deleted from R2.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
STATUS_WITHDRAWN = "withdrawn"
STATUSES = (STATUS_PENDING, STATUS_APPROVED, STATUS_REJECTED, STATUS_WITHDRAWN)


class TranslocatorScreenshotRequest(Base):
    __tablename__ = "translocator_screenshot_requests"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # uuid
    status: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'pending'")
    )

    submitter_api_key_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    submitter_display_name: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # R2 keys; nullable because we delete the objects on approve/reject and
    # null the columns at the same time.
    screenshot_a_key: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    screenshot_b_key: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    minimap_crop_a_key: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    minimap_crop_b_key: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    screenshot_a_taken_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    screenshot_b_taken_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # OCR result per slot — {x, y, z, raw_text, confidence}
    ocr_a: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    ocr_b: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    # Final coords (initially mirrors OCR; admin can edit before approve)
    coords_a: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    coords_b: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    label: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # Pipeline status: queued | running | done | failed
    analysis_status: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'queued'")
    )
    analysis_error: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # [{code, message, severity}]
    validation_warnings: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    # {score_a, score_b, level5_chunks_used, method}
    minimap_match: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    decision_actor_api_key_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    decision_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decision_reason: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    resulting_segment_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )

    __table_args__ = (
        Index(
            "idx_tl_ssr_status_created",
            "status",
            text("created_at DESC"),
        ),
        Index(
            "idx_tl_ssr_submitter_created",
            "submitter_api_key_id",
            text("created_at DESC"),
        ),
        Index(
            "idx_tl_ssr_analysis_status",
            "analysis_status",
        ),
    )
