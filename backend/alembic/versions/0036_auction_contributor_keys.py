"""auction contributor key columns on api_keys

Revision ID: 0036_auction_contributor_keys
Revises: 0035_trader_claim_types
Create Date: 2026-08-10

Adds the columns backing auction contributor keys (VSProxy →
``POST /api/contribute-auction-events``). Mirrors the idempotent DDL in
``database._MIGRATIONS_SQL`` so both the alembic and legacy ensure_schema
startup paths converge on the same schema. See
``app/routes/contribute_auction_events.py`` and ``app/core/auction_raw_store.py``.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0036_auction_contributor_keys"
down_revision: Union[str, None] = "0035_trader_claim_types"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (name, type, nullable, server_default)
_COLUMNS = (
    ("auction_contributor", sa.Boolean(), False, sa.text("false")),
    ("auction_trusted", sa.Boolean(), False, sa.text("false")),
    ("auction_hmac_secret", sa.Text(), True, None),
    ("auction_label", sa.Text(), True, None),
    ("auction_last_utc", sa.TIMESTAMP(timezone=True), True, None),
    ("auction_id_count", sa.Integer(), False, sa.text("0")),
    ("auction_size_bytes", sa.BigInteger(), False, sa.text("0")),
    ("auction_fingerprint", postgresql.JSONB(astext_type=sa.Text()), True, None),
)


def upgrade() -> None:
    for name, coltype, nullable, default in _COLUMNS:
        op.add_column(
            "api_keys",
            sa.Column(name, coltype, nullable=nullable, server_default=default),
        )
    op.create_index(
        "idx_api_keys_auction_contributor",
        "api_keys",
        ["auction_contributor"],
        unique=False,
        postgresql_where=sa.text("auction_contributor"),
    )


def downgrade() -> None:
    op.drop_index("idx_api_keys_auction_contributor", table_name="api_keys")
    for name, *_ in reversed(_COLUMNS):
        op.drop_column("api_keys", name)
