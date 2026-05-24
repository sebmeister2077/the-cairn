"""Phase 2 / Phase B+C — region-overwrite specific HTTP surface.

Split out of ``contribute_r2`` to keep that file focused on the
upload/merge/approve pipeline. The endpoints here reuse the upload
helpers (private-prefixed) from ``contribute_r2`` rather than copying
them — they are tightly coupled to the same R2 layout and SQLite tile
encoding.

Endpoints:

* ``POST /contribute/region-preview`` — tile-count probe for the picker.
* ``GET  /contribute/preview-region/{id}`` — cached before/after PNGs.
* ``PATCH /contribute/{id}/region``        — admin-only bounds edit.
"""

import asyncio
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from ..auth import verify_api_key, verify_contribute_permission
from ..core import accounts_db, database as db, r2_storage
from ..core.feature_flags import is_feature_enabled, is_heavy_compute_allowed
from ..core.mapdb import TILE_SIZE
from ..rate_limiter import check_rate_limit
from .admin_settings import get_region_overwrite_settings

# Internal helpers reused as-is from the main contribute module. Private
# names by convention only — they are module-level functions that have no
# instance state and are safe to call from here. Keeping the import list
# explicit so future refactors are easy to track.
from .contribute_r2 import (
    _PreviewLock,
    _check_region_eligibility,
    _count_pending_tiles,
    _download_to_temp,
    _is_admin_key,
    _key_owns_row,
    _normalise_region,
    _region_tile_count,
    _render_region_before_after,
    get_combined_db_cached,
)


logger = logging.getLogger("uvicorn.error")

router = APIRouter()


class ContributeRegionPreviewRequest(BaseModel):
    """Body for ``POST /contribute/region-preview`` — returns the in-region
    tile counts so the picker can show "X of Y tiles in your file are inside
    the selected region" before the user commits."""

    contribution_id: str
    update_region_min_x: int
    update_region_max_x: int
    update_region_min_z: int
    update_region_max_z: int


class AdminRegionEditRequest(BaseModel):
    """Body for ``PATCH /contribute/{id}/region`` — admin-only edit of a
    pending contribution's update_region bounds. Shrinking is unlimited,
    expansion is capped per-edge by the
    ``region_overwrite.admin_expand_chunks_max`` setting.
    """

    update_region_min_x: int
    update_region_max_x: int
    update_region_min_z: int
    update_region_max_z: int


@router.post("/contribute/region-preview")
async def contribute_region_preview(
    payload: ContributeRegionPreviewRequest,
    api_key: str = Depends(verify_contribute_permission),
):
    """Return ``{tiles_in_region, tiles_total, region_tile_area}`` for a
    candidate region against an already-uploaded pending file.

    Used by the picker UI to show "1 234 of 56 789 tiles in your file fall
    inside this region" before the user commits. Hidden behind the
    ``region_overwrite`` feature flag.
    """
    check_rate_limit(api_key)

    try:
        region = _normalise_region(
            payload.update_region_min_x,
            payload.update_region_max_x,
            payload.update_region_min_z,
            payload.update_region_max_z,
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})
    if region is None:
        return JSONResponse(status_code=400, content={"detail": "Region required"})

    try:
        _check_region_eligibility(api_key, region)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"detail": e.detail})

    cid = payload.contribution_id.strip()
    if not cid:
        return JSONResponse(status_code=400, content={"detail": "Missing contribution ID"})

    meta = db.get_contribution(cid)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})
    # Owner-only: don't let another contributor probe somebody else's pending
    # upload. Admins are exempt.
    if not _is_admin_key(api_key) and not _key_owns_row(api_key, meta):
        return JSONResponse(status_code=403, content={"detail": "Not your contribution"})

    pending_key = r2_storage.pending_db_key(cid)
    if not r2_storage.object_exists(pending_key):
        return JSONResponse(status_code=404, content={"detail": "Pending DB missing"})

    tmp = _download_to_temp(pending_key)
    try:
        in_region, total = _count_pending_tiles(tmp, region)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    return {
        "tiles_in_region": in_region,
        "tiles_total": total,
        "region_tile_area": _region_tile_count(region),
        "region_tile_cap": (
            None
            if _is_admin_key(api_key)
            else int(get_region_overwrite_settings()["max_chunks_area_non_admin"])
        ),
    }


@router.patch("/contribute/{contribution_id}/region")
async def contribute_admin_edit_region(
    contribution_id: str,
    payload: AdminRegionEditRequest,
    api_key: str = Depends(verify_api_key),
):
    """Admin-only — adjust a pending contribution's update_region bounds.

    Shrinking is unlimited (admin can tighten any edge to ≥ 1 in-region
    upload tile). Expansion per edge is capped by
    ``region_overwrite.admin_expand_chunks_max`` (chunks) so admins can't
    accidentally widen a tiny picker into a multi-region overwrite. The
    new region must:

      * Satisfy the same ≥ 1-chunk side minimum as the contributor flow.
      * Still contain ≥ 1 tile from the pending upload (otherwise approval
        would be a no-op).

    On success the cached ``pending/<id>.before.png`` / ``.after.png``
    family (including padded variants) is deleted so the next preview
    request re-renders against the new bounds. The action is recorded in
    ``admin_audit_log`` with both the old and new bounds.

    Hidden behind the ``region_overwrite`` feature flag — non-admins
    receive 404 to avoid leaking the endpoint's existence.
    """
    check_rate_limit(api_key)

    if not is_feature_enabled("region_overwrite"):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    if not _is_admin_key(api_key):
        # Match the unauthenticated /admin/* shape rather than 403 so
        # the route is invisible from the outside.
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

    meta = db.get_contribution(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    old_region = db.get_update_region(contribution_id)
    if old_region is None:
        return JSONResponse(
            status_code=400,
            content={"detail": "Contribution has no region attached"},
        )

    try:
        new_region = _normalise_region(
            payload.update_region_min_x,
            payload.update_region_max_x,
            payload.update_region_min_z,
            payload.update_region_max_z,
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})
    if new_region is None:
        return JSONResponse(status_code=400, content={"detail": "Region required"})

    # Reuse the shared validator for the ≥ 1-chunk min + flag check.
    # Admins skip the non-admin chunks² cap inside the helper, which is
    # exactly the behaviour we want here.
    try:
        _check_region_eligibility(api_key, new_region)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"detail": e.detail})

    # Per-edge expansion cap. Shrinking is always allowed.
    settings_now = get_region_overwrite_settings()
    expand_max_chunks = int(settings_now["admin_expand_chunks_max"])
    expand_max_blocks = expand_max_chunks * TILE_SIZE
    o_min_x, o_max_x, o_min_z, o_max_z = old_region
    n_min_x, n_max_x, n_min_z, n_max_z = new_region
    # ``edge_expansion`` is positive for expansion, negative for shrinkage.
    # Order matters: ``min`` going down (negative) and ``max`` going up
    # (positive) are both expansions.
    expansions = {
        "min_x": o_min_x - n_min_x,
        "max_x": n_max_x - o_max_x,
        "min_z": o_min_z - n_min_z,
        "max_z": n_max_z - o_max_z,
    }
    over = {
        edge: amt for edge, amt in expansions.items()
        if amt > expand_max_blocks
    }
    if over:
        return JSONResponse(
            status_code=400,
            content={
                "detail": (
                    f"Expansion exceeds the admin cap of "
                    f"{expand_max_chunks} chunks per edge."
                ),
                "over_edges": {
                    edge: {
                        "expanded_blocks": int(amt),
                        "expanded_chunks": amt // TILE_SIZE,
                    }
                    for edge, amt in over.items()
                },
            },
        )

    # Make sure the new region still overlaps the upload — otherwise the
    # merge becomes a no-op and the admin has effectively rejected silently.
    pending_key = r2_storage.pending_db_key(contribution_id)
    if not r2_storage.object_exists(pending_key):
        return JSONResponse(status_code=404, content={"detail": "Pending DB missing"})
    tmp = _download_to_temp(pending_key)
    try:
        in_region, _total = _count_pending_tiles(tmp, new_region)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if in_region < 1:
        return JSONResponse(
            status_code=400,
            content={
                "detail": (
                    "New region contains no tiles from the upload — "
                    "approval would be a no-op."
                ),
            },
        )

    db.set_update_region(contribution_id, new_region)

    # Invalidate every cached preview (all padding variants). Best-effort —
    # any stragglers are overwritten on the next render request.
    try:
        r2_storage.invalidate_region_previews(contribution_id)
    except Exception:
        logger.exception(
            "region edit: preview invalidation failed for %s",
            contribution_id,
        )

    try:
        accounts_db.audit_log(
            api_key,
            "contribution.region_edit",
            target=contribution_id,
            metadata={
                "old_region": list(old_region),
                "new_region": list(new_region),
                "expansions_blocks": expansions,
                "in_region_upload_tiles": int(in_region),
            },
        )
    except Exception:
        logger.exception(
            "region edit: audit log failed for %s", contribution_id
        )

    return {
        "contribution_id": contribution_id,
        "old_region": list(old_region),
        "new_region": list(new_region),
        "in_region_upload_tiles": int(in_region),
        "region_chunk_area": _region_tile_count(new_region),
    }


@router.get("/contribute/preview-region/{contribution_id}")
async def contribute_preview_region(
    contribution_id: str,
    side: str = Query("before", description="'before' or 'after'"),
    padding_chunks: int = Query(
        0,
        ge=0,
        le=64,
        description=(
            "Admin-only context padding (chunks per edge). Non-admin "
            "callers' value is silently coerced to 0."
        ),
    ),
    api_key: str = Depends(verify_api_key),
):
    """Phase 2 — render the side-by-side region overwrite preview.

    Two PNGs are produced and cached in R2 next to the contribution:
    ``pending/<id>.before.png`` and ``pending/<id>.after.png``. Both are
    cropped to the contribution's region. Newly-added tiles tint green and
    overwritten tiles tint orange on the "after" image.

    ``padding_chunks`` (Phase B, admin-only): expand the crop by N
    chunks on every edge so the admin can see surrounding context
    when reviewing. The tinted overlay still only covers the original
    region. Each padding value is cached as a separate R2 key.

    404 when the contribution has no Phase-2 region attached, or when the
    feature flag is off (so non-admins can't probe the route).
    """
    check_rate_limit(api_key)

    if side not in ("before", "after"):
        return JSONResponse(status_code=400, content={"detail": "side must be 'before' or 'after'"})

    if not is_feature_enabled("region_overwrite"):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

    meta = db.get_contribution(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    region = db.get_update_region(contribution_id)
    if region is None:
        return JSONResponse(
            status_code=404,
            content={"detail": "Contribution has no region attached"},
        )

    # Privacy: pending region preview is admin-only (region bounds may be
    # exploration-sensitive). Owner-of-the-contribution also gets to see it
    # so they can verify their own selection.
    is_admin = _is_admin_key(api_key)
    if not is_admin and not _key_owns_row(api_key, meta):
        return JSONResponse(status_code=403, content={"detail": "Forbidden"})

    # Padding is an admin-only context aid — collapse non-admin requests
    # to 0 rather than erroring so the contributor's own preview always
    # works unchanged.
    effective_padding = int(padding_chunks) if is_admin else 0

    before_key = r2_storage.region_before_preview_key_padded(
        contribution_id, effective_padding
    )
    after_key = r2_storage.region_after_preview_key_padded(
        contribution_id, effective_padding
    )
    target_key = before_key if side == "before" else after_key

    # Push blocking R2 / PIL work to a worker thread.
    # 0-byte cached objects are treated as a miss and re-rendered (a real
    # PNG is always at least ~70 bytes; an empty body would have been
    # poisoned by an earlier bug). This also self-heals stale caches.
    if await asyncio.to_thread(r2_storage.object_exists, target_key):
        png_bytes = await asyncio.to_thread(r2_storage.download_bytes, target_key)
        if png_bytes:
            return Response(
                content=png_bytes,
                media_type="image/png",
                headers={
                    "Content-Disposition": f"inline; filename={contribution_id}.{side}.png",
                    "X-Preview-Cache": "hit",
                },
            )
        # Empty payload — drop the poisoned object so we render fresh below.
        try:
            await asyncio.to_thread(r2_storage.delete_object, target_key)
        except Exception:
            logger.warning(
                "preview-region: failed to evict empty cached object %s",
                target_key,
            )

    # Heavy-compute kill switch.
    if not _is_admin_key(api_key) and not is_heavy_compute_allowed():
        return JSONResponse(
            status_code=503,
            content={
                "detail": {
                    "code": "heavy_compute_disabled",
                    "message": (
                        "Region preview generation is paused while the server "
                        "is at reduced capacity. An admin will render "
                        "previews shortly."
                    ),
                }
            },
            headers={"Retry-After": "600"},
        )

    pending_key = r2_storage.pending_db_key(contribution_id)
    if not await asyncio.to_thread(r2_storage.object_exists, pending_key):
        return JSONResponse(status_code=404, content={"detail": "Pending DB missing"})

    # Dedupe concurrent renders. The lock is shared across both sides
    # because a single render produces both the before and after PNGs.
    # Padding is part of the lock key so distinct paddings don't block
    # each other (and don't collide on the cached PNGs either).
    async with _PreviewLock(f"preview-region:{contribution_id}:p{effective_padding}"):
        # Re-check inside the lock — an earlier waiter may have just rendered.
        # Same 0-byte guard as above so a poisoned cache can't trap us here.
        if await asyncio.to_thread(r2_storage.object_exists, target_key):
            png_bytes = await asyncio.to_thread(r2_storage.download_bytes, target_key)
            if png_bytes:
                return Response(
                    content=png_bytes,
                    media_type="image/png",
                    headers={
                        "Content-Disposition": f"inline; filename={contribution_id}.{side}.png",
                        "X-Preview-Cache": "hit",
                    },
                )
            try:
                await asyncio.to_thread(r2_storage.delete_object, target_key)
            except Exception:
                logger.warning(
                    "preview-region: failed to evict empty cached object %s",
                    target_key,
                )

        combined_tmp = await asyncio.to_thread(get_combined_db_cached)
        pending_tmp = await asyncio.to_thread(_download_to_temp, pending_key)
        try:
            before_bytes, after_bytes, _stats = await asyncio.to_thread(
                _render_region_before_after,
                combined_tmp,
                pending_tmp,
                region,
                padding_chunks=effective_padding,
            )
            # Refuse to poison the cache with empty payloads. A valid PNG
            # for even a 1×1 image is ~70 bytes; anything smaller means
            # the renderer returned bogus data and we'd rather re-render
            # next request than serve a broken image forever.
            if not before_bytes or not after_bytes:
                logger.error(
                    "preview-region: renderer returned empty bytes "
                    "(before=%d, after=%d) for %s pad=%d — skipping cache",
                    len(before_bytes or b""),
                    len(after_bytes or b""),
                    contribution_id,
                    effective_padding,
                )
                return JSONResponse(
                    status_code=500,
                    content={"detail": "Region preview render produced empty image"},
                )
            # Cache both halves so the second request (for the other side) is a hit.
            await asyncio.to_thread(
                r2_storage.upload_bytes, before_key, before_bytes, "image/png"
            )
            await asyncio.to_thread(
                r2_storage.upload_bytes, after_key, after_bytes, "image/png"
            )
        except ValueError as e:
            return JSONResponse(status_code=400, content={"detail": str(e)})
        finally:
            try:
                os.unlink(pending_tmp)
            except OSError:
                pass

    payload = before_bytes if side == "before" else after_bytes
    return Response(
        content=payload,
        media_type="image/png",
        headers={
            "Content-Disposition": f"inline; filename={contribution_id}.{side}.png",
            "X-Preview-Cache": "miss",
        },
    )
