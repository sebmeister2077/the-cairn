"""In-memory per-key rate limiter."""

import time
from collections import defaultdict
from typing import Dict, List, Tuple

from fastapi import HTTPException

from .config import settings


_requests: Dict[str, List[float]] = defaultdict(list)
_scoped_requests: Dict[Tuple[str, str], List[float]] = defaultdict(list)


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


def check_scoped_rate_limit(
    api_key: str,
    scope: str,
    max_requests: int,
    window_seconds: int,
) -> None:
    """Per-key, per-scope rate limit (e.g. ``check_scoped_rate_limit(key, "regen", 3, 86400)``).

    Raises 429 with a human-readable message when the limit is exceeded.
    """
    now = time.time()
    bucket_key = (api_key, scope)
    window_start = now - window_seconds

    timestamps = [ts for ts in _scoped_requests[bucket_key] if ts > window_start]

    if len(timestamps) >= max_requests:
        oldest = timestamps[0]
        retry_after = max(int(oldest + window_seconds - now), 1)
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit exceeded for '{scope}'. "
                f"Max {max_requests} per {window_seconds // 60} minutes. "
                f"Try again in {retry_after}s."
            ),
        )

    timestamps.append(now)
    _scoped_requests[bucket_key] = timestamps
