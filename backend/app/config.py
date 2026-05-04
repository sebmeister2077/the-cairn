"""Application settings loaded from environment variables."""

import os
from pathlib import Path
from typing import List, Optional

from dotenv import dotenv_values, load_dotenv

# Load env file from the backend directory based on APP_ENV.
#   APP_ENV=local -> .env.local   (default)
#   APP_ENV=prod  -> .env.prod
#
# APP_ENV resolution order (first hit wins):
#   1. Real shell environment variable (e.g. `$env:APP_ENV='prod'`)
#   2. APP_ENV= line inside backend/.env  (acts as the local "default switch")
#   3. Hard-coded fallback: "local"
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_DEFAULT_ENV_FILE = _BACKEND_DIR / ".env"

_APP_ENV = os.environ.get("APP_ENV")
if not _APP_ENV and _DEFAULT_ENV_FILE.exists():
    # Peek at .env without mutating os.environ so we can find APP_ENV
    # before deciding which env file to actually load.
    _APP_ENV = (dotenv_values(_DEFAULT_ENV_FILE).get("APP_ENV") or "").strip()
_APP_ENV = (_APP_ENV or "local").strip().lower()

print(f"Loading environment variables for APP_ENV='{_APP_ENV}'...")
_env_file = _BACKEND_DIR / f".env.{_APP_ENV}"
if not _env_file.exists():
    _env_file = _DEFAULT_ENV_FILE
load_dotenv(_env_file, override=True)


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

    # Upload limit (bytes). Default 15 GiB. Files >5 GiB MUST go through the
    # multipart upload path (R2/S3 hard-cap single PUTs at 5 GiB); the
    # frontend switches automatically above ~4 GiB.
    MAX_UPLOAD_SIZE: int = int(os.environ.get("MAX_UPLOAD_SIZE", str(15 * 1024 * 1024 * 1024)))  # 15 GiB

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

    # Per-contribution archived .db retention (days). Recent Contributions
    # grid previews are kept forever; these values govern only the
    # ``archived/<id>.db`` lifetime in R2 (used to power per-contribution
    # revert). Admin uploads get the longer window so the team can audit.
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
    # How often the heavy-compute poller wakes up to check for pending
    # validation / match-score work. Cheap when there's nothing to do.
    HEAVY_COMPUTE_POLL_INTERVAL_SECONDS: int = int(
        os.environ.get("HEAVY_COMPUTE_POLL_INTERVAL_SECONDS", "30")
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
    TOTP_ISSUER: str = os.environ.get("TOTP_ISSUER", "Cairn Admin")

    # --- Phase 4c: WebAuthn (passkey) admin 2FA ---
    # Relying-Party ID — the eTLD+1 the passkey is bound to. MUST exactly match
    # the hostname of the frontend admin UI (e.g. "vs-waypoints.example.com",
    # "localhost" for local dev). Browsers refuse the registration if RP ID
    # does not match the page origin's effective domain.
    WEBAUTHN_RP_ID: str = os.environ.get("WEBAUTHN_RP_ID", "").strip()
    # Friendly name shown in the OS/browser passkey UI ("Sign in to <NAME>").
    WEBAUTHN_RP_NAME: str = os.environ.get("WEBAUTHN_RP_NAME", "Cairn Admin")
    # Comma-separated list of allowed origins (full https URLs incl. scheme +
    # port). The browser sends the origin in clientDataJSON; the server rejects
    # any assertion whose origin is not in this list. If empty, falls back to
    # ALLOWED_ORIGINS so a single-host deployment Just Works.
    _wa_origins_env: str = os.environ.get("WEBAUTHN_ORIGINS", "").strip()
    WEBAUTHN_ORIGINS: List[str] = (
        [o.strip().rstrip("/") for o in _wa_origins_env.split(",") if o.strip()]
        if _wa_origins_env
        else []
    )
    # Lifetime of the post-assertion admin session token in seconds. After this
    # the admin must complete another passkey gesture. Default 8 hours = one
    # workday.
    WEBAUTHN_SESSION_TTL_SECONDS: int = int(
        os.environ.get("WEBAUTHN_SESSION_TTL_SECONDS", str(8 * 60 * 60))
    )
    # When TRUE and an admin has at least one passkey registered, all admin
    # routes require a valid X-Admin-Session header in addition to the API key.
    # When FALSE, passkeys remain optional and act as a self-service hardening
    # the admin can enable per-machine. Default TRUE so leaked keys are
    # immediately useless once any passkey is registered.
    WEBAUTHN_ENFORCE: bool = os.environ.get("WEBAUTHN_ENFORCE", "true").lower() in ("1", "true", "yes")

    # --- Phase 2: region-restricted updates ---
    # Hard cap on the rectangle a non-admin contributor with the
    # ``region_overwrite`` permission may select, expressed in TILES (each
    # tile is TILE_SIZE blocks square; default 256×256 tiles ≡ 8192×8192
    # blocks). Admins are exempt. Enforced server-side in
    # ``/contribute/region-preview`` and ``/contribute/complete``.
    MAX_REGION_TILES_NON_ADMIN: int = int(
        os.environ.get("MAX_REGION_TILES_NON_ADMIN", str(256 * 256))
    )

    # Secret salt used to hash IP addresses before storing them (GDPR)
    IP_HASH_SALT: str = os.environ.get("IP_HASH_SALT", "")

    # Terms of service version. Bump to force re-acceptance on next /me load.
    TERMS_VERSION: str = os.environ.get("TERMS_VERSION", "2026-04-23")

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
