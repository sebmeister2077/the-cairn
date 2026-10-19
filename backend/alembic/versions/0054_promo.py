"""Add promo_events table for admin-managed promotion banners.



"""


from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0054_promo"
down_revision: Union[str, None] = "0053_auction_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    # TODO convert raw sql to SQLAlchemy
    op.create_table(
        "promo_events",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("content", sa.JSON, nullable=False, server_default="{}"),
        sa.Column("image_key", sa.Text),
        sa.Column("image_content_type", sa.Text),
        sa.Column("active", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("created_by_key_id", sa.UUID),
    )
    op.create_index(
        "idx_promo_events_single_active",
        "promo_events",
        ["active"],
        unique=True,
        postgresql_where=sa.text("active"),
    )

    op.execute("ALTER TABLE promo_events ENABLE ROW LEVEL SECURITY;")

def downgrade() -> None:
    op.drop_index("idx_promo_events_single_active", table_name="promo_events")
    op.drop_table("promo_events")







