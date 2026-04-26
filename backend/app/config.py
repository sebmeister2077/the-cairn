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
