"""Supabase PostgreSQL client for structured data.

Tables:
  - contributions     â€” one row per contribution (pending, approved, rejected)
  - contribution_log  â€” approved merge history
  - app_state         â€” key/value for things like cached tile count
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from typing import List, Optional

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pg_pool

from ..config import settings

_pool = None


def init_db():
    """Create a simple connection pool. Call once at startup."""
    global _pool
    if not settings.SUPABASE_DB_URL:
        raise RuntimeError("SUPABASE_DB_URL is not configured")
    _pool = pg_pool.SimpleConnectionPool(
        minconn=1,
        maxconn=5,
        dsn=settings.SUPABASE_DB_URL,
    )


def close_db():
    """Close the connection pool. Call at shutdown."""
    global _pool
    if _pool:
        _pool.closeall()
        _pool = None


@contextmanager
def get_conn():
    """Yield a connection from the pool; auto-returns on exit."""
    conn = _pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


# ---------------------------------------------------------------------------
# Schema bootstrap (idempotent)
# ---------------------------------------------------------------------------
# THIS WILL NOT BE UPDATED ANYMORE, USE THE ALEMBIC MIGRATION SYSTEM FOR FUTURE CHANGES TO THE DATABASE

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS contributions (
    id              TEXT PRIMARY KEY,
    contributor     TEXT NOT NULL DEFAULT 'Anonymous',
    tile_count      INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at     TIMESTAMPTZ,
    tiles_new       INTEGER,
    tiles_existing  INTEGER,
    combined_total  INTEGER
);

CREATE TABLE IF NOT EXISTS contribution_log (
    id              TEXT PRIMARY KEY,
    contributor     TEXT NOT NULL,
    approved_at     TIMESTAMPTZ NOT NULL,
    tiles_new       INTEGER NOT NULL DEFAULT 0,
    tiles_existing  INTEGER NOT NULL DEFAULT 0,
    combined_total  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    key             TEXT PRIMARY KEY,
    name            TEXT NOT NULL DEFAULT '',
    permissions     TEXT NOT NULL DEFAULT 'read',
    consume_once    BOOLEAN NOT NULL DEFAULT FALSE,
    bound_identity  TEXT,
    revoked         BOOLEAN NOT NULL DEFAULT FALSE,
    usage_count     BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS invite_links (
    token       TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    permissions TEXT NOT NULL DEFAULT 'read',
    max_uses    INTEGER,
    use_count   INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS tops_map_chunk_urls (
    level       INTEGER NOT NULL,
    cx          INTEGER NOT NULL,
    cy          INTEGER NOT NULL,
    url         TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (level, cx, cy)
);
CREATE INDEX IF NOT EXISTS idx_tops_map_chunk_urls_expires_at
    ON tops_map_chunk_urls (expires_at);

-- Pending TOPS-map regeneration requests. The background worker drains this
-- table at the start of every generation cycle so that approvals which arrive
-- while a job is already running are not lost.
--
-- A row with full_regen=TRUE (and bbox columns NULL) means "rebuild every
-- chunk for the listed levels". Otherwise the bbox is a world-block bounding
-- box that should be re-rendered. ``levels`` is a JSON array of resolution
-- level numbers; NULL means "all configured levels".
CREATE TABLE IF NOT EXISTS regen_queue (
    id          BIGSERIAL PRIMARY KEY,
    min_x       INTEGER,
    max_x       INTEGER,
    min_z       INTEGER,
    max_z       INTEGER,
    levels      TEXT,
    full_regen  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regen_queue_created_at
    ON regen_queue (created_at);

-- Single-row table acting as a global mutex around mutations of the
-- combined map .db (approve / revert / restore). The application enforces
-- that ``id`` is always 'globalservermap'. ``expires_at`` lets a crashed
-- worker auto-release its lock after the TTL.
CREATE TABLE IF NOT EXISTS map_lock (
    id              TEXT PRIMARY KEY,
    holder_token    TEXT NOT NULL,
    holder_action   TEXT NOT NULL,
    acquired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);

-- Feature flags consulted by both backend (gating endpoints) and frontend
-- (gating UI). A flag is OFF by default if its row is missing.
CREATE TABLE IF NOT EXISTS feature_flags (
    key             TEXT PRIMARY KEY,
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_key  TEXT
);

-- Seed the well-known flags as disabled. Idempotent â€” won't overwrite
-- explicit toggles. New flags can be added by future migrations.
INSERT INTO feature_flags (key, enabled) VALUES
    ('match_score', FALSE),
    ('region_overwrite', FALSE),
    ('public_history', FALSE),
    ('weekly_backups', FALSE),
    ('per_contribution_revert', FALSE),
    ('backup_restore', FALSE),
    -- Operational kill switches. These exist so the row is visible in the
    -- admin UI; their effective default when the row is *missing* is set in
    -- the application code (see ``feature_flags.is_feature_enabled_default``).
    ('maintenance_mode', FALSE),
    ('uploads_enabled', TRUE),
    ('registration_enabled', TRUE),
    -- Heavy-compute kill switch. ON = previews + validation + match-score
    -- run normally for everyone. OFF = those operations are blocked for
    -- non-admin callers (admin bypasses the flag) so a small server can
    -- keep serving the read-only API while heavy work waits for an admin
    -- with a beefy machine to drain it via the bulk-run button.
    ('heavy_compute_enabled', TRUE),
    -- Auto map-cache regeneration after a contribution merge. ON = the
    -- approval / revert workflow kicks ``generate_map_levels`` so chunks
    -- intersecting the contributed area are re-rendered immediately.
    -- OFF = the regen request is suppressed entirely; an admin must
    -- trigger regeneration manually from the TOPS map admin panel.
    ('auto_regen_after_approval', TRUE),
    -- zstd compression for the combined map .db, weekly/manual backups,
    -- and per-contribution archives. OFF = today's behaviour (raw .db
    -- everywhere). ON = combined DB keeps a raw + .zst pair (readers
    -- prefer .zst when its x-amz-meta-source-etag matches), backups and
    -- archives are written as .zst only. See plans/zstd-compression-plan.
    ('compress_artefacts', FALSE)
ON CONFLICT (key) DO NOTHING;

-- Generic key/value settings table for non-boolean admin-tunable values
-- (compression level, thread preset, future runtime knobs). Distinct from
-- ``feature_flags`` which is bool-only. Values are JSONB so callers can
-- store small structured documents without schema churn.
CREATE TABLE IF NOT EXISTS app_settings (
    key            TEXT PRIMARY KEY,
    value          JSONB NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_key TEXT
);
"""

_MIGRATIONS_SQL = """
ALTER TABLE api_keys
ADD COLUMN IF NOT EXISTS usage_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS submitted_by_key TEXT;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS users
ADD COLUMN IF NOT EXISTS show_contributions BOOLEAN NOT NULL DEFAULT FALSE;
-- Granular per-key permission flags (e.g. 'region_overwrite'). The existing
-- TEXT ``permissions`` column ('read'/'contribute') stays as the coarse tier;
-- this JSONB carries fine-grained boolean toggles set by admins.
ALTER TABLE api_keys
ADD COLUMN IF NOT EXISTS extra_permissions JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Phase 1: async match-score result storage on contributions.
-- ``match_score_status`` is one of ('pending', 'ready', 'failed') or NULL
-- (legacy / feature disabled at submit-time). ``match_score_json`` carries
-- the full result payload when status='ready', and the failure reason when
-- status='failed'. ``match_score_attempts`` is bumped each time the worker
-- picks the row up (caps retries at the worker level).
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS match_score_status   TEXT;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS match_score_json     JSONB;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS match_score_attempts INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_contributions_match_score_status
    ON contributions (match_score_status)
    WHERE match_score_status = 'pending';

-- Phase 3: per-contribution preview retention. The approval flow promotes
-- pending preview PNGs into the public history bucket and stamps an expiry
-- here. As of the all-time history change, this column governs only the
-- per-contribution archived .db lifetime (used for revert) — the history
-- preview PNG is now kept forever and is tracked by
-- ``history_preview_uploaded_at`` below. NULL ⇒ no archive retention
-- configured (legacy rows, withdrawn contributions, or rows whose archive
-- has already been swept).
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS preview_retained_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_contributions_preview_retained_until
    ON contributions (preview_retained_until)
    WHERE preview_retained_until IS NOT NULL;

-- All-time history: timestamp at which the preview PNG was promoted into
-- the ``history/<id>.png`` bucket. Drives visibility in the "Recent
-- contributions" grid (set ⇒ row appears, no time window). The PNG itself
-- is kept indefinitely; the daily cleanup task no longer touches it.
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS history_preview_uploaded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_contributions_history_preview_uploaded_at
    ON contributions (history_preview_uploaded_at)
    WHERE history_preview_uploaded_at IS NOT NULL;
-- Backfill from rows that currently have a non-null preview_retained_until
-- (those are the rows whose preview is still in R2 at migration time).
UPDATE contributions
   SET history_preview_uploaded_at = COALESCE(approved_at, withdrawn_at, now())
 WHERE history_preview_uploaded_at IS NULL
   AND preview_retained_until IS NOT NULL;

-- Phase 4a: TOTP 2FA enrolment for admin keys. The secret is stored
-- encrypted (Fernet, key from TOTP_ENCRYPTION_KEY env var). NULL means
-- the admin has not enrolled yet — destructive operations gated by TOTP
-- will respond with 401 totp_required until they enrol.
ALTER TABLE api_keys
ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT;
ALTER TABLE api_keys
ADD COLUMN IF NOT EXISTS totp_enrolled_at TIMESTAMPTZ;

-- Phase 4b: per-contribution revert. The capture metadata records what
-- was written to R2 ``undo/<id>.added.bin`` (positions inserted by this
-- contribution) and ``undo/<id>.replaced.db`` (positions overwritten in
-- region/overwrite mode). ``revert_supported`` is FALSE when the capture
-- could not be persisted (e.g. the added.bin would have exceeded the
-- size cap) or for legacy contributions that pre-date the feature.
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS revert_supported BOOLEAN;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS revert_added_count INTEGER;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS revert_replaced_count INTEGER;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS reverted_by_key TEXT;
-- Affected world-block bounds, captured on approval and reused by the
-- revert endpoint to enqueue a partial TOPS regen.
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS affected_min_x INTEGER;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS affected_max_x INTEGER;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS affected_min_z INTEGER;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS affected_max_z INTEGER;

-- Phase 2: region-restricted updates. NULL on all four columns ⇒ legacy
-- gap-fill mode (the default). Otherwise ``(min_x, max_x, min_z, max_z)``
-- is a world-block bounding box; on approval the merge replaces every tile
-- inside the region with the upload's version (and captures the previous
-- bytes into ``undo/<id>.replaced.db`` so revert remains surgical). Tiles
-- outside the region are untouched.
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS update_region_min_x INTEGER;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS update_region_max_x INTEGER;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS update_region_min_z INTEGER;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS update_region_max_z INTEGER;
CREATE INDEX IF NOT EXISTS idx_contributions_update_region
    ON contributions (update_region_min_x)
    WHERE update_region_min_x IS NOT NULL;

-- Invite-link traceability: record which invite minted each API key so
-- admins can audit who claimed a given link. NULL for keys created via
-- the admin route or the legacy paths that pre-date this column.
ALTER TABLE api_keys
ADD COLUMN IF NOT EXISTS source_invite_token TEXT
    REFERENCES invite_links(token) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_source_invite_token
    ON api_keys (source_invite_token)
    WHERE source_invite_token IS NOT NULL;

-- Phase 4c: WebAuthn (passkey) credentials for admin keys. Acts as a second
-- factor on top of the API key: an admin must complete a passkey assertion
-- after pasting their key before they can call admin routes. One admin key
-- may register multiple passkeys (e.g. laptop + YubiKey + phone). The
-- credential ID and public key come straight from the authenticator; we
-- never see or store any private material.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              BIGSERIAL PRIMARY KEY,
    api_key         TEXT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    credential_id   BYTEA NOT NULL UNIQUE,
    public_key      BYTEA NOT NULL,
    sign_count      BIGINT NOT NULL DEFAULT 0,
    transports      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_api_key
    ON webauthn_credentials (api_key);

-- Async upload validation. The /contribute/complete handler used to
-- synchronously download the entire pending .db (potentially multi-GB) and
-- run SELECT COUNT(*) before returning, which blew through Render's request
-- timeout on small instances. Now /complete only does a cheap range-read of
-- the SQLite header and returns immediately; the heavy table-existence
-- check, tile count, and region-tile count are done by the
-- ``backend.app.tasks.validate_uploads`` worker.
--
-- ``validation_status`` is one of ('pending', 'valid') or NULL. NULL means
-- "legacy / already validated" (existing rows pre-dating this column are
-- treated as valid). On invalid uploads the row is deleted entirely (and
-- the R2 object with it), so 'invalid' is never persisted. ``attempts`` is
-- bumped each time the worker picks the row up so we can stop after a cap.
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS validation_status   TEXT;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS validation_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS validation_error    TEXT;
CREATE INDEX IF NOT EXISTS idx_contributions_validation_status
    ON contributions (validation_status)
    WHERE validation_status = 'pending';

-- Async approval. The merge of a pending contribution into the combined map
-- can take longer than Render's edge HTTP timeout (~100 s) on large
-- combined maps, since it needs to download globalservermap.db, run the
-- SQLite merge, and upload it back. /contribute/{id}/approve therefore
-- enqueues by setting ``approval_status='queued'`` and returns 202; the
-- ``backend.app.tasks.approve_contribution`` worker drains queued rows and
-- performs the actual merge.
--
-- Values: NULL (legacy / never queued), 'queued', 'running', 'failed'.
-- Successful approval clears these (or sets them to NULL implicitly via
-- the existing ``mark_approved`` flip of ``status``).
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS approval_status   TEXT;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS approval_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS approval_error    TEXT;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS approval_requested_by_key TEXT;
CREATE INDEX IF NOT EXISTS idx_contributions_approval_status
    ON contributions (approval_status)
    WHERE approval_status IN ('queued', 'running');

-- Per-contribution revert is also async: the merge re-uploads
-- ``globalservermap.db`` and on a multi-GB combined map that easily
-- exceeds Render's edge HTTP timeout (~100 s). The admin endpoint
-- ``/api/admin/contributions/{id}/revert`` therefore enqueues by setting
-- ``revert_status='queued'`` and returns 202; the
-- ``backend.app.tasks.revert_contribution`` worker drains the queue and
-- performs the actual undo. A backend restart mid-revert is recovered by
-- ``reset_running_reverts()`` (the merge holds ``map_lock`` for the
-- duration so resuming after a crash is safe).
--
-- Values: NULL (never reverted), 'queued', 'running', 'failed'.
-- Successful revert clears these (or leaves them NULL via the existing
-- ``mark_reverted`` flip of ``status``).
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS revert_status   TEXT;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS revert_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS revert_error    TEXT;
ALTER TABLE contributions
ADD COLUMN IF NOT EXISTS revert_requested_by_key TEXT;
CREATE INDEX IF NOT EXISTS idx_contributions_revert_status
    ON contributions (revert_status)
    WHERE revert_status IN ('queued', 'running');

-- Maintenance notices. One row per known component (e.g. ``tops_map_viewer``).
-- Active=TRUE means the public chip should be shown; ``eta_at`` is the
-- admin's best guess for when the maintenance will be over and is used by
-- the frontend to render a live countdown (or "X minutes ago" once it's
-- elapsed). The row is preserved when the admin turns the notice off so
-- the previous message/eta are still visible in the admin history.
CREATE TABLE IF NOT EXISTS maintenance_notices (
    component       TEXT PRIMARY KEY,
    active          BOOLEAN NOT NULL DEFAULT FALSE,
    message         TEXT NOT NULL DEFAULT '',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    eta_at          TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_notices_active
    ON maintenance_notices (active) WHERE active;

-- Public landing page can offer to claim a key from a single "default"
-- invite link when a visitor lands on the site without an invite URL or a
-- saved API key (and after they've accepted browser-storage consent). At
-- most one invite link can be marked default-public at a time; the partial
-- unique index below enforces that. Toggled via PATCH /admin/invite-links.
ALTER TABLE invite_links
ADD COLUMN IF NOT EXISTS is_default_public BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_links_default_public
    ON invite_links ((is_default_public)) WHERE is_default_public = TRUE;
"""

# ---------------------------------------------------------------------------
# Account system schema (users, ip_bans, user_flags, admin_audit_log).
# Created in a separate block so the trigram extension is enabled before the
# GIN indexes that depend on it.
# ---------------------------------------------------------------------------
# THIS WILL NOT BE UPDATED ANYMORE, USE THE ALEMBIC MIGRATION SYSTEM FOR FUTURE CHANGES TO THE DATABASE

_ACCOUNT_SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
    api_key                TEXT PRIMARY KEY REFERENCES api_keys(key) ON DELETE CASCADE,
    display_name           TEXT NOT NULL UNIQUE,
    in_game_name           TEXT,
    is_hireable            BOOLEAN NOT NULL DEFAULT FALSE,
    is_leaderboard_visible BOOLEAN NOT NULL DEFAULT FALSE,
    show_contributions     BOOLEAN NOT NULL DEFAULT FALSE,
    genesis_for_ip         BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    terms_accepted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    terms_version          TEXT NOT NULL DEFAULT 'unknown',
    deleted_at             TIMESTAMPTZ,
    name_regen_count       INT NOT NULL DEFAULT 0,
    last_name_change_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_joined_at         ON users (joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_hireable          ON users (is_hireable) WHERE is_hireable;
CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm ON users USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_ingame_trgm       ON users USING gin (in_game_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS ip_bans (
    ip_hash      TEXT PRIMARY KEY,
    reason_code  TEXT NOT NULL,
    reason       TEXT NOT NULL,
    admin_notes  TEXT,
    banned_by    TEXT NOT NULL,
    banned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ip_bans_expires_at ON ip_bans (expires_at);

CREATE TABLE IF NOT EXISTS user_flags (
    id            BIGSERIAL PRIMARY KEY,
    flagged_user  TEXT NOT NULL REFERENCES users(api_key) ON UPDATE CASCADE ON DELETE CASCADE,
    related_user  TEXT REFERENCES users(api_key) ON UPDATE CASCADE ON DELETE SET NULL,
    reason        TEXT NOT NULL,
    metadata      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ,
    resolved_by   TEXT,
    resolution    TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_flags_unresolved
    ON user_flags (flagged_user) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_flags_created
    ON user_flags (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id         BIGSERIAL PRIMARY KEY,
    admin_key  TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT,
    metadata   JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_log (created_at DESC);

-- Shareable, time-limited download links for R2 backup objects. Each link
-- is multi-use until it expires or is revoked; per-redeem details live in
-- backup_download_log so the admin UI can surface who has been pulling
-- the file.
CREATE TABLE IF NOT EXISTS backup_download_links (
    id          BIGSERIAL PRIMARY KEY,
    token       TEXT NOT NULL UNIQUE,
    backup_key  TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    revoked_by  TEXT,
    label       TEXT
);

CREATE INDEX IF NOT EXISTS idx_bdl_token  ON backup_download_links (token);
CREATE INDEX IF NOT EXISTS idx_bdl_active ON backup_download_links (expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS backup_download_log (
    id             BIGSERIAL PRIMARY KEY,
    link_id        BIGINT NOT NULL REFERENCES backup_download_links(id) ON DELETE CASCADE,
    redeemed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_hash        TEXT,
    user_agent     TEXT,
    success        BOOLEAN NOT NULL,
    failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_bdlog_link ON backup_download_log (link_id, redeemed_at DESC);

-- Resources-overlay async upload jobs.
--
-- ``POST /admin/resources/upload`` returns immediately after the .zip is
-- spooled to local disk. A daemon thread then unpacks it into R2 and
-- mutates this row so the FE can poll for live progress (file count + bytes
-- + phase) instead of staring at a stuck 95% bar while the server fans
-- thousands of small PUTs out to R2.
--
-- ``status`` is one of: 'unpacking' | 'swapping' | 'complete' | 'failed'.
-- ``phase`` is a free-form human-readable string for the UI.
CREATE TABLE IF NOT EXISTS resources_upload_jobs (
    id              TEXT PRIMARY KEY,
    seed            TEXT NOT NULL,
    vs_version      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'unpacking',
    phase           TEXT,
    total_files     INTEGER NOT NULL DEFAULT 0,
    processed_files INTEGER NOT NULL DEFAULT 0,
    total_bytes     BIGINT NOT NULL DEFAULT 0,
    uploaded_bytes  BIGINT NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_resources_jobs_recent
    ON resources_upload_jobs (created_at DESC);
"""


def ensure_schema():
    """Create tables if they don't exist. Safe to call multiple times."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL)
            # Backfill schema changes for existing deployments.
            cur.execute(_MIGRATIONS_SQL)
            # Account-system tables (users, ip_bans, user_flags, audit log).
            cur.execute(_ACCOUNT_SCHEMA_SQL)
            # Migration: ensure user_flags FKs have ON UPDATE CASCADE so admin
            # rekey (which updates users.api_key) does not violate the FK.
            cur.execute("""
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.referential_constraints
                        WHERE constraint_name = 'user_flags_flagged_user_fkey'
                          AND update_rule <> 'CASCADE'
                    ) THEN
                        ALTER TABLE user_flags
                            DROP CONSTRAINT user_flags_flagged_user_fkey,
                            ADD CONSTRAINT user_flags_flagged_user_fkey
                                FOREIGN KEY (flagged_user) REFERENCES users(api_key)
                                ON UPDATE CASCADE ON DELETE CASCADE;
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM information_schema.referential_constraints
                        WHERE constraint_name = 'user_flags_related_user_fkey'
                          AND update_rule <> 'CASCADE'
                    ) THEN
                        ALTER TABLE user_flags
                            DROP CONSTRAINT user_flags_related_user_fkey,
                            ADD CONSTRAINT user_flags_related_user_fkey
                                FOREIGN KEY (related_user) REFERENCES users(api_key)
                                ON UPDATE CASCADE ON DELETE SET NULL;
                    END IF;
                END$$;
            """)


# ---------------------------------------------------------------------------
# Contributions CRUD
# ---------------------------------------------------------------------------

def create_contribution(
    cid: str,
    contributor: str,
    tile_count: int,
    api_key: str = "",
    *,
    validation_status: Optional[str] = None,
):
    """Insert a new pending contribution row.

    ``validation_status`` controls async validation:
      * ``None`` (default): row is treated as already validated (legacy /
        callers that did synchronous validation themselves).
      * ``'pending'``: the ``validate_uploads`` worker will pick the row up,
        download the file, count tiles, and either flip status to ``'valid'``
        and update ``tile_count`` — or delete the row + R2 object on failure.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO contributions
                       (id, contributor, tile_count, status, submitted_by_key,
                        validation_status)
                   VALUES (%s, %s, %s, 'pending', %s, %s)""",
                (cid, contributor or "Anonymous", tile_count, api_key or None,
                 validation_status),
            )


def set_update_region(
    cid: str,
    region: Optional[tuple],
) -> None:
    """Persist the Phase-2 region bounds (or clear them when ``region`` is None).

    ``region`` is ``(min_x, max_x, min_z, max_z)`` in world-block coordinates.
    When set, the approval merge replaces in-region tiles with the upload's
    bytes (rather than gap-filling).
    """
    if region is None:
        min_x = max_x = min_z = max_z = None
    else:
        min_x, max_x, min_z, max_z = region
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET update_region_min_x = %s,
                           update_region_max_x = %s,
                           update_region_min_z = %s,
                           update_region_max_z = %s
                   WHERE id = %s""",
                (min_x, max_x, min_z, max_z, cid),
            )


def get_update_region(cid: str) -> Optional[tuple]:
    """Return ``(min_x, max_x, min_z, max_z)`` or None if the contribution has
    no Phase-2 region attached (legacy gap-fill)."""
    row = get_contribution(cid)
    if not row or row.get("update_region_min_x") is None:
        return None
    return (
        int(row["update_region_min_x"]),
        int(row["update_region_max_x"]),
        int(row["update_region_min_z"]),
        int(row["update_region_max_z"]),
    )


def get_contribution(cid: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM contributions WHERE id = %s", (cid,))
            row = cur.fetchone()
            return dict(row) if row else None


def get_user_pending_contribution(api_key: str) -> Optional[dict]:
    """Return the most recent pending (non-withdrawn) contribution submitted by api_key, or None."""
    if not api_key:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT * FROM contributions
                   WHERE submitted_by_key = %s AND status = 'pending' AND withdrawn_at IS NULL
                   ORDER BY created_at DESC
                   LIMIT 1""",
                (api_key,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def get_user_last_approval(api_key: str) -> Optional[dict]:
    """Return the most recent approved contribution submitted by api_key, or None."""
    if not api_key:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT * FROM contributions
                   WHERE submitted_by_key = %s AND status = 'approved'
                   ORDER BY approved_at DESC NULLS LAST
                   LIMIT 1""",
                (api_key,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def list_pending_contributions(requesting_key: str = "") -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM contributions WHERE status = 'pending' ORDER BY created_at"
            )
            rows = [dict(r) for r in cur.fetchall()]
    for row in rows:
        row["is_mine"] = bool(requesting_key and row.get("submitted_by_key") == requesting_key)
    return rows


def list_withdrawn_contributions(requesting_key: str = "") -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM contributions WHERE status = 'withdrawn' ORDER BY withdrawn_at DESC"
            )
            rows = [dict(r) for r in cur.fetchall()]
    for row in rows:
        row["is_mine"] = bool(requesting_key and row.get("submitted_by_key") == requesting_key)
    return rows


def withdraw_contribution(cid: str, api_key: str) -> bool:
    """Soft-delete a pending contribution owned by api_key.
    Anonymises the contributor name and marks as withdrawn.
    Returns True if the row was updated, False if not found/not owned.

    Also clears ``validation_status`` so the async ``validate_uploads``
    worker stops treating the row as a pending validation job — otherwise
    it would re-claim the row indefinitely (bumping attempts → hitting
    the cap → being "revived" by ``reset_stuck_validations`` on every
    restart).
    """
    now = datetime.now(timezone.utc)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                   SET status = 'withdrawn',
                       contributor = '[Withdrawn]',
                       withdrawn_at = %s,
                       validation_status = NULL,
                       validation_error  = NULL
                   WHERE id = %s AND status = 'pending' AND submitted_by_key = %s""",
                (now, cid, api_key),
            )
            return cur.rowcount > 0


def mark_approved(cid: str, tiles_new: int, tiles_existing: int, combined_total: int):
    now = datetime.now(timezone.utc)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                   SET status = 'approved', approved_at = %s,
                       tiles_new = %s, tiles_existing = %s, combined_total = %s
                   WHERE id = %s""",
                (now, tiles_new, tiles_existing, combined_total, cid),
            )
            cur.execute(
                """INSERT INTO contribution_log
                       (id, contributor, approved_at, tiles_new, tiles_existing, combined_total)
                   SELECT id, contributor, %s, %s, %s, %s
                   FROM contributions WHERE id = %s""",
                (now, tiles_new, tiles_existing, combined_total, cid),
            )


def delete_contribution(cid: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM contributions WHERE id = %s", (cid,))


def get_approved_log(limit: int = 20) -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM contribution_log ORDER BY approved_at DESC LIMIT %s",
                (limit,),
            )
            return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Phase 3 — Public contribution history
# ---------------------------------------------------------------------------

def set_preview_retained_until(cid: str, retained_until: Optional[datetime]) -> None:
    """Stamp the archive-.db retention deadline on a contribution row.
    Called by the approval flow with a future deadline and by the cleanup
    task with ``None`` once the archived .db has been removed from R2.

    Note: this column no longer governs the history preview PNG — that is
    kept indefinitely once ``history_preview_uploaded_at`` is set.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE contributions SET preview_retained_until = %s WHERE id = %s",
                (retained_until, cid),
            )


def set_history_preview_uploaded_at(
    cid: str, uploaded_at: Optional[datetime]
) -> None:
    """Stamp the timestamp at which the preview PNG was promoted into the
    ``history/<id>.png`` bucket. A non-null value makes the contribution
    visible in the "Recent contributions" grid forever.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE contributions SET history_preview_uploaded_at = %s WHERE id = %s",
                (uploaded_at, cid),
            )


def list_history_contributions(
    *,
    since: Optional[datetime] = None,
    include_withdrawn: bool = True,
    limit: int = 50,
    offset: int = 0,
) -> List[dict]:
    """Return contributions whose preview is in the public history bucket.

    Used by ``/contribute/info`` to populate the public "Recent contributions"
    grid. Includes both ``approved`` and (if ``include_withdrawn``) ``withdrawn``
    rows whose preview PNG was uploaded to ``history/<id>.png``. Previews are
    retained indefinitely; there is no time window.

    ``since`` optionally filters to rows whose terminal event (approval /
    withdrawal) happened on or after the given timestamp. Pass ``None`` for
    the all-time view.
    """
    statuses = ["approved", "withdrawn"] if include_withdrawn else ["approved"]
    placeholders = ",".join(["%s"] * len(statuses))
    sql = (
        f"SELECT * FROM contributions "
        f"WHERE status IN ({placeholders}) "
        f"  AND history_preview_uploaded_at IS NOT NULL "
    )
    params: List = list(statuses)
    if since is not None:
        sql += "  AND COALESCE(approved_at, withdrawn_at) >= %s "
        params.append(since)
    sql += "ORDER BY COALESCE(approved_at, withdrawn_at) DESC LIMIT %s OFFSET %s"
    params.extend([limit, offset])
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]


def count_history_contributions(
    *,
    since: Optional[datetime] = None,
    include_withdrawn: bool = True,
) -> int:
    """Count rows that ``list_history_contributions`` would return without
    pagination. Used to power admin pagination controls."""
    statuses = ["approved", "withdrawn"] if include_withdrawn else ["approved"]
    placeholders = ",".join(["%s"] * len(statuses))
    sql = (
        f"SELECT COUNT(*) FROM contributions "
        f"WHERE status IN ({placeholders}) "
        f"  AND history_preview_uploaded_at IS NOT NULL "
    )
    params: List = list(statuses)
    if since is not None:
        sql += "  AND COALESCE(approved_at, withdrawn_at) >= %s "
        params.append(since)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            return int(row[0]) if row else 0


def list_expired_history_contributions(limit: int = 500) -> List[dict]:
    """Rows whose archived ``.db`` retention has elapsed. The cleanup task
    deletes ``archived/<id>.db`` from R2 and clears ``preview_retained_until``
    so the row is not re-processed on the next sweep. The history preview
    PNG is *not* affected — it is kept forever."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, status FROM contributions
                       WHERE preview_retained_until IS NOT NULL
                         AND preview_retained_until <= now()
                       ORDER BY preview_retained_until
                       LIMIT %s""",
                (limit,),
            )
            return [dict(r) for r in cur.fetchall()]


def list_active_archived_contributions(limit: Optional[int] = None) -> List[dict]:
    """Rows that still have a live ``archived/<id>.db`` (or .zst) in R2 —
    i.e. ``preview_retained_until`` is in the future. Used by the eager
    compression migration runner to know which archives to convert when
    the ``compress_artefacts`` flag is flipped ON."""
    sql = (
        "SELECT id FROM contributions "
        " WHERE preview_retained_until IS NOT NULL "
        "   AND preview_retained_until > now() "
        " ORDER BY id"
    )
    params: tuple = ()
    if limit is not None:
        sql += " LIMIT %s"
        params = (int(limit),)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]


def mark_contributions_orphaned_by_restore(approved_after: datetime) -> int:
    """Flip ``status`` from 'approved' to 'orphaned_by_restore' for every
    contribution whose ``approved_at`` is strictly after ``approved_after``.

    Used by Phase 4a backup-restore: contributions merged into the combined
    .db after the snapshot was taken are no longer present in the restored
    map, so the auditor needs to know they were lost.

    Also drops their ``contribution_log`` rows so they stop appearing in
    the public "Approved Contributions" feed (`get_approved_log`). Both
    statements run in a single transaction.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET status = 'orphaned_by_restore'
                       WHERE status = 'approved'
                         AND approved_at IS NOT NULL
                         AND approved_at > %s""",
                (approved_after,),
            )
            affected = int(cur.rowcount or 0)
            if affected:
                cur.execute(
                    """DELETE FROM contribution_log
                           WHERE id IN (
                               SELECT id FROM contributions
                                WHERE status = 'orphaned_by_restore'
                                  AND approved_at IS NOT NULL
                                  AND approved_at > %s
                           )""",
                    (approved_after,),
                )
            return affected

def count_user_withdrawals_in_iso_week(api_key: str, week_start: datetime) -> int:
    """Count this user's withdrawals since the start of the current ISO week.

    The contribution-improvement plan caps non-admin contributors to 3
    withdrawals per ISO week to break the
    "withdraw → reupload → withdraw" preview-spam loop.
    """
    if not api_key:
        return 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT COUNT(*) FROM contributions
                       WHERE submitted_by_key = %s
                         AND status = 'withdrawn'
                         AND withdrawn_at >= %s""",
                (api_key, week_start),
            )
            row = cur.fetchone()
            return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Phase 4b — per-contribution revert
# ---------------------------------------------------------------------------

def set_revert_metadata(
    cid: str,
    *,
    revert_supported: bool,
    added_count: int,
    replaced_count: int,
    affected_bounds: Optional[tuple] = None,
) -> None:
    """Persist the capture metadata produced by the approval merge.

    ``affected_bounds`` is ``(min_x, max_x, min_z, max_z)`` in world-block
    coordinates or ``None`` (full-regen / unknown). The revert endpoint
    re-uses these to enqueue a partial TOPS regen without re-deriving them.
    """
    if affected_bounds is None:
        min_x = max_x = min_z = max_z = None
    else:
        min_x, max_x, min_z, max_z = affected_bounds
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET revert_supported      = %s,
                           revert_added_count    = %s,
                           revert_replaced_count = %s,
                           affected_min_x        = %s,
                           affected_max_x        = %s,
                           affected_min_z        = %s,
                           affected_max_z        = %s
                   WHERE id = %s""",
                (revert_supported, added_count, replaced_count,
                 min_x, max_x, min_z, max_z, cid),
            )


def mark_reverted(cid: str, reverted_by_key: str) -> bool:
    """Flip a contribution's status to 'reverted' and stamp the actor.

    Also removes the matching ``contribution_log`` row so the contribution
    no longer appears in the public "Approved Contributions" feed served
    by ``get_approved_log`` (the contribute page's `info.approved` list).
    Both updates run in the same transaction so the visible state stays
    consistent.
    """
    now = datetime.now(timezone.utc)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET status = 'reverted',
                           reverted_at = %s,
                           reverted_by_key = %s
                   WHERE id = %s AND status = 'approved'""",
                (now, reverted_by_key or None, cid),
            )
            updated = (cur.rowcount or 0) > 0
            if updated:
                # Drop the public approval-log entry. Safe even if absent
                # (older rows pre-dating the log table won't have one).
                cur.execute(
                    "DELETE FROM contribution_log WHERE id = %s",
                    (cid,),
                )
            return updated


def list_later_region_overwrites(
    cid: str,
    affected_bounds: Optional[tuple],
) -> List[dict]:
    """Return approved region-overwrite contributions whose region overlaps
    the given bounds and which were approved AFTER ``cid``.

    Used by the cascading-revert logic: their ``replaced.db`` defines the
    set of positions that the revert must NOT delete or restore (those
    positions are now owned by the later contribution).

    Today (Phase 2 not yet shipped) every contribution is gap-fill, so this
    always returns ``[]``. Once Phase 2 lands and ``contributions`` carries
    ``update_region_*`` columns, this helper is the single source of truth
    for the conflict set.
    """
    if affected_bounds is None:
        return []
    # Phase 2 region columns are not yet present in the schema. Probe for
    # them so the helper degrades gracefully on pre-Phase-2 databases.
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'contributions'
                         AND column_name = 'update_region_min_x'"""
            )
            if cur.fetchone() is None:
                return []
        rmin_x, rmax_x, rmin_z, rmax_z = affected_bounds
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, approved_at,
                          update_region_min_x, update_region_max_x,
                          update_region_min_z, update_region_max_z
                       FROM contributions AS c
                       WHERE c.status = 'approved'
                         AND c.id <> %s
                         AND c.update_region_min_x IS NOT NULL
                         AND c.approved_at > (
                             SELECT approved_at FROM contributions WHERE id = %s
                         )
                         AND NOT (
                             c.update_region_max_x < %s
                             OR c.update_region_min_x > %s
                             OR c.update_region_max_z < %s
                             OR c.update_region_min_z > %s
                         )""",
                (cid, cid, rmin_x, rmax_x, rmin_z, rmax_z),
            )
            return [dict(r) for r in cur.fetchall()]




# ---------------------------------------------------------------------------
# Phase 1 — Match-score helpers
# ---------------------------------------------------------------------------

# Worker caps to avoid hammering R2 forever on a permanently-broken row.
MATCH_SCORE_MAX_ATTEMPTS = 3


def set_match_score_pending(cid: str) -> None:
    """Mark a contribution as awaiting async scoring. Resets the result blob
    and bumps attempts so the worker can stop after MAX_ATTEMPTS."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET match_score_status = 'pending',
                           match_score_json   = NULL,
                           match_score_attempts = match_score_attempts + 1
                   WHERE id = %s""",
                (cid,),
            )


def set_match_score_ready(cid: str, result: dict) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET match_score_status = 'ready',
                           match_score_json   = %s::jsonb
                   WHERE id = %s""",
                (json.dumps(result), cid),
            )


def set_match_score_failed(cid: str, reason: str) -> None:
    payload = {"reason": (reason or "")[:500]}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET match_score_status = 'failed',
                           match_score_json   = %s::jsonb
                   WHERE id = %s""",
                (json.dumps(payload), cid),
            )


def claim_pending_match_score_job() -> Optional[dict]:
    """Atomically pick one pending match-score row whose attempts haven't
    exceeded the cap. Returns ``{id, attempts}`` or None when the queue
    is empty.

    Uses ``FOR UPDATE SKIP LOCKED`` so multiple workers / processes can
    safely race on the same table.
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, match_score_attempts
                       FROM contributions
                       WHERE match_score_status = 'pending'
                         AND match_score_attempts <= %s
                       ORDER BY created_at
                       LIMIT 1
                       FOR UPDATE SKIP LOCKED""",
                (MATCH_SCORE_MAX_ATTEMPTS,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def has_pending_match_score_jobs() -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT 1 FROM contributions
                       WHERE match_score_status = 'pending'
                         AND match_score_attempts <= %s
                       LIMIT 1""",
                (MATCH_SCORE_MAX_ATTEMPTS,),
            )
            return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# Async upload validation helpers (see backend.app.tasks.validate_uploads)
# ---------------------------------------------------------------------------

VALIDATION_MAX_ATTEMPTS = 3


# Sentinel prefix written to ``validation_error`` at claim time. Acts as a
# breadcrumb: if the worker process is killed mid-validation (OOM, dyno
# restart, kernel SIGKILL) the row is left with this string instead of NULL,
# so the next ``kick_on_startup`` can recognise the row as a zombie and
# revive it. Both worker code paths (success / explicit failure) overwrite
# or clear this value, so it never sticks around for cleanly-completed runs.
VALIDATION_INFLIGHT_PREFIX = "in-flight: attempt "


def claim_pending_validation_job() -> Optional[dict]:
    """Atomically claim one ``validation_status='pending'`` row whose
    attempts haven't exceeded the cap. Returns ``{id, attempts, region}``
    or None when the queue is empty. Bumps ``validation_attempts`` so a
    permanently-broken row eventually stops retrying, and records an
    ``in-flight`` breadcrumb in ``validation_error`` so a SIGKILL-ed worker
    leaves a trace ``reset_stuck_validations`` can find on the next boot."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE contributions
                       SET validation_attempts = validation_attempts + 1,
                           validation_error    = %s || (validation_attempts + 1)::text
                                                    || ' started at '
                                                    || NOW()::text
                   WHERE id = (
                       SELECT id FROM contributions
                           WHERE validation_status = 'pending'
                             AND status = 'pending'
                             AND validation_attempts < %s
                           ORDER BY created_at
                           LIMIT 1
                           FOR UPDATE SKIP LOCKED
                   )
                   RETURNING id, validation_attempts,
                             update_region_min_x, update_region_max_x,
                             update_region_min_z, update_region_max_z""",
                (VALIDATION_INFLIGHT_PREFIX, VALIDATION_MAX_ATTEMPTS),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def reset_stuck_validations() -> int:
    """Revive contributions whose validation worker was killed mid-flight.

    A row is considered stuck when it is still ``validation_status='pending'``
    AND ``validation_attempts >= VALIDATION_MAX_ATTEMPTS``. The cleanly-
    failing worker path always deletes the row + R2 object before this
    state is reachable, so any survivor must have been SIGKILL-ed before
    its ``except`` handler ran (typically OOM or dyno restart on Render's
    starter tier while downloading a multi-GB pending DB).

    Resets ``validation_attempts`` to 0 and clears the breadcrumb error so
    the worker picks the row up again. Returns the number of rows revived.
    Safe to call on every startup."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET validation_attempts = 0,
                           validation_error    = NULL
                   WHERE validation_status = 'pending'
                     AND validation_attempts >= %s""",
                (VALIDATION_MAX_ATTEMPTS,),
            )
            return cur.rowcount or 0


def has_pending_validation_jobs() -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT 1 FROM contributions
                       WHERE validation_status = 'pending'
                         AND validation_attempts < %s
                       LIMIT 1""",
                (VALIDATION_MAX_ATTEMPTS,),
            )
            return cur.fetchone() is not None


def clear_validation_status(cid: str) -> None:
    """Null out ``validation_status`` and ``validation_error`` for a row.

    Used by the validate-uploads worker to retire rows whose contribution
    ``status`` is no longer ``'pending'`` (typically: withdrawn between
    claim and processing). Without this, the worker would keep claiming
    the row on every attempt + every ``reset_stuck_validations`` revival,
    producing the "skipping … no longer pending" log spam forever.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET validation_status = NULL,
                           validation_error  = NULL
                   WHERE id = %s""",
                (cid,),
            )


def set_validation_valid(cid: str, tile_count: int) -> None:
    """Mark a contribution as validated and update its tile count."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET validation_status = 'valid',
                           validation_error  = NULL,
                           tile_count        = %s
                   WHERE id = %s""",
                (int(tile_count), cid),
            )


def set_validation_error(cid: str, reason: str) -> None:
    """Record a validation failure reason without deleting the row.

    Used when the worker has retries remaining; once attempts hit the cap
    the caller should delete the row + R2 object instead.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET validation_error = %s
                   WHERE id = %s""",
                ((reason or "")[:500], cid),
            )


# ---------------------------------------------------------------------------
# Async approval helpers (see backend.app.tasks.approve_contribution)
# ---------------------------------------------------------------------------

APPROVAL_MAX_ATTEMPTS = 3


def enqueue_approval(cid: str, requested_by_key: str = "") -> bool:
    """Mark a pending contribution as queued for async approval.

    Returns True if the row was updated (was 'pending' status with no
    in-flight approval), False if the row is already being approved or
    isn't eligible. Also resets ``approval_error`` and bumps
    ``approval_attempts`` back to 0 so a retry after a previous failure
    starts from a clean slate.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET approval_status   = 'queued',
                           approval_attempts = 0,
                           approval_error    = NULL,
                           approval_requested_by_key = %s
                   WHERE id = %s
                     AND status = 'pending'
                     AND (approval_status IS NULL
                          OR approval_status = 'failed')""",
                (requested_by_key or None, cid),
            )
            return cur.rowcount > 0


def claim_pending_approval_job() -> Optional[dict]:
    """Atomically claim one queued approval. Bumps attempts and flips status
    to ``'running'`` so /info viewers see "Merging…". Returns the full row
    or None when the queue is empty."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE contributions
                       SET approval_status   = 'running',
                           approval_attempts = approval_attempts + 1
                   WHERE id = (
                       SELECT id FROM contributions
                           WHERE approval_status = 'queued'
                             AND status = 'pending'
                             AND approval_attempts < %s
                           ORDER BY created_at
                           LIMIT 1
                           FOR UPDATE SKIP LOCKED
                   )
                   RETURNING *""",
                (APPROVAL_MAX_ATTEMPTS,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def has_pending_approval_jobs() -> bool:
    """True when there is at least one row needing the worker."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT 1 FROM contributions
                       WHERE approval_status IN ('queued', 'running')
                         AND status = 'pending'
                         AND approval_attempts < %s
                       LIMIT 1""",
                (APPROVAL_MAX_ATTEMPTS,),
            )
            return cur.fetchone() is not None


def reset_running_approvals() -> int:
    """Re-queue any rows left in 'running' from a previous process. Called
    from the startup hook so a backend restart mid-merge picks up where it
    left off (the merge itself is idempotent: ``map_lock`` and the
    INSERT-OR-IGNORE driven gap-fill make a re-run safe). Returns the
    number of rows reset."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET approval_status = 'queued'
                   WHERE approval_status = 'running'
                     AND status = 'pending'""",
            )
            return cur.rowcount


def set_approval_failed(cid: str, reason: str) -> None:
    """Record an approval failure. The row stays ``status='pending'`` so an
    admin can retry. ``approval_error`` is what the admin UI surfaces."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET approval_status = 'failed',
                           approval_error  = %s
                   WHERE id = %s""",
                ((reason or "")[:500], cid),
            )


def clear_approval_state(cid: str) -> None:
    """Clear approval bookkeeping after a successful merge. Called by the
    worker right after ``mark_approved`` so historical rows don't keep the
    transient 'running' / attempts noise."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET approval_status   = NULL,
                           approval_attempts = 0,
                           approval_error    = NULL
                   WHERE id = %s""",
                (cid,),
            )


# ---------------------------------------------------------------------------
# Async revert helpers (see backend.app.tasks.revert_contribution)
# ---------------------------------------------------------------------------

REVERT_MAX_ATTEMPTS = 3


def enqueue_revert(cid: str, requested_by_key: str = "") -> bool:
    """Mark an approved contribution as queued for async revert.

    Returns True if the row was updated (was 'approved' status with no
    in-flight revert), False if it's already being reverted, has been
    reverted, or isn't eligible. Resets ``revert_error`` and bumps
    ``revert_attempts`` back to 0 so a retry after a previous failure
    starts from a clean slate.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET revert_status   = 'queued',
                           revert_attempts = 0,
                           revert_error    = NULL,
                           revert_requested_by_key = %s
                   WHERE id = %s
                     AND status = 'approved'
                     AND (revert_status IS NULL
                          OR revert_status = 'failed')""",
                (requested_by_key or None, cid),
            )
            return cur.rowcount > 0


def claim_pending_revert_job() -> Optional[dict]:
    """Atomically claim one queued revert. Bumps attempts and flips status
    to 'running'. Returns the full row or None when the queue is empty."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE contributions
                       SET revert_status   = 'running',
                           revert_attempts = revert_attempts + 1
                   WHERE id = (
                       SELECT id FROM contributions
                           WHERE revert_status = 'queued'
                             AND status = 'approved'
                             AND revert_attempts < %s
                           ORDER BY approved_at NULLS LAST, created_at
                           LIMIT 1
                           FOR UPDATE SKIP LOCKED
                   )
                   RETURNING *""",
                (REVERT_MAX_ATTEMPTS,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def has_pending_revert_jobs() -> bool:
    """True when there is at least one row needing the revert worker."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT 1 FROM contributions
                       WHERE revert_status IN ('queued', 'running')
                         AND status = 'approved'
                         AND revert_attempts < %s
                       LIMIT 1""",
                (REVERT_MAX_ATTEMPTS,),
            )
            return cur.fetchone() is not None


def reset_running_reverts() -> int:
    """Re-queue any rows left in revert_status='running' by a previous
    process. The merge holds ``map_lock`` for its duration and is driven
    by the same idempotent SQLite operations as the original synchronous
    revert, so resuming after a crash is safe. Returns the number of
    rows reset."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET revert_status = 'queued'
                   WHERE revert_status = 'running'
                     AND status = 'approved'""",
            )
            return cur.rowcount


def set_revert_failed(cid: str, reason: str) -> None:
    """Record a revert failure. The row stays ``status='approved'`` so the
    admin can retry. ``revert_error`` is what the admin UI surfaces."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET revert_status = 'failed',
                           revert_error  = %s
                   WHERE id = %s""",
                ((reason or "")[:500], cid),
            )


def clear_revert_state(cid: str) -> None:
    """Clear revert bookkeeping after a successful revert. Called by the
    worker right after ``mark_reverted`` so historical rows don't keep the
    transient 'running' / attempts noise."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                       SET revert_status   = NULL,
                           revert_attempts = 0,
                           revert_error    = NULL
                   WHERE id = %s""",
                (cid,),
            )


# ---------------------------------------------------------------------------
# App-level key/value state
# ---------------------------------------------------------------------------

TILE_COUNT_KEY = "tile_count"
TOPS_MAP_STATS_KEY = "tops_map_stats"


def get_state(key: str) -> Optional[str]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT value FROM app_state WHERE key = %s", (key,))
            row = cur.fetchone()
            return row[0] if row else None


def set_state(key: str, value: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO app_state (key, value) VALUES (%s, %s)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""",
                (key, value),
            )


def get_cached_tile_count() -> int:
    val = get_state(TILE_COUNT_KEY)
    return int(val) if val else 0


def set_cached_tile_count(count: int):
    set_state(TILE_COUNT_KEY, str(count))


def get_tops_map_stats() -> Optional[dict]:
    """Get cached TOPS map stats JSON from app_state."""
    val = get_state(TOPS_MAP_STATS_KEY)
    if not val:
        return None
    try:
        parsed = json.loads(val)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


# ---------------------------------------------------------------------------
# DB availability check
# ---------------------------------------------------------------------------

def is_available() -> bool:
    """Return True if the connection pool has been initialised."""
    return _pool is not None


# ---------------------------------------------------------------------------
# API Keys CRUD
# ---------------------------------------------------------------------------

def create_api_key(
    key: str,
    name: str,
    permissions: str,
    consume_once: bool,
    source_invite_token: Optional[str] = None,
) -> dict:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO api_keys (key, name, permissions, consume_once, source_invite_token)
                   VALUES (%s, %s, %s, %s, %s)
                   RETURNING *""",
                (key, name, permissions, consume_once, source_invite_token),
            )
            row = cur.fetchone()
            return dict(row)


def list_api_keys() -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM api_keys ORDER BY created_at DESC")
            rows = cur.fetchall()
            return [dict(r) for r in rows]


# Allow-list of sortable columns for ``list_api_keys_paginated``.
# Mapping is ``api_param`` -> ``sql_column``.
_API_KEY_SORT_COLUMNS = {
    "created_at": "created_at",
    "last_used_at": "last_used_at",
    "usage_count": "usage_count",
    "bound_identity": "bound_identity",
    "name": "name",
}


def list_api_keys_paginated(
    status: str = "all",
    q: str = "",
    offset: int = 0,
    limit: int = 50,
    sort: str = "created_at",
    order: str = "desc",
    bound_identity: str = "any",
) -> dict:
    """Paginated + filtered listing of API keys.

    ``status`` one of ``"active"``, ``"revoked"``, ``"all"``.
    ``q`` is an optional case-insensitive substring search across the key's
    ``name`` and (a prefix of) the raw ``key`` itself.
    ``sort`` is one of the keys in :data:`_API_KEY_SORT_COLUMNS`.
    ``order`` is ``"asc"`` or ``"desc"``.
    ``bound_identity`` is a filter token:

    * ``"any"``  – no filter (default)
    * ``"none"`` / ``"unbound"`` – only rows where ``bound_identity IS NULL``
    * ``"bound"`` – only rows where ``bound_identity IS NOT NULL``
    * any other value – exact match against ``bound_identity``

    Returns ``{"items": [...], "total": int}``.
    """
    where = []
    params: list = []
    if status == "active":
        where.append("k.revoked = FALSE")
    elif status == "revoked":
        where.append("k.revoked = TRUE")
    if q:
        where.append("(k.name ILIKE %s OR k.key ILIKE %s)")
        like = f"%{q}%"
        params.extend([like, like])

    bi = (bound_identity or "any").strip().lower()
    if bi in ("none", "unbound"):
        where.append("k.bound_identity IS NULL")
    elif bi == "bound":
        where.append("k.bound_identity IS NOT NULL")
    elif bi and bi != "any":
        # Exact match on the supplied identity value (case-sensitive – identities
        # are typically opaque tokens). Use the original (non-lowercased) input.
        where.append("k.bound_identity = %s")
        params.append(bound_identity.strip())

    sort_col = _API_KEY_SORT_COLUMNS.get((sort or "").lower(), "created_at")
    direction = "ASC" if (order or "").lower() == "asc" else "DESC"
    # Push NULLs to the end regardless of direction so they don't dominate the
    # first page when sorting by sparse columns like ``last_used_at``.
    nulls = "NULLS LAST"
    # Tie-breaker on primary key keeps pagination stable.
    order_sql = f"ORDER BY k.{sort_col} {direction} {nulls}, k.key DESC"

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))

    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"SELECT COUNT(*) AS c FROM api_keys k {where_sql}", params)
            total = int(cur.fetchone()["c"])
            cur.execute(
                f"""SELECT k.*,
                           u.display_name,
                           u.in_game_name
                      FROM api_keys k
                      LEFT JOIN users u ON u.api_key = k.key
                      {where_sql}
                      {order_sql}
                      LIMIT %s OFFSET %s""",
                params + [limit, offset],
            )
            items = [dict(r) for r in cur.fetchall()]
    return {"items": items, "total": total}


def get_api_key(key: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM api_keys WHERE key = %s", (key,))
            row = cur.fetchone()
            return dict(row) if row else None


def bind_api_key(key: str, identity: str):
    """Bind a consume-once key to the first user's identity (only if not yet bound)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE api_keys SET bound_identity = %s WHERE key = %s AND bound_identity IS NULL",
                (identity, key),
            )


def touch_api_key(key: str):
    """Update last_used_at timestamp and increment usage counter."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE api_keys SET last_used_at = now(), usage_count = usage_count + 1 WHERE key = %s",
                (key,),
            )


def revoke_api_key(key: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE api_keys SET revoked = TRUE WHERE key = %s", (key,))


def set_tops_map_stats(stats: dict):
    """Persist TOPS map stats JSON in app_state."""
    set_state(TOPS_MAP_STATS_KEY, json.dumps(stats))


# ---------------------------------------------------------------------------
# TOPS map presigned chunk URL cache
# ---------------------------------------------------------------------------

def get_cached_chunk_urls(level: int, min_expires_at: datetime) -> dict:
    """Return cached presigned URLs for a level whose expiry is still in the future.

    Returns a dict keyed by ``(cx, cy)`` with values ``{"url": str, "expires_at": datetime}``.
    Rows expiring at/before ``min_expires_at`` are skipped (treat as missing so the
    caller will regenerate).
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT cx, cy, url, expires_at
                       FROM tops_map_chunk_urls
                       WHERE level = %s AND expires_at > %s""",
                (level, min_expires_at),
            )
            rows = cur.fetchall()
    return {(cx, cy): {"url": url, "expires_at": exp} for cx, cy, url, exp in rows}


def upsert_chunk_urls(level: int, items: List[dict]):
    """Insert/refresh a batch of presigned URLs for ``level``.

    Each item must contain ``cx``, ``cy``, ``url``, ``expires_at`` (datetime).
    """
    if not items:
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """INSERT INTO tops_map_chunk_urls (level, cx, cy, url, expires_at)
                       VALUES %s
                       ON CONFLICT (level, cx, cy) DO UPDATE
                       SET url = EXCLUDED.url, expires_at = EXCLUDED.expires_at""",
                [(level, it["cx"], it["cy"], it["url"], it["expires_at"]) for it in items],
            )


def delete_expired_chunk_urls(now: Optional[datetime] = None) -> int:
    """Drop presigned URL rows whose expiry has passed. Returns # rows deleted."""
    cutoff = now or datetime.now(timezone.utc)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM tops_map_chunk_urls WHERE expires_at <= %s",
                (cutoff,),
            )
            return cur.rowcount or 0


def delete_chunk_urls_for_level(level: int) -> int:
    """Drop all cached presigned URLs for ``level``. Returns # rows deleted."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM tops_map_chunk_urls WHERE level = %s",
                (level,),
            )
            return cur.rowcount or 0


def delete_chunk_url(level: int, cx: int, cy: int) -> bool:
    """Drop a single cached presigned URL. Returns True if a row was removed."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM tops_map_chunk_urls WHERE level = %s AND cx = %s AND cy = %s",
                (level, cx, cy),
            )
            return (cur.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# TOPS-map regeneration queue
#
# Producers (contribute approvals, admin "regenerate") append a row describing
# what needs to be re-rendered. The background worker drains the queue at the
# start of every iteration. This is the mechanism that prevents regeneration
# requests from being lost when an approval lands while a worker is mid-job.
# ---------------------------------------------------------------------------

def enqueue_regen(
    bounds: Optional[tuple],
    levels: Optional[List[int]],
):
    """Record a pending regeneration request.

    ``bounds`` is a world-block ``(min_x, max_x, min_z, max_z)`` tuple, or
    ``None`` to request a full regen of the listed levels.
    ``levels`` is a list of resolution level numbers, or ``None`` for "all
    configured levels". The worker resolves ``None`` against the current
    ``RESOLUTION_LEVELS`` mapping at drain time.
    """
    full = bounds is None
    if full:
        min_x = max_x = min_z = max_z = None
    else:
        min_x, max_x, min_z, max_z = bounds
    levels_json = json.dumps(sorted(set(levels))) if levels is not None else None
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO regen_queue
                       (min_x, max_x, min_z, max_z, levels, full_regen)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (min_x, max_x, min_z, max_z, levels_json, full),
            )


def drain_regen_queue() -> List[dict]:
    """Atomically remove every row from ``regen_queue`` and return them.

    Implemented as a single ``DELETE ... RETURNING *`` so that two workers
    cannot race to claim the same rows. The single-process ``_job_lock`` in
    ``generate_map_levels`` is what serialises *workers*; this query is what
    makes the *queue claim itself* atomic, so an enqueue that lands between
    a drain and a "queue is empty so I'm exiting" check is observable on the
    next drain inside the same lock.
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """WITH deleted AS (
                       DELETE FROM regen_queue RETURNING *
                   )
                   SELECT * FROM deleted ORDER BY id"""
            )
            return [dict(r) for r in cur.fetchall()]


def regen_queue_size() -> int:
    """Cheap diagnostic â€” used by the admin status endpoint."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM regen_queue")
            row = cur.fetchone()
            return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Invite Links CRUD
# ---------------------------------------------------------------------------

def create_invite_link(
    token: str,
    name: str,
    permissions: str,
    max_uses: Optional[int],
    expires_at: Optional[datetime],
) -> dict:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO invite_links (token, name, permissions, max_uses, expires_at)
                   VALUES (%s, %s, %s, %s, %s)
                   RETURNING *""",
                (token, name, permissions, max_uses, expires_at),
            )
            row = cur.fetchone()
            return dict(row)


def list_invite_links() -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM invite_links ORDER BY created_at DESC")
            return [dict(r) for r in cur.fetchall()]


def list_invite_links_paginated(
    status: str = "all",
    q: str = "",
    offset: int = 0,
    limit: int = 50,
) -> dict:
    """Paginated + filtered listing of invite links.

    ``status`` is one of:

    * ``"active"`` – usable: not revoked, not expired, and not exhausted.
    * ``"revoked"`` – inactive: revoked OR expired OR (has a max-uses cap and
      hit it). The frontend groups these under the "Inactive" card since none
      of them can mint new keys.
    * ``"all"`` – no status filter.

    ``q`` searches the invite ``name`` and ``token`` (substring, case-insensitive).
    """
    where = []
    params: list = []
    # An invite link is "inactive" if any of: revoked, past expires_at, or
    # use_count has reached max_uses (when max_uses is set). This mirrors the
    # frontend status-badge logic in InviteLinkRow.
    inactive_expr = (
        "(revoked = TRUE "
        " OR (expires_at IS NOT NULL AND expires_at < now()) "
        " OR (max_uses IS NOT NULL AND use_count >= max_uses))"
    )
    if status == "active":
        where.append(f"NOT {inactive_expr}")
    elif status == "revoked":
        where.append(inactive_expr)
    if q:
        where.append("(name ILIKE %s OR token ILIKE %s)")
        like = f"%{q}%"
        params.extend([like, like])

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))

    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"SELECT COUNT(*) AS c FROM invite_links {where_sql}", params)
            total = int(cur.fetchone()["c"])
            cur.execute(
                f"SELECT * FROM invite_links {where_sql} "
                "ORDER BY created_at DESC, token DESC LIMIT %s OFFSET %s",
                params + [limit, offset],
            )
            items = [dict(r) for r in cur.fetchall()]
    return {"items": items, "total": total}


def get_invite_link(token: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM invite_links WHERE token = %s", (token,))
            row = cur.fetchone()
            return dict(row) if row else None


def revoke_invite_link(token: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE invite_links SET revoked = TRUE, is_default_public = FALSE "
                "WHERE token = %s",
                (token,),
            )


def set_invite_link_default_public(token: str, value: bool) -> Optional[dict]:
    """Mark/unmark an invite link as the single default-public link.

    When ``value`` is True, atomically clears the flag on every other invite
    link first (the partial unique index would otherwise reject the update),
    then sets it on ``token``. Refuses to flag a revoked link as default.

    Returns the updated invite-link row, or None if the token doesn't exist.
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM invite_links WHERE token = %s", (token,))
            row = cur.fetchone()
            if not row:
                return None
            if value and row["revoked"]:
                raise ValueError("Cannot mark a revoked invite link as default")
            if value:
                cur.execute(
                    "UPDATE invite_links SET is_default_public = FALSE "
                    "WHERE is_default_public = TRUE AND token <> %s",
                    (token,),
                )
            cur.execute(
                "UPDATE invite_links SET is_default_public = %s "
                "WHERE token = %s RETURNING *",
                (value, token),
            )
            return dict(cur.fetchone())


def get_default_public_invite_link() -> Optional[dict]:
    """Return the active default-public invite link, or None.

    "Active" means: flagged is_default_public, not revoked, not expired, and
    not exhausted. Used by the public ``GET /api/invite/default`` endpoint.
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT * FROM invite_links
                   WHERE is_default_public = TRUE
                     AND revoked = FALSE
                     AND (expires_at IS NULL OR expires_at > now())
                     AND (max_uses IS NULL OR use_count < max_uses)
                   LIMIT 1"""
            )
            row = cur.fetchone()
            return dict(row) if row else None


def claim_invite_link(token: str) -> bool:
    """Atomically increment use_count. Returns False if the link is exhausted."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE invite_links
                   SET use_count = use_count + 1
                   WHERE token = %s
                     AND revoked = FALSE
                     AND (max_uses IS NULL OR use_count < max_uses)
                     AND (expires_at IS NULL OR expires_at > now())
                   """,
                (token,),
            )
            return cur.rowcount > 0


def list_api_keys_by_invite(token: str) -> List[dict]:
    """Return every API key minted from the given invite link, joined with
    the user account (if any) bound to that key. Newest first.

    Each row carries the api-key columns plus ``display_name``, ``in_game_name``
    and ``user_joined_at`` (NULL when no account exists for the key).
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT k.*,
                          u.display_name,
                          u.in_game_name,
                          u.joined_at AS user_joined_at,
                          u.deleted_at AS user_deleted_at
                       FROM api_keys k
                       LEFT JOIN users u ON u.api_key = k.key
                       WHERE k.source_invite_token = %s
                       ORDER BY k.created_at DESC""",
                (token,),
            )
            return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Map lock — single-row mutex for combined-DB mutations (Phase 0a)
# ---------------------------------------------------------------------------

import secrets as _secrets
from datetime import timedelta as _timedelta


class MapLocked(Exception):
    """Raised when the global map lock cannot be acquired."""


MAP_LOCK_ID = "globalservermap"
MAP_LOCK_TTL_SECONDS = 600  # 10 minutes
_VALID_LOCK_ACTIONS = {"approve", "revert", "restore", "backup"}


def acquire_map_lock(action: str, ttl_seconds: int = MAP_LOCK_TTL_SECONDS) -> str:
    """Atomically acquire the global map lock. Returns an opaque holder token.

    Raises `MapLocked` (HTTP 423) if another holder owns a non-expired row.
    The lock auto-clears via `expires_at` so a crashed worker self-recovers
    after the TTL.
    """
    if action not in _VALID_LOCK_ACTIONS:
        raise ValueError(f"Invalid lock action: {action}")

    token = _secrets.token_hex(16)
    now = datetime.now(timezone.utc)
    expires = now + _timedelta(seconds=ttl_seconds)

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Insert if no row, OR overwrite if existing row's lease has expired.
            cur.execute(
                """INSERT INTO map_lock (id, holder_token, holder_action, acquired_at, expires_at)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE
                       SET holder_token  = EXCLUDED.holder_token,
                           holder_action = EXCLUDED.holder_action,
                           acquired_at   = EXCLUDED.acquired_at,
                           expires_at    = EXCLUDED.expires_at
                       WHERE map_lock.expires_at < now()
                   RETURNING holder_token""",
                (MAP_LOCK_ID, token, action, now, expires),
            )
            row = cur.fetchone()
            if row is None or row[0] != token:
                raise MapLocked("Another map operation is in progress")
    return token


def release_map_lock(token: str) -> bool:
    """Release the lock if we still own it. Returns True if a row was deleted."""
    if not token:
        return False
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM map_lock WHERE id = %s AND holder_token = %s",
                (MAP_LOCK_ID, token),
            )
            return (cur.rowcount or 0) > 0


def force_release_map_lock() -> bool:
    """Admin override — drop the lock unconditionally. Returns True if removed."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM map_lock WHERE id = %s", (MAP_LOCK_ID,))
            return (cur.rowcount or 0) > 0


def get_map_lock_info() -> Optional[dict]:
    """Return current lock holder info (action, acquired_at, expires_at) or None."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT holder_action, acquired_at, expires_at FROM map_lock WHERE id = %s",
                (MAP_LOCK_ID,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


@contextmanager
def with_map_lock(action: str):
    """Context manager wrapper around acquire/release_map_lock."""
    token = acquire_map_lock(action)
    try:
        yield token
    finally:
        try:
            release_map_lock(token)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Feature flags (Phase 0b)
# ---------------------------------------------------------------------------

def list_feature_flags() -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM feature_flags ORDER BY key")
            return [dict(r) for r in cur.fetchall()]


def get_feature_flag(key: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM feature_flags WHERE key = %s", (key,))
            row = cur.fetchone()
            return dict(row) if row else None


# ---------------------------------------------------------------------------
# Resources-overlay async upload jobs
# ---------------------------------------------------------------------------
#
# Used by ``backend/app/routes/resources.py``. The HTTP request handler
# only spools the .zip to local disk; this row tracks the long tail of
# fanning thousands of small tile PUTs out to R2.

_RESOURCES_JOB_ACTIVE_STATUSES = ("unpacking", "swapping")


def create_resources_upload_job(
    job_id: str,
    seed: str,
    vs_version: str,
    *,
    total_files: int = 0,
    total_bytes: int = 0,
    phase: str = "queued",
) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO resources_upload_jobs
                    (id, seed, vs_version, status, phase,
                     total_files, total_bytes)
                VALUES (%s, %s, %s, 'unpacking', %s, %s, %s)
                """,
                (job_id, seed, vs_version, phase, total_files, total_bytes),
            )


def update_resources_upload_job(
    job_id: str,
    *,
    phase: Optional[str] = None,
    status: Optional[str] = None,
    total_files: Optional[int] = None,
    processed_files: Optional[int] = None,
    total_bytes: Optional[int] = None,
    uploaded_bytes: Optional[int] = None,
    error: Optional[str] = None,
    completed: bool = False,
) -> None:
    """Patch the row. Any field left as ``None`` is preserved."""
    sets: List[str] = ["updated_at = now()"]
    params: list = []
    if phase is not None:
        sets.append("phase = %s")
        params.append(phase)
    if status is not None:
        sets.append("status = %s")
        params.append(status)
    if total_files is not None:
        sets.append("total_files = %s")
        params.append(total_files)
    if processed_files is not None:
        sets.append("processed_files = %s")
        params.append(processed_files)
    if total_bytes is not None:
        sets.append("total_bytes = %s")
        params.append(total_bytes)
    if uploaded_bytes is not None:
        sets.append("uploaded_bytes = %s")
        params.append(uploaded_bytes)
    if error is not None:
        sets.append("error = %s")
        params.append(error)
    if completed:
        sets.append("completed_at = now()")
    params.append(job_id)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE resources_upload_jobs SET {', '.join(sets)} WHERE id = %s",
                params,
            )


def get_resources_upload_job(job_id: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM resources_upload_jobs WHERE id = %s",
                (job_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def get_active_resources_upload_job() -> Optional[dict]:
    """Return the most recent in-flight job, or the most recent job if
    none are in flight (so the FE can show the last result on first load)."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT * FROM resources_upload_jobs
                WHERE status IN %s
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (_RESOURCES_JOB_ACTIVE_STATUSES,),
            )
            row = cur.fetchone()
            if row:
                return dict(row)
            cur.execute(
                """
                SELECT * FROM resources_upload_jobs
                ORDER BY created_at DESC
                LIMIT 1
                """,
            )
            row = cur.fetchone()
            return dict(row) if row else None


def has_active_resources_upload_job() -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT 1 FROM resources_upload_jobs
                WHERE status IN %s
                LIMIT 1
                """,
                (_RESOURCES_JOB_ACTIVE_STATUSES,),
            )
            return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# Landmarks audit + edit-request CRUD
# ---------------------------------------------------------------------------

def insert_landmark_audit(
    *,
    landmark_id: str,
    action: str,
    actor_api_key_id: Optional[str],
    actor_display_name: Optional[str],
    before_payload: Optional[dict] = None,
    after_payload: Optional[dict] = None,
) -> None:
    """Append-only audit record for a landmark mutation."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO landmarks_audit
                       (landmark_id, action, actor_api_key_id, actor_display_name,
                        before_payload, after_payload)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (
                    landmark_id,
                    action,
                    actor_api_key_id,
                    actor_display_name,
                    json.dumps(before_payload) if before_payload is not None else None,
                    json.dumps(after_payload) if after_payload is not None else None,
                ),
            )


def list_landmark_audit(
    *,
    landmark_id: Optional[str] = None,
    actor_api_key_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> List[dict]:
    where = []
    params: list = []
    if landmark_id:
        where.append("landmark_id = %s")
        params.append(landmark_id)
    if actor_api_key_id:
        where.append("actor_api_key_id = %s")
        params.append(actor_api_key_id)
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    params.extend([int(limit), int(offset)])
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""SELECT id, landmark_id, action, actor_api_key_id,
                           actor_display_name, before_payload, after_payload,
                           created_at
                       FROM landmarks_audit
                       {where_sql}
                       ORDER BY created_at DESC
                       LIMIT %s OFFSET %s""",
                params,
            )
            return [dict(r) for r in cur.fetchall()]


def insert_landmark_edit_request(
    *,
    request_id: str,
    landmark_id: str,
    submitted_by_api_key_id: str,
    submitted_by_display_name: str,
    current_label: str,
    proposed_label: str,
) -> dict:
    """Insert a pending rename request. Any prior pending request from the
    same submitter for the same landmark is marked ``superseded`` so only the
    newest one is actionable."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE landmark_edit_requests
                       SET status = 'superseded'
                       WHERE landmark_id = %s
                         AND submitted_by_api_key_id = %s
                         AND status = 'pending'""",
                (landmark_id, submitted_by_api_key_id),
            )
            cur.execute(
                """INSERT INTO landmark_edit_requests
                       (id, landmark_id, submitted_by_api_key_id,
                        submitted_by_display_name, current_label, proposed_label)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   RETURNING *""",
                (
                    request_id,
                    landmark_id,
                    submitted_by_api_key_id,
                    submitted_by_display_name,
                    current_label,
                    proposed_label,
                ),
            )
            return dict(cur.fetchone())


def get_landmark_edit_request(request_id: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM landmark_edit_requests WHERE id = %s",
                (request_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def list_landmark_edit_requests(
    *,
    status: Optional[str] = None,
    submitted_by_api_key_id: Optional[str] = None,
    landmark_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> List[dict]:
    where = []
    params: list = []
    if status:
        where.append("status = %s")
        params.append(status)
    if submitted_by_api_key_id:
        where.append("submitted_by_api_key_id = %s")
        params.append(submitted_by_api_key_id)
    if landmark_id:
        where.append("landmark_id = %s")
        params.append(landmark_id)
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    params.extend([int(limit), int(offset)])
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""SELECT * FROM landmark_edit_requests
                       {where_sql}
                       ORDER BY created_at DESC
                       LIMIT %s OFFSET %s""",
                params,
            )
            return [dict(r) for r in cur.fetchall()]


def resolve_landmark_edit_request(
    request_id: str,
    *,
    new_status: str,
    reviewed_by_api_key_id: Optional[str],
    review_note: Optional[str] = None,
) -> Optional[dict]:
    """Mark a request as ``approved`` / ``rejected`` / ``superseded``.

    No-ops (returns None) if the row does not exist or is not currently
    pending — protects against double-action races between two admins."""
    if new_status not in ("approved", "rejected", "superseded"):
        raise ValueError(f"invalid new_status: {new_status!r}")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE landmark_edit_requests
                       SET status = %s,
                           reviewed_by_api_key_id = %s,
                           reviewed_at = now(),
                           review_note = %s
                       WHERE id = %s AND status = 'pending'
                       RETURNING *""",
                (new_status, reviewed_by_api_key_id, review_note, request_id),
            )
            row = cur.fetchone()
            return dict(row) if row else None



def reset_stuck_resources_upload_jobs() -> int:
    """Mark in-flight jobs as failed at startup. The worker thread that
    owned them died with the previous process, so they are unreachable."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE resources_upload_jobs
                SET status = 'failed',
                    error = COALESCE(error, 'Backend process restarted mid-upload'),
                    updated_at = now(),
                    completed_at = COALESCE(completed_at, now())
                WHERE status IN %s
                """,
                (_RESOURCES_JOB_ACTIVE_STATUSES,),
            )
            return cur.rowcount or 0


def set_feature_flag(key: str, enabled: bool, updated_by_key: str = "") -> Optional[dict]:
    """Set a flag's state. Returns the resulting row, or None if the key is unknown."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE feature_flags
                       SET enabled = %s, updated_at = now(), updated_by_key = %s
                       WHERE key = %s
                       RETURNING *""",
                (enabled, updated_by_key or None, key),
            )
            row = cur.fetchone()
            return dict(row) if row else None


# ---------------------------------------------------------------------------
# Generic app settings (non-boolean admin-tunable values)
# ---------------------------------------------------------------------------

def list_app_settings() -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM app_settings ORDER BY key")
            return [dict(r) for r in cur.fetchall()]


def get_app_setting(key: str) -> Optional[dict]:
    """Return the raw row (with ``value`` already deserialised by psycopg2's
    JSONB adapter) or None if the key is missing."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM app_settings WHERE key = %s", (key,))
            row = cur.fetchone()
            return dict(row) if row else None


def set_app_setting(key: str, value, updated_by_key: str = "") -> dict:
    """Upsert ``value`` (any JSON-serialisable Python object) under ``key``.
    Returns the resulting row."""
    payload = psycopg2.extras.Json(value)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO app_settings (key, value, updated_by_key)
                       VALUES (%s, %s, %s)
                       ON CONFLICT (key) DO UPDATE
                           SET value = EXCLUDED.value,
                               updated_at = now(),
                               updated_by_key = EXCLUDED.updated_by_key
                       RETURNING *""",
                (key, payload, updated_by_key or None),
            )
            return dict(cur.fetchone())


# ---------------------------------------------------------------------------
# Maintenance notices
#
# One row per known component. The public ``GET /api/maintenance/notices``
# endpoint returns only ``active = TRUE`` rows; the admin endpoints can
# read/update any row. Turning a notice off keeps the row so the admin can
# see the previous message/eta.
# ---------------------------------------------------------------------------

def list_maintenance_notices(active_only: bool = False) -> List[dict]:
    sql = "SELECT * FROM maintenance_notices"
    if active_only:
        sql += " WHERE active = TRUE"
    sql += " ORDER BY component"
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql)
            return [dict(r) for r in cur.fetchall()]


def get_maintenance_notice(component: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM maintenance_notices WHERE component = %s",
                (component,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def upsert_maintenance_notice(
    component: str,
    active: bool,
    message: str,
    eta_at: Optional[datetime],
    updated_by_key: str = "",
) -> dict:
    """Insert or update a maintenance notice. ``started_at`` is set to now()
    only when the notice transitions from inactive to active so the public
    chip's elapsed/remaining countdown stays anchored to the original
    activation time across subsequent ETA updates."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO maintenance_notices
                       (component, active, message, started_at, eta_at, updated_at, updated_by_key)
                   VALUES (%s, %s, %s, now(), %s, now(), %s)
                   ON CONFLICT (component) DO UPDATE SET
                       active         = EXCLUDED.active,
                       message        = EXCLUDED.message,
                       eta_at         = EXCLUDED.eta_at,
                       updated_at     = now(),
                       updated_by_key = EXCLUDED.updated_by_key,
                       started_at     = CASE
                           WHEN maintenance_notices.active = FALSE AND EXCLUDED.active = TRUE
                               THEN now()
                           ELSE maintenance_notices.started_at
                       END
                   RETURNING *""",
                (component, active, message or "", eta_at, updated_by_key or None),
            )
            row = cur.fetchone()
            return dict(row)


def clear_maintenance_notice(component: str, updated_by_key: str = "") -> Optional[dict]:
    """Mark the notice as inactive without deleting the row."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE maintenance_notices
                       SET active = FALSE,
                           updated_at = now(),
                           updated_by_key = %s
                       WHERE component = %s
                       RETURNING *""",
                (updated_by_key or None, component),
            )
            row = cur.fetchone()
            return dict(row) if row else None


# ---------------------------------------------------------------------------
# Granular per-API-key permissions (Phase 0c)
#
# Stored in `api_keys.extra_permissions` JSONB. Recognised keys today:
#   `region_overwrite`  : bool
# Future toggles can be added without schema migrations.
# ---------------------------------------------------------------------------

def get_api_key_extra_permissions(key: str) -> dict:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT extra_permissions FROM api_keys WHERE key = %s", (key,))
            row = cur.fetchone()
            if not row:
                return {}
            value = row[0]
            if isinstance(value, dict):
                return value
            try:
                return json.loads(value) if value else {}
            except (TypeError, json.JSONDecodeError):
                return {}


def set_api_key_extra_permission(key: str, perm_name: str, enabled: bool) -> bool:
    """Toggle a single permission flag on an API key. Returns True on update."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE api_keys
                       SET extra_permissions = jsonb_set(
                           COALESCE(extra_permissions, '{}'::jsonb),
                           %s,
                           to_jsonb(%s::boolean),
                           true
                       )
                       WHERE key = %s""",
                ('{' + perm_name + '}', enabled, key),
            )
            return (cur.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# TOTP 2FA storage (Phase 4a)
# ---------------------------------------------------------------------------

def get_totp_secret_encrypted(api_key: str) -> Optional[str]:
    """Return the encrypted TOTP secret for ``api_key``, or None if not enrolled."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT totp_secret_encrypted FROM api_keys WHERE key = %s",
                (api_key,),
            )
            row = cur.fetchone()
            return row[0] if row and row[0] else None


def set_totp_secret_encrypted(api_key: str, encrypted: str) -> bool:
    """Persist an encrypted TOTP secret + enrolment timestamp. Returns True on update.

    Note: ``api_key`` may be the env-var admin key, which has no row in the
    ``api_keys`` table. We upsert a synthetic row so TOTP still works for the
    bootstrap admin.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO api_keys (key, name, permissions)
                       VALUES (%s, 'admin (env)', 'contribute')
                       ON CONFLICT (key) DO NOTHING""",
                (api_key,),
            )
            cur.execute(
                """UPDATE api_keys
                       SET totp_secret_encrypted = %s,
                           totp_enrolled_at      = now()
                       WHERE key = %s""",
                (encrypted, api_key),
            )
            return (cur.rowcount or 0) > 0


def get_totp_enrolled_at(api_key: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT totp_enrolled_at FROM api_keys WHERE key = %s",
                (api_key,),
            )
            row = cur.fetchone()
            return row[0] if row else None


# ---------------------------------------------------------------------------
# WebAuthn / passkey storage (Phase 4c)
# ---------------------------------------------------------------------------

def add_webauthn_credential(
    api_key: str,
    name: str,
    credential_id: bytes,
    public_key: bytes,
    sign_count: int,
    transports: Optional[str],
) -> dict:
    """Insert a freshly registered passkey. Returns the new row as a dict."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO webauthn_credentials
                       (api_key, name, credential_id, public_key, sign_count, transports)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   RETURNING id, api_key, name, created_at, last_used_at""",
                (
                    api_key,
                    name or "",
                    psycopg2.Binary(credential_id),
                    psycopg2.Binary(public_key),
                    int(sign_count or 0),
                    transports,
                ),
            )
            row = cur.fetchone()
            return dict(row) if row else {}


def list_webauthn_credentials(api_key: str) -> List[dict]:
    """Return all (non-revoked) passkey rows for this admin key, newest first.

    The ``credential_id`` and ``public_key`` BYTEA columns are returned as
    ``bytes`` so the caller can feed them straight back into the webauthn lib.
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, api_key, name, credential_id, public_key,
                          sign_count, transports, created_at, last_used_at
                       FROM webauthn_credentials
                      WHERE api_key = %s
                   ORDER BY created_at DESC""",
                (api_key,),
            )
            rows = cur.fetchall() or []
            out = []
            for r in rows:
                d = dict(r)
                if d.get("credential_id") is not None:
                    d["credential_id"] = bytes(d["credential_id"])
                if d.get("public_key") is not None:
                    d["public_key"] = bytes(d["public_key"])
                out.append(d)
            return out


def get_webauthn_credential_by_id(credential_id: bytes) -> Optional[dict]:
    """Look up a credential by its raw ID (used during assertion verification)."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, api_key, name, credential_id, public_key,
                          sign_count, transports, created_at, last_used_at
                       FROM webauthn_credentials
                      WHERE credential_id = %s""",
                (psycopg2.Binary(credential_id),),
            )
            row = cur.fetchone()
            if not row:
                return None
            d = dict(row)
            d["credential_id"] = bytes(d["credential_id"])
            d["public_key"] = bytes(d["public_key"])
            return d


def update_webauthn_sign_count(credential_pk: int, new_sign_count: int) -> None:
    """Bump sign_count + last_used_at after a successful assertion."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE webauthn_credentials
                       SET sign_count = %s,
                           last_used_at = now()
                     WHERE id = %s""",
                (int(new_sign_count), int(credential_pk)),
            )


def delete_webauthn_credential(api_key: str, credential_pk: int) -> bool:
    """Remove a passkey owned by this admin key. Returns True if a row was deleted."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """DELETE FROM webauthn_credentials
                     WHERE id = %s AND api_key = %s""",
                (int(credential_pk), api_key),
            )
            return (cur.rowcount or 0) > 0


def count_webauthn_credentials(api_key: str) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM webauthn_credentials WHERE api_key = %s",
                (api_key,),
            )
            row = cur.fetchone()
            return int(row[0]) if row else 0

