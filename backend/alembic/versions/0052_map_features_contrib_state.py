"""dedicated map_features_contrib_state table

Revision ID: 0052_map_features_contrib_state
Revises: 0051_backfill_license_api_key
Create Date: 2026-10-15

Per-contributor ingest state for ``/contribute-map-features``. Previously this
lived in the shared ``app_state`` key/value table under the
``map_features_contrib:<key_id>`` prefix; it now gets its own table so the
delta-upload protocol can store structured ``epoch``/``version`` columns next to
the content ``hash`` + ``received_utc`` instead of serialising everything into a
single JSON blob.

* ``content_hash`` / ``received_utc`` feed the ``/status`` 304 fast path (an
  unchanged re-upload is skipped before it is decoded).
* ``epoch`` / ``version`` drive the append-only delta handshake: a client pushes
  deltas against ``(epoch, version)``; a mismatch forces a full resync, and a
  full (replace) upload bumps ``epoch`` and resets ``version`` to 0.

The ``app_state`` rows are migrated across and then removed.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0052_map_features_contrib_state"
down_revision: Union[str, None] = "0051_backfill_license_api_key"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "map_features_contrib_state",
        sa.Column("key_id", sa.String(), nullable=False),
        sa.Column("content_hash", sa.String(), nullable=True),
        sa.Column("received_utc", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "epoch", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "version", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("key_id"),
    )
    op.execute("ALTER TABLE map_features_contrib_state ENABLE ROW LEVEL SECURITY;")

    # Backfill from the old app_state blobs (key = 'map_features_contrib:<key_id>',
    # value = '{"hash": ..., "receivedUtc": ...}') then drop them.
    op.execute(
        """
        INSERT INTO map_features_contrib_state (key_id, content_hash, received_utc)
        SELECT substring(key FROM length('map_features_contrib:') + 1) AS key_id,
               (value::jsonb ->> 'hash') AS content_hash,
               NULLIF(value::jsonb ->> 'receivedUtc', '')::timestamptz AS received_utc
          FROM app_state
         WHERE key LIKE 'map_features_contrib:%'
        ON CONFLICT (key_id) DO NOTHING
        """
    )
    op.execute("DELETE FROM app_state WHERE key LIKE 'map_features_contrib:%'")


def downgrade() -> None:
    # Fold the structured state back into app_state so a downgrade keeps the
    # 304 fast path working (epoch/version are delta-only and dropped).
    op.execute(
        """
        INSERT INTO app_state (key, value)
        SELECT 'map_features_contrib:' || key_id,
               json_build_object(
                   'hash', content_hash,
                   'receivedUtc', to_char(received_utc, 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')
               )::text
          FROM map_features_contrib_state
         WHERE content_hash IS NOT NULL
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        """
    )
    op.drop_table("map_features_contrib_state")
