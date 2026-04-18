"""API key authentication dependency."""

from fastapi import Header, HTTPException

from .config import settings


async def verify_api_key(x_api_key: str = Header(..., alias="X-API-Key")):
    """FastAPI dependency that validates the X-API-Key header."""
    if not settings.API_KEYS:
        raise HTTPException(status_code=500, detail="No API keys configured on server")
    if x_api_key not in settings.API_KEYS:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key
