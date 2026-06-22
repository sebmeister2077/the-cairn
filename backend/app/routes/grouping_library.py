"""Community "Groupings Library" endpoints.

Lets users publish their local TL groupings (see frontend ``tl-groupings.ts``)
so others can browse, search, fork, or subscribe. Post-moderated: groupings go
live immediately; abuse is handled reactively via reports + admin takedown.

Gated by the ``grouping_library_enabled`` feature flag — when OFF every
endpoint here returns 404 so the feature is invisible. Publishing additionally
requires an account at least 1 day old (``require_publisher``).

See plans/global-groupings-library-plan.prompt.md and
docs/multiplayer/groupings-library.md.
"""

from __future__ import annotations

import logging
import re
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import (
    is_admin_key,
    require_active_user,
    require_admin,
    require_publisher,
    verify_api_key_info,
)
from ..core import accounts_db
from ..core import api_key_cache
from ..core import feature_flags
from ..core import grouping_library_db as lib
from ..rate_limiter import check_scoped_rate_limit


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["grouping-library"])

_FLAG_KEY = "grouping_library_enabled"
_PUBLISH_CAP_FLAG = "grouping_library_publish_daily_cap"
_PUBLISH_CAP_DEFAULT = 5
_EDIT_CAP_FLAG = "grouping_library_edit_daily_cap"
_EDIT_CAP_DEFAULT = 10
_MAX_TLS_FLAG = "grouping_library_max_tls"
_MAX_TLS_DEFAULT = 500
_MAX_TAGS_FLAG = "grouping_library_max_tags"
_MAX_TAGS_DEFAULT = 5

_PUBLISH_SCOPE = "grouping-library-publish"
_REPORT_SCOPE = "grouping-library-report"
_DAY = 86400

_NAME_MAX = 80
_DESC_MAX = 500
_TAG_MAX = 24
_TLID_MAX = 64
_CHANGE_NOTE_MAX = 200
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_TLID_RE = re.compile(r"^-?\d+,-?\d+,-?\d+,-?\d+$")
_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9 \-]*$")

_REPORT_REASONS = {"spam", "offensive", "inaccurate", "duplicate", "other"}

_FLAG_OFF = HTTPException(status_code=404, detail="Not found")


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class PublishBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=_NAME_MAX)
    description: Optional[str] = Field(default=None, max_length=_DESC_MAX)
    color: Optional[str] = Field(default=None, max_length=16)
    tlIds: List[str] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    # When True the publish endpoint will skip the per-author duplicate
    # check (used by the frontend after the user has explicitly confirmed
    # they want a second copy of an existing grouping).
    allowDuplicate: bool = False


class EditBody(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=_NAME_MAX)
    description: Optional[str] = Field(default=None, max_length=_DESC_MAX)
    color: Optional[str] = Field(default=None, max_length=16)
    tlIds: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    changeNote: Optional[str] = Field(default=None, max_length=_CHANGE_NOTE_MAX)
    allowDuplicate: bool = False


class InstallBody(BaseModel):
    mode: str = Field(..., pattern="^(fork|subscribe)$")
    version: Optional[int] = Field(default=None, ge=1)


class UnpublishBody(BaseModel):
    # Optional pointer to a replacement grouping. When set, subscribers see
    # ``successor_id`` on their subscription and can re-subscribe there.
    successorId: Optional[str] = Field(default=None, max_length=64)


class ReportBody(BaseModel):
    reason: str = Field(..., max_length=32)
    details: Optional[str] = Field(default=None, max_length=_DESC_MAX)


class AdminRemoveBody(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=_DESC_MAX)


class AdminOfficialBody(BaseModel):
    official: bool


class ResolveReportBody(BaseModel):
    dismiss: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ensure_enabled() -> None:
    if not feature_flags.is_feature_enabled(_FLAG_KEY):
        raise _FLAG_OFF


def _key_id_for(api_key: str) -> str:
    kid = api_key_cache.ensure_id(api_key)
    if kid is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return str(kid)


def _viewer_key_id(api_key: Optional[str]) -> Optional[str]:
    if not api_key:
        return None
    kid = api_key_cache.ensure_id(api_key)
    return str(kid) if kid else None


def _clean_tlids(raw: List[str]) -> List[str]:
    seen: set = set()
    out: List[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if len(s) > _TLID_MAX or not _TLID_RE.match(s):
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _clean_tags(raw: List[str], max_tags: int) -> List[str]:
    seen: set = set()
    out: List[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        s = item.strip().lower()
        if not s or len(s) > _TAG_MAX or not _TAG_RE.match(s):
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
        if len(out) >= max_tags:
            break
    return out


def _clean_color(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    s = raw.strip()
    return s if _COLOR_RE.match(s) else None


def _clean_text(raw: Optional[str], max_len: int) -> Optional[str]:
    if raw is None:
        return None
    # Strip control chars + angle brackets to avoid stored-markup surprises.
    cleaned = re.sub(r"[\x00-\x1f<>]", "", raw).strip()
    if not cleaned:
        return None
    return cleaned[:max_len]


def _validated_payload(tl_ids: List[str]) -> List[str]:
    cleaned = _clean_tlids(tl_ids)
    if not cleaned:
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_grouping", "message": "A grouping needs at least one valid translocator."},
        )
    cap = feature_flags.get_int(_MAX_TLS_FLAG, _MAX_TLS_DEFAULT)
    if len(cleaned) > cap:
        raise HTTPException(
            status_code=400,
            detail={"code": "too_many_tls", "message": f"A grouping may contain at most {cap} translocators."},
        )
    return cleaned


# ---------------------------------------------------------------------------
# Read endpoints
# ---------------------------------------------------------------------------

@router.get("/groupings/library")
async def browse_library(
    request: Request,
    q: Optional[str] = None,
    tag: Optional[str] = None,
    sort: str = "popular",
    official_only: bool = False,
    page: int = 1,
    page_size: int = 20,
    info: dict = Depends(verify_api_key_info),
) -> dict:
    _ensure_enabled()
    viewer = _viewer_key_id(request.headers.get("X-API-Key"))
    q_clean = _clean_text(q, 80) if q else None
    tag_clean = (tag.strip().lower() if tag else None) or None
    return lib.browse(
        q=q_clean,
        tag=tag_clean,
        sort=sort,
        official_only=official_only,
        page=page,
        page_size=page_size,
        viewer_api_key_id=viewer,
    )


@router.get("/groupings/library/mine")
async def my_library(request: Request,
    info: dict = Depends(verify_api_key_info)) -> dict:
    _ensure_enabled()
    kid = _viewer_key_id(request.headers.get("X-API-Key"))
    return {"items": lib.list_mine(kid)}


@router.get("/groupings/library/subscriptions")
async def my_subscriptions(request: Request,
    info: dict = Depends(verify_api_key_info)) -> dict:
    _ensure_enabled()
    kid = _viewer_key_id(request.headers.get("X-API-Key"))
    return {"items": lib.list_subscriptions(kid)}


@router.get("/groupings/library/{grouping_id}")
async def library_detail(
    grouping_id: str,
    request: Request,
    info: dict = Depends(verify_api_key_info),
) -> dict:
    _ensure_enabled()
    viewer = _viewer_key_id(request.headers.get("X-API-Key"))
    card = lib.get_head(grouping_id, viewer_api_key_id=viewer)
    if card is None or card.get("status") != "published":
        raise HTTPException(status_code=404, detail="Grouping not found")
    return card


@router.get("/groupings/library/{grouping_id}/history")
async def library_history(
    grouping_id: str,
    info: dict = Depends(verify_api_key_info),
) -> dict:
    _ensure_enabled()
    head = lib.get_head(grouping_id)
    if head is None:
        raise HTTPException(status_code=404, detail="Grouping not found")
    return {"items": lib.list_history(grouping_id)}


@router.get("/groupings/library/{grouping_id}/versions/{version}")
async def library_version(
    grouping_id: str,
    version: int,
    info: dict = Depends(verify_api_key_info),
) -> dict:
    _ensure_enabled()
    snap = lib.get_version(grouping_id, version)
    if snap is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return snap


@router.get("/users/{api_key_id}/reputation")
async def user_reputation(
    api_key_id: str,
    info: dict = Depends(verify_api_key_info),
) -> dict:
    _ensure_enabled()
    return lib.get_reputation(api_key_id)


@router.get("/groupings/library/tags/popular")
async def popular_tags(
    q: Optional[str] = None,
    limit: int = 20,
    info: dict = Depends(verify_api_key_info),
) -> dict:
    """Autocomplete source for the publish dialog tag input.

    Returns the most-used tags across published groupings (optionally
    filtered by a case-insensitive prefix). The frontend renders these as a
    dropdown so users converge on a canonical vocabulary instead of
    fragmenting it ("elk" vs "Elk" vs "elk-friendly").
    """
    _ensure_enabled()
    return {"items": lib.popular_tags(q=q, limit=max(1, min(limit, 50)))}


# ---------------------------------------------------------------------------
# User write endpoints
# ---------------------------------------------------------------------------

@router.post("/groupings/library")
async def publish(
    body: PublishBody,
    background_tasks: BackgroundTasks,
    ctx: dict = Depends(require_publisher),
) -> dict:
    _ensure_enabled()
    api_key = ctx["key"]
    cap = feature_flags.get_int(_PUBLISH_CAP_FLAG, _PUBLISH_CAP_DEFAULT)
    check_scoped_rate_limit(api_key, _PUBLISH_SCOPE, cap, _DAY)

    name = _clean_text(body.name, _NAME_MAX)
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    tl_ids = _validated_payload(body.tlIds)
    tags = _clean_tags(body.tags, feature_flags.get_int(_MAX_TAGS_FLAG, _MAX_TAGS_DEFAULT))
    kid = _key_id_for(api_key)

    if not body.allowDuplicate:
        existing = lib.find_duplicate_for_author(kid, tl_ids)
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "duplicate_payload",
                    "message": "You already have a published grouping with these translocators.",
                    "existing": existing,
                },
            )

    head = lib.publish_grouping(
        author_api_key_id=kid,
        name=name,
        description=_clean_text(body.description, _DESC_MAX),
        color=_clean_color(body.color),
        tl_ids=tl_ids,
        tags=tags,
    )
    # ``publish_grouping`` already ran a synchronous recompute (so the
    # response below shows fresh stats), but we also schedule a no-op safety
    # net to keep the formula consistent if any concurrent vote slipped in.
    background_tasks.add_task(lib.recompute_reputation, kid)
    return lib.get_head(head["id"], viewer_api_key_id=kid)


@router.patch("/groupings/library/{grouping_id}")
async def edit(
    grouping_id: str,
    body: EditBody,
    background_tasks: BackgroundTasks,
    ctx: dict = Depends(require_publisher),
) -> dict:
    _ensure_enabled()
    api_key = ctx["key"]
    kid = _key_id_for(api_key)
    owner = lib.get_owner_id(grouping_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="Grouping not found")
    is_admin = is_admin_key(api_key)
    if owner != kid and not is_admin:
        raise HTTPException(status_code=403, detail="You do not own this grouping")

    # Per-grouping daily edit cap (admins bypass). Tunable via the
    # ``grouping_library_edit_daily_cap`` feature flag.
    if not is_admin:
        edit_cap = feature_flags.get_int(_EDIT_CAP_FLAG, _EDIT_CAP_DEFAULT)
        check_scoped_rate_limit(api_key, f"grouping-edit:{grouping_id}", edit_cap, _DAY)

    tl_ids = _validated_payload(body.tlIds) if body.tlIds is not None else None
    tags = (
        _clean_tags(body.tags, feature_flags.get_int(_MAX_TAGS_FLAG, _MAX_TAGS_DEFAULT))
        if body.tags is not None
        else None
    )
    if tl_ids is not None and not body.allowDuplicate:
        existing = lib.find_duplicate_for_author(kid, tl_ids, exclude_id=grouping_id)
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "duplicate_payload",
                    "message": "You already have another published grouping with these translocators.",
                    "existing": existing,
                },
            )
    updated = lib.edit_grouping(
        grouping_id=grouping_id,
        editor_api_key_id=kid,
        name=_clean_text(body.name, _NAME_MAX) if body.name is not None else None,
        description=_clean_text(body.description, _DESC_MAX) if body.description is not None else None,
        color=_clean_color(body.color) if body.color is not None else None,
        tl_ids=tl_ids,
        tags=tags,
        change_note=_clean_text(body.changeNote, _CHANGE_NOTE_MAX),
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Grouping not found")
    background_tasks.add_task(lib.recompute_reputation, kid)
    return lib.get_head(grouping_id, viewer_api_key_id=kid)


@router.delete("/groupings/library/{grouping_id}")
async def unpublish(
    grouping_id: str,
    body: Optional[UnpublishBody] = None,
    ctx: dict = Depends(require_active_user),
) -> dict:
    _ensure_enabled()
    api_key = ctx["key"]
    kid = _key_id_for(api_key)
    head = lib.get_head(grouping_id)
    if head is None:
        raise HTTPException(status_code=404, detail="Grouping not found")
    owner = head.get("author_api_key_id")
    if owner != kid and not is_admin_key(api_key):
        raise HTTPException(status_code=403, detail="You do not own this grouping")
    successor_id = body.successorId.strip() if body and body.successorId else None
    if successor_id:
        # Validate the successor exists and is itself published; ignore
        # silently otherwise so a stale id doesn't block retirement.
        succ = lib.get_head(successor_id)
        if succ is None or succ.get("status") != "published":
            successor_id = None
    lib.unpublish_grouping(
        grouping_id=grouping_id,
        actor_api_key_id=kid,
        successor_id=successor_id,
    )
    return {"ok": True, "status": "deprecated", "successor_id": successor_id}


@router.post("/groupings/library/{grouping_id}/vote")
async def upvote(
    grouping_id: str,
    background_tasks: BackgroundTasks,
    ctx: dict = Depends(require_active_user),
) -> dict:
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    head = lib.get_head(grouping_id)
    if head is None or head.get("status") != "published":
        raise HTTPException(status_code=404, detail="Grouping not found")
    author = lib.add_vote(grouping_id, kid)
    if author:
        # Full aggregate runs after we've already returned, so the click
        # feels instant. The inline delta inside add_vote already kept the
        # cached score roughly correct in the meantime.
        background_tasks.add_task(lib.recompute_reputation, author)
    return lib.get_head(grouping_id, viewer_api_key_id=kid)


@router.delete("/groupings/library/{grouping_id}/vote")
async def remove_upvote(
    grouping_id: str,
    background_tasks: BackgroundTasks,
    ctx: dict = Depends(require_active_user),
) -> dict:
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    author = lib.remove_vote(grouping_id, kid)
    if author:
        background_tasks.add_task(lib.recompute_reputation, author)
    return lib.get_head(grouping_id, viewer_api_key_id=kid)


@router.post("/groupings/library/{grouping_id}/install")
async def install(
    grouping_id: str,
    body: InstallBody,
    request: Request,
    background_tasks: BackgroundTasks,
) -> dict:
    _ensure_enabled()
    # Forking and subscribing are open to anonymous viewers — they just won't
    # have their install counted toward popularity or tracked server-side for
    # update notifications. Authenticated users still get a recorded install.
    kid = _viewer_key_id(request.headers.get("X-API-Key"))
    head = lib.get_head(grouping_id)
    # Allow installing deprecated groupings (so existing subscribers can
    # re-sync), but not removed ones.
    if head is None or head.get("status") not in ("published", "deprecated"):
        raise HTTPException(status_code=404, detail="Grouping not found")
    head_version = int(head["version"])

    if body.mode == "fork":
        version = body.version or head_version
        snap = lib.get_version(grouping_id, version)
        if snap is None:
            raise HTTPException(status_code=404, detail="Version not found")
        if kid:
            inserted, author = lib.record_install(
                grouping_id=grouping_id, api_key_id=kid, mode="fork",
                forked_from_version=version,
            )
            if inserted and author:
                background_tasks.add_task(lib.recompute_reputation, author)
        return {
            "ok": True,
            "mode": "fork",
            "grouping": {
                "libraryId": grouping_id,
                "name": snap["name"],
                "description": snap.get("description"),
                "color": snap.get("color"),
                "tags": snap.get("tags") or [],
                "tlIds": snap.get("tlIds") or [],
                "author": head.get("author"),
                "version": version,
            },
        }

    # subscribe
    if kid:
        inserted, author = lib.record_install(
            grouping_id=grouping_id, api_key_id=kid, mode="subscribe",
            synced_version=head_version,
        )
        if inserted and author:
            background_tasks.add_task(lib.recompute_reputation, author)
    return {
        "ok": True,
        "mode": "subscribe",
        "grouping": {
            "libraryId": grouping_id,
            "name": head["name"],
            "description": head.get("description"),
            "color": head.get("color"),
            "tags": head.get("tags") or [],
            "tlIds": head.get("tlIds") or [],
            "author": head.get("author"),
            "version": head_version,
        },
    }


@router.delete("/groupings/library/{grouping_id}/install")
async def uninstall(
    grouping_id: str,
    background_tasks: BackgroundTasks,
    ctx: dict = Depends(require_active_user),
) -> dict:
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    author = lib.remove_install(grouping_id, kid)
    if author:
        background_tasks.add_task(lib.recompute_reputation, author)
    return {"ok": True}


@router.post("/groupings/library/{grouping_id}/report")
async def report(grouping_id: str, body: ReportBody, ctx: dict = Depends(require_active_user)) -> dict:
    _ensure_enabled()
    api_key = ctx["key"]
    kid = _key_id_for(api_key)
    head = lib.get_head(grouping_id)
    if head is None:
        raise HTTPException(status_code=404, detail="Grouping not found")
    check_scoped_rate_limit(api_key, _REPORT_SCOPE, 10, _DAY)
    reason = body.reason.strip().lower()
    if reason not in _REPORT_REASONS:
        reason = "other"
    lib.add_report(
        grouping_id=grouping_id,
        reporter_api_key_id=kid,
        reason=reason,
        details=_clean_text(body.details, _DESC_MAX),
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

@router.get("/admin/groupings/reports")
async def admin_reports(admin_key: str = Depends(require_admin)) -> dict:
    return {"items": lib.list_open_reports()}


@router.post("/admin/groupings/{grouping_id}/remove")
async def admin_remove_grouping(
    grouping_id: str,
    body: AdminRemoveBody,
    background_tasks: BackgroundTasks,
    admin_key: str = Depends(require_admin),
) -> dict:
    admin_kid = _key_id_for(admin_key)
    reason = _clean_text(body.reason, _DESC_MAX)
    author = lib.admin_remove(grouping_id, admin_api_key_id=admin_kid, reason=reason)
    if author is None:
        raise HTTPException(status_code=404, detail="Grouping not found or already removed")
    background_tasks.add_task(lib.recompute_reputation, author)
    accounts_db.audit_log(admin_key, "grouping.remove", target=grouping_id,
                          metadata={"reason": reason})
    return {"ok": True}


@router.post("/admin/groupings/{grouping_id}/official")
async def admin_set_official(
    grouping_id: str,
    body: AdminOfficialBody,
    background_tasks: BackgroundTasks,
    admin_key: str = Depends(require_admin),
) -> dict:
    author = lib.set_official(grouping_id, is_official=body.official)
    if author is None and lib.get_head(grouping_id) is None:
        raise HTTPException(status_code=404, detail="Grouping not found")
    if author:
        background_tasks.add_task(lib.recompute_reputation, author)
    accounts_db.audit_log(admin_key, "grouping.official", target=grouping_id,
                          metadata={"official": body.official})
    return {"ok": True}


@router.post("/admin/groupings/reports/{report_id}/resolve")
async def admin_resolve_report(
    report_id: int,
    body: ResolveReportBody,
    admin_key: str = Depends(require_admin),
) -> dict:
    admin_kid = _key_id_for(admin_key)
    ok = lib.resolve_report(report_id, resolver_api_key_id=admin_kid, dismiss=body.dismiss)
    if not ok:
        raise HTTPException(status_code=404, detail="Report not found or already resolved")
    accounts_db.audit_log(admin_key, "grouping.report.resolve", target=str(report_id),
                          metadata={"dismiss": body.dismiss})
    return {"ok": True}
