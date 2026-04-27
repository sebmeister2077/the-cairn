"""Admin endpoints for the account system.

All routes require the ADMIN_API_KEY env-var key via ``require_admin``.

GET    /api/admin/users                          — list users (search/sort/filter/paginate)
GET    /api/admin/users/stats                    — aggregate counts (cached)
GET    /api/admin/users/{api_key}                — single user
GET    /api/admin/users/{api_key}/siblings       — accounts on the same IP hash
POST   /api/admin/users/{api_key}/regenerate-name
POST   /api/admin/users/{api_key}/rekey          — rotate to a new API key
POST   /api/admin/users/{api_key}/reactivate     — undelete
DELETE /api/admin/users/{api_key}                — soft-delete
GET    /api/admin/users/{api_key}/ban-preview    — list users that would be revoked by ban
POST   /api/admin/users/{api_key}/ban            — ban the IP and revoke siblings
GET    /api/admin/ip-bans                        — list active bans
DELETE /api/admin/ip-bans/{ip_hash}              — lift a ban (also un-revokes keys?)
GET    /api/admin/flags                          — list user flags
POST   /api/admin/flags/{flag_id}/resolve        — resolve a flag
"""

import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..config import settings
from ..core import accounts_db
from ..core import database as db
from ..core.display_names import pick_unique_display_name


router = APIRouter(prefix="/admin", tags=["admin-users"])


VALID_BAN_REASONS = {
    "spam", "impersonation", "abuse", "harassment",
    "duplicate_account", "provocative_name", "other",
}
VALID_FLAG_RESOLUTIONS = {"valid", "abuse", "dismissed"}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class BanRequest(BaseModel):
    reason_code: str = Field(..., description="One of VALID_BAN_REASONS")
    reason: str = Field(..., min_length=1, max_length=500)
    admin_notes: Optional[str] = Field(None, max_length=2000)
    duration_days: Optional[int] = Field(
        default=None,
        description=f"Ban duration in days. Defaults to {settings.IP_BAN_DEFAULT_DAYS}.",
    )


class ResolveFlagRequest(BaseModel):
    resolution: str = Field(..., description="One of VALID_FLAG_RESOLUTIONS")


class ReactivateResponse(BaseModel):
    ok: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialise_user(user: Optional[dict]) -> Optional[dict]:
    if user is None:
        return None
    out = dict(user)
    for k in ("joined_at", "deleted_at", "last_name_change_at",
              "terms_accepted_at", "last_used_at"):
        val = out.get(k)
        if val and hasattr(val, "isoformat"):
            out[k] = val.isoformat()
    return out


def _serialise_ban(ban: dict) -> dict:
    out = dict(ban)
    for k in ("banned_at", "expires_at"):
        val = out.get(k)
        if val and hasattr(val, "isoformat"):
            out[k] = val.isoformat()
    return out


def _serialise_flag(flag: dict) -> dict:
    out = dict(flag)
    for k in ("created_at", "resolved_at"):
        val = out.get(k)
        if val and hasattr(val, "isoformat"):
            out[k] = val.isoformat()
    return out


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

@router.get("/users")
async def list_users(
    q: str = "",
    sort: str = "joined_at",
    cursor: Optional[int] = None,
    limit: int = Query(20, ge=1, le=100),
    flagged: bool = False,
    banned: bool = False,
    genesis: bool = False,
    include_deleted: bool = True,
    _: str = Depends(require_admin),
) -> dict:
    result = accounts_db.list_users(
        query=q,
        sort_by=sort,
        cursor=cursor,
        limit=limit,
        filter_flagged=flagged,
        filter_banned=banned,
        filter_genesis=genesis,
        include_deleted=include_deleted,
    )
    return {
        "users": [_serialise_user(u) for u in result["users"]],
        "next_cursor": result["next_cursor"],
    }


@router.get("/users/stats")
async def get_stats(
    refresh: bool = False,
    _: str = Depends(require_admin),
) -> dict:
    if not refresh:
        cached = accounts_db.get_cached_user_stats()
        if cached is not None:
            return {"stats": cached, "cached": True}
    stats = accounts_db.get_user_stats()
    accounts_db.set_cached_user_stats(stats)
    return {"stats": stats, "cached": False}


@router.get("/users/{api_key}")
async def get_user(api_key: str, _: str = Depends(require_admin)) -> dict:
    user = accounts_db.get_user_with_key(api_key)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {"user": _serialise_user(user)}


@router.get("/users/{api_key}/siblings")
async def get_siblings(api_key: str, _: str = Depends(require_admin)) -> dict:
    siblings = accounts_db.get_sibling_users(api_key)
    return {"siblings": [_serialise_user(s) for s in siblings]}


@router.post("/users/{api_key}/regenerate-name")
async def admin_regenerate_name(
    api_key: str,
    admin_key: str = Depends(require_admin),
) -> dict:
    new_name = pick_unique_display_name(accounts_db.display_name_taken)
    updated = accounts_db.regenerate_user_display_name(api_key, new_name)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    accounts_db.audit_log(
        admin_key, "regenerate_name",
        target=api_key,
        metadata={"new_name": new_name},
    )
    return {"user": _serialise_user(accounts_db.get_user_with_key(api_key))}


@router.post("/users/{api_key}/rekey")
async def admin_rekey(
    api_key: str,
    admin_key: str = Depends(require_admin),
) -> dict:
    """Issue a new API key for the user and revoke the old one.

    Returns the **new key once** — the admin must securely deliver it to the user.
    """
    user = accounts_db.get_user(api_key)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    new_key = secrets.token_urlsafe(32)
    db.create_api_key(
        new_key,
        name=f"Re-key for {user.get('display_name')}",
        permissions="contribute",
        consume_once=False,
    )
    moved = accounts_db.rekey_user(api_key, new_key)
    if not moved:
        raise HTTPException(status_code=500, detail="Re-key failed")

    accounts_db.audit_log(
        admin_key, "rekey",
        target=api_key,
        metadata={"new_key_prefix": new_key[:8]},
    )
    return {"new_api_key": new_key, "user": _serialise_user(accounts_db.get_user_with_key(new_key))}


@router.post("/users/{api_key}/reactivate")
async def admin_reactivate(
    api_key: str,
    admin_key: str = Depends(require_admin),
) -> dict:
    updated = accounts_db.reactivate_user(api_key)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    accounts_db.audit_log(admin_key, "reactivate", target=api_key)
    return {"user": _serialise_user(accounts_db.get_user_with_key(api_key))}


@router.delete("/users/{api_key}")
async def admin_soft_delete(
    api_key: str,
    admin_key: str = Depends(require_admin),
) -> dict:
    tombstone = f"[deleted-{int(datetime.now(timezone.utc).timestamp())}]"
    deleted = accounts_db.soft_delete_user(api_key, tombstone)
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")
    accounts_db.audit_log(admin_key, "soft_delete", target=api_key,
                          metadata={"tombstone": tombstone})
    return {"ok": True, "tombstone": tombstone}


# ---------------------------------------------------------------------------
# Ban flow (preview + commit)
# ---------------------------------------------------------------------------

@router.get("/users/{api_key}/ban-preview")
async def ban_preview(api_key: str, _: str = Depends(require_admin)) -> dict:
    """Return the blast radius of banning this user's IP."""
    record = db.get_api_key(api_key)
    if not record:
        raise HTTPException(status_code=404, detail="API key not found")
    ip_hash = record.get("bound_identity")
    if not ip_hash:
        return {"ip_hash": None, "affected_users": []}
    affected = accounts_db.list_users_for_ip_hash(ip_hash)
    return {
        "ip_hash": ip_hash,
        "affected_users": [_serialise_user(u) for u in affected],
    }


@router.post("/users/{api_key}/ban")
async def ban_user(
    api_key: str,
    payload: BanRequest,
    admin_key: str = Depends(require_admin),
) -> dict:
    if payload.reason_code not in VALID_BAN_REASONS:
        raise HTTPException(status_code=400, detail=f"Invalid reason_code. Must be one of {sorted(VALID_BAN_REASONS)}")

    record = db.get_api_key(api_key)
    if not record:
        raise HTTPException(status_code=404, detail="API key not found")
    ip_hash = record.get("bound_identity")
    if not ip_hash:
        raise HTTPException(status_code=400, detail="User has no bound IP — cannot ban")

    duration_days = payload.duration_days or settings.IP_BAN_DEFAULT_DAYS
    expires_at = datetime.now(timezone.utc) + timedelta(days=duration_days)

    ban = accounts_db.create_ip_ban(
        ip_hash=ip_hash,
        reason_code=payload.reason_code,
        reason=payload.reason,
        admin_notes=payload.admin_notes,
        banned_by=admin_key,
        expires_at=expires_at,
    )
    revoked = accounts_db.revoke_keys_for_ip_hash(ip_hash)

    # Soft-delete every active user on this IP.
    affected = accounts_db.list_users_for_ip_hash(ip_hash)
    deleted_count = 0
    for u in affected:
        if u.get("deleted_at") is None:
            tombstone = f"[banned-{int(datetime.now(timezone.utc).timestamp())}-{deleted_count}]"
            if accounts_db.soft_delete_user(u["api_key"], tombstone):
                deleted_count += 1

    accounts_db.audit_log(
        admin_key, "ban_ip",
        target=ip_hash,
        metadata={
            "reason_code": payload.reason_code,
            "reason": payload.reason,
            "revoked_keys": revoked,
            "deleted_users": deleted_count,
            "triggered_by_user": api_key,
        },
    )
    return {
        "ban": _serialise_ban(ban),
        "revoked_keys": revoked,
        "deleted_users": deleted_count,
    }


# ---------------------------------------------------------------------------
# IP bans
# ---------------------------------------------------------------------------

@router.get("/ip-bans")
async def list_bans(
    cursor: Optional[int] = None,
    limit: int = Query(50, ge=1, le=200),
    _: str = Depends(require_admin),
) -> dict:
    result = accounts_db.list_ip_bans(cursor=cursor, limit=limit)
    return {
        "bans": [_serialise_ban(b) for b in result["bans"]],
        "next_cursor": result["next_cursor"],
    }


@router.delete("/ip-bans/{ip_hash}")
async def unban_ip(ip_hash: str, admin_key: str = Depends(require_admin)) -> dict:
    if not accounts_db.delete_ip_ban(ip_hash):
        raise HTTPException(status_code=404, detail="Ban not found")
    accounts_db.audit_log(admin_key, "unban_ip", target=ip_hash)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------

@router.get("/flags")
async def list_flags(
    unresolved_only: bool = True,
    reason: Optional[str] = None,
    flagged_user: Optional[str] = None,
    cursor: Optional[int] = None,
    limit: int = Query(50, ge=1, le=200),
    _: str = Depends(require_admin),
) -> dict:
    result = accounts_db.list_user_flags(
        unresolved_only=unresolved_only,
        reason=reason,
        flagged_user=flagged_user,
        cursor=cursor,
        limit=limit,
    )
    return {
        "flags": [_serialise_flag(f) for f in result["flags"]],
        "next_cursor": result["next_cursor"],
    }


@router.post("/flags/{flag_id}/resolve")
async def resolve_flag(
    flag_id: int,
    payload: ResolveFlagRequest,
    admin_key: str = Depends(require_admin),
) -> dict:
    if payload.resolution not in VALID_FLAG_RESOLUTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid resolution. Must be one of {sorted(VALID_FLAG_RESOLUTIONS)}",
        )
    resolved = accounts_db.resolve_user_flag(flag_id, admin_key, payload.resolution)
    if not resolved:
        raise HTTPException(status_code=404, detail="Flag not found")
    accounts_db.audit_log(
        admin_key, "resolve_flag",
        target=str(flag_id),
        metadata={"resolution": payload.resolution},
    )
    return {"flag": _serialise_flag(resolved)}


# ---------------------------------------------------------------------------
# Granular per-key permissions (Phase 0c)
# ---------------------------------------------------------------------------

# Whitelist of permission names accepted by the toggle endpoint. Keep this
# narrow so admins can't typo a permission into existence.
VALID_KEY_PERMISSIONS = {"region_overwrite"}


class KeyPermissionPatch(BaseModel):
    permission: str = Field(..., description="One of VALID_KEY_PERMISSIONS")
    enabled: bool


@router.get("/users/{api_key}/permissions")
async def get_key_permissions(api_key: str, _: str = Depends(require_admin)):
    record = db.get_api_key(api_key)
    if not record:
        raise HTTPException(status_code=404, detail="API key not found")
    return {"key": api_key, "extra_permissions": db.get_api_key_extra_permissions(api_key)}


@router.patch("/users/{api_key}/permissions")
async def patch_key_permission(
    api_key: str,
    body: KeyPermissionPatch,
    admin_key: str = Depends(require_admin),
):
    if body.permission not in VALID_KEY_PERMISSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown permission. Allowed: {sorted(VALID_KEY_PERMISSIONS)}",
        )
    record = db.get_api_key(api_key)
    if not record:
        raise HTTPException(status_code=404, detail="API key not found")
    updated = db.set_api_key_extra_permission(api_key, body.permission, body.enabled)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update permission")
    accounts_db.audit_log(
        admin_key,
        "permission.grant" if body.enabled else "permission.revoke",
        target=api_key,
        metadata={"permission": body.permission},
    )
    return {
        "key": api_key,
        "extra_permissions": db.get_api_key_extra_permissions(api_key),
    }
