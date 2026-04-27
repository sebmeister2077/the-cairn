"""Application settings loaded from environment variables."""

import os
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv

# Load .env from the backend directory
load_dotenv(Path(__file__).resolve().parent.parent / ".env")


class Settings:
    """Central configuration — reads from env vars with sensible defaults."""

    # Comma-separated list of valid API keys
    API_KEYS: List[str] = [
        k.strip()
        for k in os.environ.get("API_KEYS", "").split(",")
        if k.strip()
    ]

    # Rate limiting
    RATE_LIMIT_MAX: int = int(os.environ.get("RATE_LIMIT_MAX", "5"))
    RATE_LIMIT_WINDOW: int = int(os.environ.get("RATE_LIMIT_WINDOW", "3600"))  # seconds

    # CORS
    ALLOWED_ORIGINS: List[str] = [
        o.strip().rstrip("/")
        for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
        if o.strip()
    ]
    ALLOWED_ORIGIN_REGEX: Optional[str] = os.environ.get("ALLOWED_ORIGIN_REGEX", "").strip() or None

    # Upload limit (bytes)
    MAX_UPLOAD_SIZE: int = int(os.environ.get("MAX_UPLOAD_SIZE", str(4 * 1024 * 1024 * 1024)))  # 4 GB

    # Map render limit (pixels) to bound RGBA buffer size in memory
    MAP_RENDER_MAX_DIM: int = int(os.environ.get("MAP_RENDER_MAX_DIM", "8192"))

    # Contribute feature
    CONTRIBUTE_MAP_ID: str = os.environ.get(
        "CONTRIBUTE_MAP_ID", "48bd1c98-4ee0-414a-b584-a3628278d99d"
    )
    CONTRIBUTE_DATA_DIR: str = os.environ.get(
        "CONTRIBUTE_DATA_DIR",
        str(Path(__file__).resolve().parent.parent / "contribute-data"),
    )
    ADMIN_API_KEY: str = os.environ.get("ADMIN_API_KEY", "")

    # Phase 3 — public contribution history retention (days). Non-admin
    # contributions show up in the public grid for this many days after
    # approval; admin uploads are kept longer so the team can audit.
    HISTORY_RETENTION_DAYS: int = int(os.environ.get("HISTORY_RETENTION_DAYS", "14"))
    ADMIN_HISTORY_RETENTION_DAYS: int = int(
        os.environ.get("ADMIN_HISTORY_RETENTION_DAYS", "90")
    )
    # Hard limit on withdrawals per ISO calendar week per non-admin key.
    WITHDRAW_LIMIT_PER_WEEK: int = int(os.environ.get("WITHDRAW_LIMIT_PER_WEEK", "3"))
    # Background cleanup interval for the history sweeper (seconds).
    HISTORY_CLEANUP_INTERVAL_SECONDS: int = int(
        os.environ.get("HISTORY_CLEANUP_INTERVAL_SECONDS", str(24 * 60 * 60))
    )

    # Phase 4a — weekly backups of the combined map .db.
    # How many of each kind to retain in R2 (cleanup is application-side).
    BACKUP_KEEP_SCHEDULED: int = int(os.environ.get("BACKUP_KEEP_SCHEDULED", "4"))
    BACKUP_KEEP_MANUAL: int = int(os.environ.get("BACKUP_KEEP_MANUAL", "8"))
    # How often the scheduler thread wakes up to check whether a new ISO week
    # has begun. Hourly is plenty — a snapshot fires at most once per week.
    BACKUP_CHECK_INTERVAL_SECONDS: int = int(
        os.environ.get("BACKUP_CHECK_INTERVAL_SECONDS", str(60 * 60))
    )

    # --- Phase 4b: per-contribution revert ---
    # How long after approval a contribution can still be reverted (days).
    # Beyond this admins must restore from a Phase-4a backup.
    REVERT_WINDOW_DAYS: int = int(os.environ.get("REVERT_WINDOW_DAYS", "14"))
    # Hard cap on the size of the per-contribution ``undo/<id>.added.bin``
    # stream. Each entry is 8 bytes (little-endian uint64), so the default
    # 64 MiB == ~8M positions, which is well above any realistic upload.
    # When a merge would exceed this, the capture is skipped and the
    # contribution is marked ``revert_supported = false`` (admins still have
    # the weekly-backup restore as the fallback).
    REVERT_ADDED_BIN_MAX_BYTES: int = int(
        os.environ.get("REVERT_ADDED_BIN_MAX_BYTES", str(64 * 1024 * 1024))
    )
    # Symmetric key used to encrypt TOTP secrets at rest. Must be a
    # urlsafe-base64 32-byte Fernet key. Generate with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # If unset, TOTP enrolment is disabled and restore endpoints reject with
    # 503 "totp_not_configured".
    TOTP_ENCRYPTION_KEY: str = os.environ.get("TOTP_ENCRYPTION_KEY", "")
    # Display label shown in the user's authenticator app.
    TOTP_ISSUER: str = os.environ.get("TOTP_ISSUER", "VS Waypoints Admin")

    # Secret salt used to hash IP addresses before storing them (GDPR)
    IP_HASH_SALT: str = os.environ.get("IP_HASH_SALT", "")

    # Terms of service version. Bump to force re-acceptance on next /me load.
    TERMS_VERSION: str = os.environ.get("TERMS_VERSION", "2025-01-01")

    # Per-key sub-limit defaults (account system)
    RATE_LIMIT_REGEN_NAME_MAX: int = int(os.environ.get("RATE_LIMIT_REGEN_NAME_MAX", "3"))
    RATE_LIMIT_REGEN_NAME_WINDOW: int = int(os.environ.get("RATE_LIMIT_REGEN_NAME_WINDOW", "86400"))
    RATE_LIMIT_PROFILE_MAX: int = int(os.environ.get("RATE_LIMIT_PROFILE_MAX", "10"))
    RATE_LIMIT_PROFILE_WINDOW: int = int(os.environ.get("RATE_LIMIT_PROFILE_WINDOW", "3600"))

    # Default duration of an IP ban (days). Admins can override per-ban.
    IP_BAN_DEFAULT_DAYS: int = int(os.environ.get("IP_BAN_DEFAULT_DAYS", "365"))

    # Cloudflare R2
    R2_ACCOUNT_ID: str = os.environ.get("R2_ACCOUNT_ID", "")
    R2_ACCESS_KEY_ID: str = os.environ.get("R2_ACCESS_KEY_ID", "")
    R2_SECRET_ACCESS_KEY: str = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    R2_BUCKET_NAME: str = os.environ.get("R2_BUCKET_NAME", "vs-waypoints")

    @property
    def R2_ENDPOINT_URL(self) -> str:
        return f"https://{self.R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

    # Supabase PostgreSQL
    SUPABASE_DB_URL: str = os.environ.get("SUPABASE_DB_URL", "")


settings = Settings()
