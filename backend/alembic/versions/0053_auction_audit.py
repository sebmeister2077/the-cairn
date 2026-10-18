"""auction_audit table

Revision ID: 0053_auction_audit
Revises: 0052_map_features_contrib_state
Create Date: 2026-10-18

Append-only audit trail for the crowd-sourced, merged Auction House data
published to the public auction bucket (``listings.json`` / ``summary.json`` /
``items.json``). Rows are written for:

* ``contribute`` — an accepted snapshot/events upload from a source (the mod's
  ``/contribute-auctions`` HMAC push or the VSProxy ``/contribute-auction-events``
  per-key push), recording who uploaded and how many records were received /
  accepted.
* ``rebuild_publish`` — a rebuild re-merged every active source and published
  new public artifacts, recording the resulting auction / listing / item counts.
* ``admin_rebuild`` — an admin forced a manual rebuild.
* ``admin_revoke`` — an admin revoked (and optionally purged) a contributor
  source, excluding it from future rebuilds.

Surfaced read-only on the admin "Auction house" audit page.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0053_auction_audit"
down_revision: Union[str, None] = "0052_map_features_contrib_state"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "auction_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        # 'contribute' | 'rebuild_publish' | 'admin_rebuild' | 'admin_revoke'
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("actor_api_key_id", sa.String(), nullable=True),
        sa.Column("actor_display_name", sa.String(), nullable=True),
        sa.Column("source_id", sa.String(), nullable=True),
        sa.Column("upstream_host", sa.String(), nullable=True),
        sa.Column("received", sa.Integer(), nullable=True),
        sa.Column("accepted", sa.Integer(), nullable=True),
        sa.Column("auctions", sa.Integer(), nullable=True),
        sa.Column("listings", sa.Integer(), nullable=True),
        sa.Column("items", sa.Integer(), nullable=True),
        sa.Column("note", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_auction_audit_created",
        "auction_audit",
        [sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_auction_audit_actor",
        "auction_audit",
        ["actor_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_auction_audit_action",
        "auction_audit",
        ["action", sa.text("created_at DESC")],
    )
    op.execute("ALTER TABLE auction_audit ENABLE ROW LEVEL SECURITY;")


def downgrade() -> None:
    op.drop_index("idx_auction_audit_action", table_name="auction_audit")
    op.drop_index("idx_auction_audit_actor", table_name="auction_audit")
    op.drop_index("idx_auction_audit_created", table_name="auction_audit")
    op.drop_table("auction_audit")
