"""API key authentication dependencies."""

from typing import Optional

from fastapi import Header, HTTPException, Request

from .config import settings
from .core import database as db


def _get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _resolve_key(key: str, request: Request) -> Optional[dict]:
    """Validate a key and return its info dict, or None if invalid.

    Side-effects for DB keys: binds identity on first use (consume_once),
    and updates last_used_at.
    """
    # Admin env-var key — always valid, full access
    if settings.ADMIN_API_KEY and key == settings.ADMIN_API_KEY:
        return {"key": key, "permissions": "contribute", "is_admin": True}

    # Legacy env-var keys — always valid, full access
    if settings.API_KEYS and key in settings.API_KEYS:
        return {"key": key, "permissions": "contribute", "is_admin": False}

    # DB-backed dynamic keys
    if db.is_available():
        record = db.get_api_key(key)
        if record and not record["revoked"]:
            if record["consume_once"]:
                client_ip = _get_client_ip(request)
                bound = record.get("bound_identity")
                if bound is None:
                    db.bind_api_key(key, client_ip)
                elif bound != client_ip:
                    raise HTTPException(
                        status_code=401,
                        detail="API key is locked to another user",
                    )
            db.touch_api_key(key)
            return dict(record)

    return None


async def verify_api_key(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> str:
    """FastAPI dependency that validates the X-API-Key header."""
    await verify_api_key_info(request, x_api_key)
    return x_api_key


async def verify_api_key_info(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> dict:
    """Validate key and return resolved key metadata."""
    info = _resolve_key(x_api_key, request)
    if info is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return info


async def verify_contribute_permission(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> str:
    """Like verify_api_key but also requires 'contribute' permission."""
    info = await verify_api_key_info(request, x_api_key)
    if info.get("permissions") != "contribute":
        raise HTTPException(
            status_code=403,
            detail="This API key does not have contribute permission",
        )
    return x_api_key


async def require_admin(
    x_api_key: str = Header(..., alias="X-API-Key"),
) -> str:
    """FastAPI dependency that requires the admin API key."""
    if not settings.ADMIN_API_KEY or x_api_key != settings.ADMIN_API_KEY:
        raise HTTPException(status_code=403, detail="Admin access required")
    return x_api_key
