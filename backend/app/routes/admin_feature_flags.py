"""Admin endpoints for feature flags (Phase 0b).

GET    /api/admin/feature-flags          — list all known flags
PATCH  /api/admin/feature-flags/{key}    — toggle a single flag
POST   /api/admin/map-lock/force-release — clear a stuck map lock
GET    /api/admin/map-lock                — view current lock state (debug)
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import require_admin
from ..core import accounts_db, database as db
from ..core import feature_flags as ff


router = APIRouter(prefix="/admin", tags=["admin-feature-flags"])


class FeatureFlagPatch(BaseModel):
    enabled: bool


def _scrub_flag(r: dict) -> dict:
    if r.get("updated_at") and hasattr(r["updated_at"], "isoformat"):
        r["updated_at"] = r["updated_at"].isoformat()
    raw = r.pop("updated_by_key", None)
    r["updated_by_suffix"] = (raw or "")[-6:] if raw else None
    return r


@router.get("/feature-flags")
async def list_flags(_: str = Depends(require_admin)):
    rows = db.list_feature_flags()
    return {"flags": [_scrub_flag(r) for r in rows]}


@router.patch("/feature-flags/{key}")
async def patch_flag(
    key: str,
    body: FeatureFlagPatch,
    admin_key: str = Depends(require_admin),
):
    # Trim incidental whitespace; a stray space in the key bypasses the
    # exact-match lookup callers use (``get_feature_flag(key)``) and the
    # update silently no-ops, leaving the wrong row enabled.
    key = key.strip()
    # Capture the previous state so we can react to OFF -> ON transitions
    # (e.g. kicking the eager compression migration runner).
    previous = db.get_feature_flag(key)
    was_enabled = bool(previous.get("enabled")) if previous else False

    row = db.set_feature_flag(key, body.enabled, updated_by_key=admin_key)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Unknown feature flag: {key}")
    ff.invalidate(key)
    accounts_db.audit_log(
        admin_key,
        "feature_flag.toggle",
        target=key,
        metadata={"enabled": body.enabled},
    )

    # Side effect: when the operator switches ``compress_artefacts`` from
    # OFF to ON, kick the eager migration so pre-existing raw archives are
    # converted to .zst in the background. The reverse direction does NOT
    # rehydrate (readers permanently support both formats).
    if key == "compress_artefacts" and body.enabled and not was_enabled:
        try:
            from ..tasks import compress_workers
            compress_workers.start_migration()
        except Exception:
            pass

    return {"flag": _scrub_flag(row)}


@router.get("/map-lock")
async def map_lock_status(_: str = Depends(require_admin)):
    info = db.get_map_lock_info()
    if info:
        for k in ("acquired_at", "expires_at"):
            v = info.get(k)
            if v and hasattr(v, "isoformat"):
                info[k] = v.isoformat()
    return {"lock": info}


@router.post("/map-lock/force-release")
async def map_lock_force_release(admin_key: str = Depends(require_admin)):
    released = db.force_release_map_lock()
    if released:
        accounts_db.audit_log(admin_key, "lock.force_release")
    return {"released": released}
