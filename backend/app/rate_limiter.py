"""In-memory per-key rate limiter."""

import time
from collections import defaultdict
from typing import Dict, List

from fastapi import HTTPException

from .config import settings


_requests: Dict[str, List[float]] = defaultdict(list)


def check_rate_limit(api_key: str) -> None:
    """Raise 429 if the key has exceeded the rate limit window."""
    now = time.time()
    window_start = now - settings.RATE_LIMIT_WINDOW

    # Prune old timestamps
    _requests[api_key] = [
        ts for ts in _requests[api_key] if ts > window_start
    ]

    if len(_requests[api_key]) >= settings.RATE_LIMIT_MAX:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit exceeded. Max {settings.RATE_LIMIT_MAX} requests "
                f"per {settings.RATE_LIMIT_WINDOW // 60} minutes."
            ),
        )

    _requests[api_key].append(now)
