"""User-facing account endpoints (`/api/account/...`)."""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import (
    _get_client_ip,
    _hash_ip,
    _resolve_key,
    require_active_user,
)
from ..config import settings
from ..core import accounts_db
from ..core import database as db
from ..core.display_names import (
    is_forbidden_name,
    pick_unique_display_name,
)
from ..rate_limiter import check_scoped_rate_limit


router = APIRouter(prefix="/account", tags=["account"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    accept_terms: bool = Field(..., description="Must be true to register")


class UpdateProfileRequest(BaseModel):
    in_game_name: Optional[str] = None
    clear_in_game_name: bool = False
    is_hireable: Optional[bool] = None
    is_leaderboard_visible: Optional[bool] = None
    show_contributions: Optional[bool] = None


def _serialise_user(user: dict, include_key: bool = False) -> dict:
    """Strip / format fields for the API response."""
    if not user:
        return {}
    out = {
        "display_name": user.get("display_name"),
        "in_game_name": user.get("in_game_name"),
        "is_hireable": bool(user.get("is_hireable")),
        "is_leaderboard_visible": bool(user.get("is_leaderboard_visible")),
        "show_contributions": bool(user.get("show_contributions")),
        "genesis_for_ip": bool(user.get("genesis_for_ip")),
        "joined_at": user.get("joined_at"),
        "terms_version": user.get("terms_version"),
        "terms_accepted_at": user.get("terms_accepted_at"),
        "deleted_at": user.get("deleted_at"),
        "name_regen_count": user.get("name_regen_count", 0),
        "last_name_change_at": user.get("last_name_change_at"),
        "last_used_at": user.get("last_used_at"),
        "is_banned": bool(user.get("is_banned")),
        "flag_count": int(user.get("flag_count") or 0),
    }
    if include_key:
        out["api_key"] = user.get("api_key")
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/register")
async def register(
    request: Request,
    payload: RegisterRequest,
) -> dict:
    """Create a `users` row for the currently-presented API key.

    The key must already exist (e.g. just claimed via an invite). Admin and
    legacy env-var keys are not allowed to register.
    """
    if not payload.accept_terms:
        raise HTTPException(status_code=400, detail="You must accept the terms to register")

    api_key = request.headers.get("X-API-Key", "")
    info = _resolve_key(api_key, request)
    if info is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    if info.get("is_admin") or api_key in settings.API_KEYS:
        raise HTTPException(status_code=400, detail="Static / admin keys cannot register an account")

    # IP ban gate
    ip_hash = _hash_ip(_get_client_ip(request))
    if accounts_db.is_ip_banned(ip_hash):
        raise HTTPException(status_code=403, detail="Your IP is banned")

    existing = accounts_db.get_user(api_key)
    if existing:
        if existing.get("deleted_at") is not None:
            raise HTTPException(status_code=403, detail="Account was deleted. Contact admin to reactivate.")
        return {"user": _serialise_user(existing), "created": False}

    # Decide genesis_for_ip: first non-deleted account on this IP gets the flag.
    genesis = accounts_db.first_account_on_ip(ip_hash) is None

    # If non-genesis, also write a 'shared_ip' user_flag once we know our row exists.
    display_name = pick_unique_display_name(accounts_db.display_name_taken)
    user = accounts_db.create_user(
        api_key=api_key,
        display_name=display_name,
        terms_version=settings.TERMS_VERSION,
        genesis_for_ip=genesis,
    )

    if not genesis:
        try:
            accounts_db.create_user_flag(
                flagged_user=api_key,
                reason="shared_ip",
                metadata={"ip_hash": ip_hash},
            )
        except Exception:
            # Non-fatal: the flag is informational.
            pass

    return {"user": _serialise_user(user), "created": True}


@router.get("/me")
async def get_me(ctx: dict = Depends(require_active_user)) -> dict:
    user = ctx["user"]
    if user is None:
        # Synthetic admin path
        return {
            "user": None,
            "is_admin": True,
            "terms_version_current": settings.TERMS_VERSION,
            "terms_accepted_current": True,
        }
    fresh = accounts_db.get_user_with_key(ctx["key"]) or user
    return {
        "user": _serialise_user(fresh),
        "is_admin": bool(ctx["info"].get("is_admin")),
        "terms_version_current": settings.TERMS_VERSION,
        "terms_accepted_current": (fresh.get("terms_version") == settings.TERMS_VERSION),
    }


@router.patch("/me")
async def update_me(
    payload: UpdateProfileRequest,
    ctx: dict = Depends(require_active_user),
) -> dict:
    user = ctx["user"]
    if user is None:
        raise HTTPException(status_code=400, detail="Admin user has no editable profile")

    check_scoped_rate_limit(
        ctx["key"], "profile_update",
        settings.RATE_LIMIT_PROFILE_MAX, settings.RATE_LIMIT_PROFILE_WINDOW,
    )

    in_game_name = payload.in_game_name
    if in_game_name is not None:
        in_game_name = in_game_name.strip()
        if not in_game_name:
            in_game_name = None
            payload.clear_in_game_name = True
        elif len(in_game_name) > 64:
            raise HTTPException(status_code=400, detail="In-game name is too long")

    updated = accounts_db.update_user_profile(
        api_key=ctx["key"],
        in_game_name=in_game_name,
        clear_in_game_name=payload.clear_in_game_name,
        is_hireable=payload.is_hireable,
        is_leaderboard_visible=payload.is_leaderboard_visible,
        show_contributions=payload.show_contributions,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    # If the in-game name changed, raise duplicate flags against any existing
    # active accounts that share the same normalised name.
    if in_game_name and not payload.clear_in_game_name:
        normalised = accounts_db.normalise_ingame_name(in_game_name)
        if normalised:
            collisions = accounts_db.find_active_users_by_ingame_name(
                normalised, exclude_key=ctx["key"]
            )
            for other in collisions:
                try:
                    accounts_db.create_user_flag(
                        flagged_user=ctx["key"],
                        related_user=other["api_key"],
                        reason="duplicate_ingame_name",
                        metadata={"in_game_name": in_game_name},
                    )
                except Exception:
                    pass

    fresh = accounts_db.get_user_with_key(ctx["key"]) or updated
    return {"user": _serialise_user(fresh)}


@router.post("/regenerate-name")
async def regenerate_name(ctx: dict = Depends(require_active_user)) -> dict:
    user = ctx["user"]
    if user is None:
        raise HTTPException(status_code=400, detail="Admin user has no display name")

    check_scoped_rate_limit(
        ctx["key"], "regenerate_name",
        settings.RATE_LIMIT_REGEN_NAME_MAX, settings.RATE_LIMIT_REGEN_NAME_WINDOW,
    )

    new_name = pick_unique_display_name(accounts_db.display_name_taken)
    updated = accounts_db.regenerate_user_display_name(ctx["key"], new_name)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    fresh = accounts_db.get_user_with_key(ctx["key"]) or updated
    return {"user": _serialise_user(fresh)}


@router.get("/export")
async def export_data(ctx: dict = Depends(require_active_user)) -> dict:
    """Return everything we have on the user (GDPR export)."""
    user = ctx["user"]
    if user is None:
        raise HTTPException(status_code=400, detail="No exportable account")

    contributions = accounts_db.list_contributions_for_user(ctx["key"])
    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "user": _serialise_user(user, include_key=True),
        "contributions": contributions,
    }


@router.delete("/me")
async def delete_me(ctx: dict = Depends(require_active_user)) -> dict:
    """Soft-delete the account. The display name is replaced with a tombstone
    and the API key is revoked. Irreversible without admin help."""
    user = ctx["user"]
    if user is None:
        raise HTTPException(status_code=400, detail="Admin user cannot self-delete")

    tombstone = f"[deleted-{int(datetime.now(timezone.utc).timestamp())}]"
    deleted = accounts_db.soft_delete_user(ctx["key"], tombstone)
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")

    return {"ok": True, "tombstone": tombstone}
