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


# Sanity bounds for admin-tunable numeric quotas. Format:
# ``key -> (default, hard_max)``. ``default`` is informational (the route
# handler is the source of truth and supplies its own default to
# ``feature_flags.get_int``). ``hard_max`` caps the value the admin can
# PATCH to — protects against fat-finger DoS (e.g. setting
# ``traders_max_batch`` to a million). Mirrored on the frontend as the
# ``max`` attribute on the numeric input.
QUOTA_FLAG_LIMITS: dict[str, tuple[int, int]] = {
    "traders_chatlog_daily_cap": (1, 50),
    "traders_manual_daily_cap": (15, 500),
    "traders_max_batch": (200, 2_000),
    "traders_dedupe_radius": (60, 1_000),
    "translocators_chatlog_daily_cap": (3, 100),
    "translocators_max_batch": (200, 2_000),
    "translocators_dedupe_radius": (200, 2_000),
    "translocator_screenshots_max_pending": (90, 1_000),
    "map_contribution_cooldown_days": (7, 365),
}


class FeatureFlagPatch(BaseModel):
    # Both optional so the admin UI can PATCH just the boolean toggle or
    # just the numeric quota in isolation. At least one must be present.
    enabled: Optional[bool] = None
    # ``None`` explicitly clears the override (handler default applies);
    # missing field leaves the existing value untouched.
    value_int: Optional[int] = None


def _scrub_flag(r: dict) -> dict:
    if r.get("updated_at") and hasattr(r["updated_at"], "isoformat"):
        r["updated_at"] = r["updated_at"].isoformat()
    raw = r.pop("updated_by_key_id", None)
    r["updated_by_suffix"] = (str(raw) or "")[-6:] if raw else None
    # value_int is part of the public admin payload; keep the key even
    # when NULL so the frontend can render "default" badges uniformly.
    r["value_int"] = r.get("value_int")
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

    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(
            status_code=400,
            detail="At least one of 'enabled' or 'value_int' is required",
        )

    # Validate the quota value against the per-key hard cap.
    if "value_int" in fields and fields["value_int"] is not None:
        vi = fields["value_int"]
        if not isinstance(vi, int) or isinstance(vi, bool):
            raise HTTPException(status_code=400, detail="value_int must be an integer")
        if vi < 0:
            raise HTTPException(status_code=400, detail="value_int must be >= 0")
        limit = QUOTA_FLAG_LIMITS.get(key)
        if limit is not None and vi > limit[1]:
            raise HTTPException(
                status_code=400,
                detail=f"value_int for {key} exceeds hard maximum {limit[1]}",
            )

    # Capture the previous state so we can react to OFF -> ON transitions
    # (e.g. kicking the eager compression migration runner).
    previous = db.get_feature_flag(key)
    was_enabled = bool(previous.get("enabled")) if previous else False

    set_kwargs: dict = {"updated_by_key": admin_key}
    if "enabled" in fields:
        set_kwargs["enabled"] = bool(fields["enabled"])
    if "value_int" in fields:
        set_kwargs["value_int"] = fields["value_int"]
    row = db.set_feature_flag(key, **set_kwargs)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Unknown feature flag: {key}")
    ff.invalidate(key)

    audit_meta: dict = {}
    if "enabled" in fields:
        audit_meta["enabled"] = bool(fields["enabled"])
    if "value_int" in fields:
        audit_meta["value_int"] = fields["value_int"]
    accounts_db.audit_log(
        admin_key,
        "feature_flag.toggle",
        target=key,
        metadata=audit_meta,
    )

    # Side effect: when the operator switches ``compress_artefacts`` from
    # OFF to ON, kick the eager migration so pre-existing raw archives are
    # converted to .zst in the background. The reverse direction does NOT
    # rehydrate (readers permanently support both formats).
    if (
        key == "compress_artefacts"
        and fields.get("enabled") is True
        and not was_enabled
    ):
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
