"""Boat-friendly translocators — public read + admin toggle.

- ``GET  /api/boat-tls`` — public, returns the canonical id list the sailboat
  route planner uses to treat a TL as a navigable water-to-water portal.
- ``POST /api/admin/boat-tls/toggle`` — admin-only, add/remove one TL id.

Backed by a single ``boat_friendly_tls.json`` object in R2 (no audit) — see
``app/core/boat_tls_store.py``.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..core import boat_tls_store


logger = logging.getLogger("uvicorn.error")

router = APIRouter(tags=["boat-tls"])
admin_router = APIRouter(prefix="/admin/boat-tls", tags=["admin-boat-tls"])


@router.get("/boat-tls")
async def get_boat_friendly_tls() -> dict:
    tl_ids = await asyncio.to_thread(boat_tls_store.list_boat_friendly_tls)
    return {"tl_ids": tl_ids}


class ToggleBody(BaseModel):
    tl_id: str = Field(..., min_length=1, max_length=128)
    enabled: bool


@admin_router.post("/toggle")
async def toggle_boat_friendly_tl(
    payload: ToggleBody,
    api_key: str = Depends(require_admin),
) -> dict:
    try:
        boat_tls_store.canonical_tl_id(payload.tl_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    async with boat_tls_store.boat_friendly_tls_write_lock():
        tl_ids = await asyncio.to_thread(
            boat_tls_store.toggle_boat_friendly_tl,
            payload.tl_id,
            payload.enabled,
        )
    return {"tl_ids": tl_ids}
