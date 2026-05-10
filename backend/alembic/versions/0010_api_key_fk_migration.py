"""api-key-Fk-migration

Revision ID: 91e3a25474ee
Revises: 0009_use_ingame_as_display
Create Date: 2026-05-10 00:57:09.334969

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa  # noqa: F401  (kept for op.execute / future use)


# revision identifiers, used by Alembic.
revision: str = '0010_api_key_fk_migration'
down_revision: Union[str, None] = '0009_use_ingame_as_display'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        UPDATE feature_flags
        SET updated_by_key_id = ak.id
        FROM api_keys ak
        WHERE feature_flags.updated_by_key = ak.key
        AND feature_flags.updated_by_key IS NOT NULL
    """)
    op.drop_column("admin_audit_log","admin_key");
    op.drop_column("app_settings","updated_by_key");
    op.drop_column("backup_download_links","created_by");
    op.drop_column("backup_download_links","revoked_by");


    op.drop_column("contributions","submitted_by_key");
    op.drop_column("contributions","reverted_by_key");
    op.drop_column("contributions","approval_requested_by_key");
    op.drop_column("contributions","revert_requested_by_key");

    op.drop_column("feature_flags","updated_by_key");

    op.drop_column("ip_bans","banned_by");


    op.drop_column("maintenance_notices","updated_by_key");


    op.add_column("user_flags",sa.Column("flagged_user_id",sa.UUID(),nullable=True))
    op.create_foreign_key(op.f("fk_user_flags_flagged_user_id_users"), "user_flags", "users", ["flagged_user_id"], ["id"], ondelete="SET NULL")
    op.add_column("user_flags",sa.Column("related_user_id",sa.UUID(),nullable=True))
    op.create_foreign_key(op.f("fk_user_flags_related_user_id_users"), "user_flags", "users", ["related_user_id"], ["id"], ondelete="SET NULL")
    # add resolve by key id which is a FK to the api keys table, then drop the resolved_by_key column
    op.add_column("user_flags",sa.Column("resolved_by_key_id",sa.UUID(),nullable=True))


    op.execute("""
    UPDATE user_flags
    SET flagged_user_id = u.id
    FROM users u
    JOIN api_keys ak ON ak.id = u.api_key_id
    WHERE user_flags.flagged_user = ak.key
      AND user_flags.flagged_user IS NOT NULL
    """)
    op.execute("""
        UPDATE user_flags
        SET related_user_id = u.id
        FROM users u
        JOIN api_keys ak ON ak.id = u.api_key_id
        WHERE user_flags.related_user = ak.key
        AND user_flags.related_user IS NOT NULL
    """)


    op.drop_column("user_flags","flagged_user")
    op.drop_column("user_flags","related_user")
    op.drop_column("user_flags","resolved_by")


    op.drop_column("users","api_key")


    pass


def downgrade() -> None:
    op.add_column("admin_audit_log",sa.Column("admin_key",sa.String(length=255),nullable=True))
    op.add_column("app_settings",sa.Column("updated_by_key",sa.String(length=255),nullable=True))
    op.add_column("backup_download_links",sa.Column("created_by",sa.String(length=255),nullable=True))
    op.add_column("backup_download_links",sa.Column("revoked_by",sa.String(length=255),nullable=True))  
    op.add_column("contributions",sa.Column("submitted_by_key",sa.String(length=255),nullable=True))
    op.add_column("contributions",sa.Column("reverted_by_key",sa.String(length=255),nullable=True))
    op.add_column("contributions",sa.Column("approval_requested_by_key",sa.String(length=255),nullable=True))
    op.add_column("contributions",sa.Column("revert_requested_by_key",sa.String(length=255),nullable=True))
    op.add_column("feature_flags",sa.Column("updated_by_key",sa.String(length=255),nullable=True))
    op.add_column("ip_bans",sa.Column("banned_by",sa.String(length=255),nullable=True))
    op.add_column("maintenance_notices",sa.Column("updated_by_key",sa.String(length=255),nullable=True))
    op.add_column("user_flags",sa.Column("flagged_user",sa.String(length=255),nullable=True))
    op.add_column("user_flags",sa.Column("related_user",sa.String(length=255),nullable=True))
    op.add_column("user_flags",sa.Column("resolved_by",sa.String(length=255),nullable=True))
    op.add_column("users",sa.Column("api_key",sa.String(length=255),nullable=True)) 


    op.drop_column("user_flags","flagged_user_id")
    op.drop_column("user_flags","related_user_id")
    op.drop_column("user_flags","resolved_by_key_id")
    pass
