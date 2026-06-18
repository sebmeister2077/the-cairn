"""grouping library: shared TL groupings + versions + votes + installs + reports

Revision ID: 0025_grouping_library
Revises: 0024_elk_walkable_audit
Create Date: 2026-06-18

Backs the community "Global library for groupings" feature. Users publish
their local TL groupings so others can browse / search / fork or subscribe.

Design:
  * ``shared_groupings`` holds the *head* (current) row per published
    grouping. ``payload`` JSONB carries ``{version, tlIds}``; ``tags`` is a
    JSONB string array. Denormalised counters (``install_count``,
    ``upvote_count``) are maintained by the route handlers.
  * ``shared_grouping_versions`` is an append-only snapshot table — one row
    per publish/edit. Lets users view history and fork any past version.
  * ``shared_grouping_votes`` / ``shared_grouping_installs`` track per-user
    upvotes and fork/subscribe installs (distinct-user dedup via PK).
  * ``shared_grouping_reports`` is the moderation queue (post-moderation).
  * ``user_reputation`` caches an activity-derived score per author so the
    browse cards can show a reputation badge without a heavy aggregate.

  * ``author_api_key_id`` stores the ``api_keys.id`` UUID as text, matching
    the convention from ``saved_routes`` / the audit tables (no FK so a
    rekey doesn't orphan rows; display names are resolved live via a JOIN
    on ``users.api_key_id``).

Also seeds the feature-flag rows so the feature is discoverable + tunable in
the admin Feature Flags page:

- ``grouping_library_enabled`` (boolean, default FALSE): kill switch for the
  whole feature (browse + publish endpoints 404 when off).
- ``grouping_library_publish_daily_cap`` (quota, value_int NULL -> handler
  default 5): per-API-key max publishes per 24h.
- ``grouping_library_max_tls`` (quota, default 500): max TLs per grouping.
- ``grouping_library_max_tags`` (quota, default 5): max tags per grouping.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0025_grouping_library"
down_revision: Union[str, None] = "0024_elk_walkable_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- shared_groupings (head row per published grouping) ---------------
    op.create_table(
        "shared_groupings",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column(
            "content_type",
            sa.String(),
            nullable=False,
            server_default=sa.text("'tl_grouping'"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("color", sa.String(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("tags", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("author_api_key_id", sa.String(), nullable=True),
        sa.Column(
            "is_official",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "status",
            sa.String(),
            nullable=False,
            server_default=sa.text("'published'"),
        ),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column(
            "install_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "upvote_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("last_edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by", sa.String(), nullable=True),
        sa.Column("removed_reason", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_shared_groupings_status_upvotes",
        "shared_groupings",
        ["status", sa.text("upvote_count DESC")],
    )
    op.create_index(
        "idx_shared_groupings_status_installs",
        "shared_groupings",
        ["status", sa.text("install_count DESC")],
    )
    op.create_index(
        "idx_shared_groupings_status_created",
        "shared_groupings",
        ["status", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_shared_groupings_author",
        "shared_groupings",
        ["author_api_key_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_shared_groupings_official",
        "shared_groupings",
        ["status", "is_official"],
    )
    op.create_index(
        "idx_shared_groupings_tags",
        "shared_groupings",
        ["tags"],
        postgresql_using="gin",
    )
    # Trigram index for case-insensitive name search (pg_trgm enabled by the
    # accounts migration that added the users display_name trgm index).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_shared_groupings_name_trgm "
        "ON shared_groupings USING gin (name gin_trgm_ops)"
    )
    op.execute("ALTER TABLE shared_groupings ENABLE ROW LEVEL SECURITY;")

    # --- shared_grouping_versions (append-only history) ------------------
    op.create_table(
        "shared_grouping_versions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("grouping_id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("color", sa.String(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("tags", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("edited_by_api_key_id", sa.String(), nullable=True),
        sa.Column("change_note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "grouping_id", "version", name="uq_shared_grouping_versions"
        ),
    )
    op.create_index(
        "idx_shared_grouping_versions_lookup",
        "shared_grouping_versions",
        ["grouping_id", sa.text("version DESC")],
    )
    op.execute(
        "ALTER TABLE shared_grouping_versions ENABLE ROW LEVEL SECURITY;"
    )

    # --- shared_grouping_votes -------------------------------------------
    op.create_table(
        "shared_grouping_votes",
        sa.Column("grouping_id", sa.String(), nullable=False),
        sa.Column("voter_api_key_id", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "grouping_id", "voter_api_key_id", name="pk_shared_grouping_votes"
        ),
    )
    op.create_index(
        "idx_shared_grouping_votes_grouping",
        "shared_grouping_votes",
        ["grouping_id"],
    )
    op.execute("ALTER TABLE shared_grouping_votes ENABLE ROW LEVEL SECURITY;")

    # --- shared_grouping_installs ----------------------------------------
    op.create_table(
        "shared_grouping_installs",
        sa.Column("grouping_id", sa.String(), nullable=False),
        sa.Column("api_key_id", sa.String(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("forked_from_version", sa.Integer(), nullable=True),
        sa.Column("synced_version", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "grouping_id", "api_key_id", name="pk_shared_grouping_installs"
        ),
    )
    op.create_index(
        "idx_shared_grouping_installs_grouping",
        "shared_grouping_installs",
        ["grouping_id"],
    )
    op.create_index(
        "idx_shared_grouping_installs_subscriber",
        "shared_grouping_installs",
        ["api_key_id", "mode"],
    )
    op.execute(
        "ALTER TABLE shared_grouping_installs ENABLE ROW LEVEL SECURITY;"
    )

    # --- shared_grouping_reports (moderation queue) ----------------------
    op.create_table(
        "shared_grouping_reports",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("grouping_id", sa.String(), nullable=False),
        sa.Column("reporter_api_key_id", sa.String(), nullable=True),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("details", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.String(),
            nullable=False,
            server_default=sa.text("'open'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_shared_grouping_reports_open",
        "shared_grouping_reports",
        [sa.text("created_at DESC")],
        postgresql_where=sa.text("status = 'open'"),
    )
    op.create_index(
        "idx_shared_grouping_reports_grouping",
        "shared_grouping_reports",
        ["grouping_id", sa.text("created_at DESC")],
    )
    op.execute(
        "ALTER TABLE shared_grouping_reports ENABLE ROW LEVEL SECURITY;"
    )

    # --- user_reputation (cached aggregate) ------------------------------
    op.create_table(
        "user_reputation",
        sa.Column("api_key_id", sa.String(), nullable=False),
        sa.Column(
            "reputation_score", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "published_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "total_upvotes_received",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "total_installs_received",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "official_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("api_key_id"),
    )
    op.execute("ALTER TABLE user_reputation ENABLE ROW LEVEL SECURITY;")

    # --- feature flags ---------------------------------------------------
    op.execute(
        """
        INSERT INTO feature_flags (key, enabled) VALUES
            ('grouping_library_enabled', FALSE),
            ('grouping_library_publish_daily_cap', TRUE),
            ('grouping_library_max_tls', TRUE),
            ('grouping_library_max_tags', TRUE)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM feature_flags WHERE key IN "
        "('grouping_library_enabled', 'grouping_library_publish_daily_cap', "
        "'grouping_library_max_tls', 'grouping_library_max_tags')"
    )
    op.drop_table("user_reputation")
    op.drop_index(
        "idx_shared_grouping_reports_grouping", table_name="shared_grouping_reports"
    )
    op.drop_index(
        "idx_shared_grouping_reports_open", table_name="shared_grouping_reports"
    )
    op.drop_table("shared_grouping_reports")
    op.drop_index(
        "idx_shared_grouping_installs_subscriber",
        table_name="shared_grouping_installs",
    )
    op.drop_index(
        "idx_shared_grouping_installs_grouping",
        table_name="shared_grouping_installs",
    )
    op.drop_table("shared_grouping_installs")
    op.drop_index(
        "idx_shared_grouping_votes_grouping", table_name="shared_grouping_votes"
    )
    op.drop_table("shared_grouping_votes")
    op.drop_index(
        "idx_shared_grouping_versions_lookup",
        table_name="shared_grouping_versions",
    )
    op.drop_table("shared_grouping_versions")
    op.execute("DROP INDEX IF EXISTS idx_shared_groupings_name_trgm")
    op.drop_index("idx_shared_groupings_tags", table_name="shared_groupings")
    op.drop_index("idx_shared_groupings_official", table_name="shared_groupings")
    op.drop_index("idx_shared_groupings_author", table_name="shared_groupings")
    op.drop_index(
        "idx_shared_groupings_status_created", table_name="shared_groupings"
    )
    op.drop_index(
        "idx_shared_groupings_status_installs", table_name="shared_groupings"
    )
    op.drop_index(
        "idx_shared_groupings_status_upvotes", table_name="shared_groupings"
    )
    op.drop_table("shared_groupings")
