"""grouping library: payload_hash for dup detection + successor_id for retire

Revision ID: 0026_grouping_library_dedup
Revises: 0025_grouping_library
Create Date: 2026-06-18

Adds two columns to ``shared_groupings``:

* ``payload_hash`` (text) — a stable, content-addressed hash of the sorted
  ``payload.tlIds``. Lets the publish endpoint cheaply detect when an author
  is about to publish a near-duplicate of a grouping they already own and
  prompt them to update the existing one instead.

* ``successor_id`` (text, no FK) — points at another ``shared_groupings.id``
  to flag a "this one is retired, the active version lives over there"
  pointer. Used together with the new ``deprecated`` value of ``status``
  (still readable by existing subscribers, hidden from browse) so authors
  can soft-retire a grouping without yanking it out from under everyone
  who's subscribed.

The ``status`` column itself is just a string; no schema change is needed
to start writing ``'deprecated'`` into it. We do create a partial index on
the new hash column scoped to the author so the duplicate lookup is O(1).
"""

from __future__ import annotations

import hashlib
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0026_grouping_library_dedup"
down_revision: Union[str, None] = "0025_grouping_library"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "shared_groupings",
        sa.Column("payload_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "shared_groupings",
        sa.Column("successor_id", sa.String(), nullable=True),
    )
    # Backfill hashes for existing rows so the dup-check can match against
    # them. SHA-256 over a JSON array of the sorted tlIds, mirroring the
    # Python helper in grouping_library_db._payload_hash. Done in Python so
    # we don't require the pgcrypto extension.
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, payload FROM shared_groupings WHERE payload_hash IS NULL"
        )
    ).fetchall()
    for row in rows:
        payload = row.payload or {}
        tl_ids = payload.get("tlIds") if isinstance(payload, dict) else None
        if not isinstance(tl_ids, list):
            tl_ids = []
        normalized = sorted(str(t) for t in tl_ids)
        digest = hashlib.sha256(
            json.dumps(normalized, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        bind.execute(
            sa.text(
                "UPDATE shared_groupings SET payload_hash = :h WHERE id = :i"
            ),
            {"h": digest, "i": row.id},
        )
    # Partial index: only published rows count toward "the author already
    # has one", so a re-publish after unpublish/takedown is allowed.
    op.create_index(
        "idx_shared_groupings_author_payload_hash",
        "shared_groupings",
        ["author_api_key_id", "payload_hash"],
        postgresql_where=sa.text("status = 'published'"),
    )


def downgrade() -> None:
    op.drop_index(
        "idx_shared_groupings_author_payload_hash", table_name="shared_groupings"
    )
    op.drop_column("shared_groupings", "successor_id")
    op.drop_column("shared_groupings", "payload_hash")
