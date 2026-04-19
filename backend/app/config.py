"""Application settings loaded from environment variables."""

import os
from pathlib import Path
from typing import List

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
        o.strip()
        for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
        if o.strip()
    ]

    # Upload limit (bytes)
    MAX_UPLOAD_SIZE: int = int(os.environ.get("MAX_UPLOAD_SIZE", str(100 * 1024 * 1024)))


settings = Settings()
