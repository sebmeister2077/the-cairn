"""Contribute endpoints — players upload map .db files for admin review.

POST /api/contribute/upload-url    — get a presigned R2 upload URL
POST /api/contribute/complete      — validate uploaded object and register it
POST /api/contribute               — legacy direct upload path
GET  /api/contribute/info          — map ID, combined stats, pending & approved list
GET  /api/contribute/preview/:id   — render/cached preview PNG (combined + new tiles highlighted)
POST /api/contribute/:id/approve   — admin-only: merge pending contribution
POST /api/contribute/:id/reject    — admin-only: discard pending contribution

Storage:
  - .db files are stored in Cloudflare R2
  - Metadata/logs are stored in Supabase PostgreSQL
"""

import os
import sqlite3
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from ..auth import verify_api_key, verify_contribute_permission
from ..config import settings
from ..rate_limiter import check_rate_limit
from ..core import r2_storage, database as db
from ..core.mapdb import (
    POSITION_BITS,
    POSITION_MASK,
    TILE_SIZE,
    DEFAULT_MAP_MIDDLE,
    RESOLUTION_LEVELS,
)
from ..tasks.generate_map_levels import start_job as start_map_generation_job

router = APIRouter()

MAPPIECE_TABLE = "mappiece"
BLOCKIDMAPPING_TABLE = "blockidmapping"
UPLOAD_URL_TTL_SECONDS = 15 * 60

# Non-admin contributors are limited to one pending upload at a time, plus a
# cooldown after each approval. Admins are exempt.
CONTRIBUTION_COOLDOWN_DAYS = 7


class ContributeUploadInitRequest(BaseModel):
    contributor: str = ""
    file_name: str = "map.db"
    size_bytes: int = 0


class ContributeUploadCompleteRequest(BaseModel):
    contribution_id: str
    contributor: str = ""


# ---------------------------------------------------------------------------
# Temp-file helpers — download from R2 to a local temp for SQLite operations
# ---------------------------------------------------------------------------

def _download_to_temp(r2_key: str) -> str:
    """Download an R2 object to a temp file and return its path.
    Caller is responsible for deleting the temp file."""
    fd, path = tempfile.mkstemp(suffix=".db")
    try:
        os.close(fd)
        r2_storage.download_to_path(r2_key, path)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def _upload_from_path(local_path: str, r2_key: str):
    """Upload a local file to R2."""
    r2_storage.upload_file(local_path, r2_key)


# ---------------------------------------------------------------------------
# Combined DB helpers
# ---------------------------------------------------------------------------

def _ensure_combined_db_temp() -> str:
    """Download globalservermap.db from R2 to a temp file. If it doesn't
    exist yet, create an empty one. Returns temp path (caller must clean up)."""
    try:
        return _download_to_temp(r2_storage.COMBINED_DB_KEY)
    except FileNotFoundError:
        pass
    # Create empty DB
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {MAPPIECE_TABLE} "
            f"(position INTEGER PRIMARY KEY, data BLOB)"
        )
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {BLOCKIDMAPPING_TABLE} "
            f"(id INTEGER PRIMARY KEY, data BLOB)"
        )
        conn.commit()
    finally:
        conn.close()
    return path


def _recount_combined() -> int:
    """Download combined DB, count tiles, update Supabase cache."""
    try:
        tmp = _download_to_temp(r2_storage.COMBINED_DB_KEY)
    except FileNotFoundError:
        db.set_cached_tile_count(0)
        return 0
    try:
        conn = sqlite3.connect(tmp)
        try:
            count = conn.execute(f"SELECT COUNT(*) FROM {MAPPIECE_TABLE}").fetchone()[0]
        finally:
            conn.close()
        db.set_cached_tile_count(count)
        return count
    finally:
        os.unlink(tmp)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate_upload(path: str) -> int:
    """Check it's a real VS map .db; return tile count."""
    conn = sqlite3.connect(path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (MAPPIECE_TABLE,),
        )
        if not cur.fetchone():
            raise ValueError("Not a valid Vintage Story map database (no mappiece table)")
        count = cur.execute(f"SELECT COUNT(*) FROM {MAPPIECE_TABLE}").fetchone()[0]
        if count == 0:
            raise ValueError("Map database is empty — no tiles to contribute")
        return count
    finally:
        conn.close()


def _normalise_contributor(contributor: str) -> str:
    trimmed = (contributor or "").strip()
    return trimmed[:50]


def _finalize_uploaded_contribution(contribution_id: str, contributor: str, api_key: str = "") -> dict:
    pending_key = r2_storage.pending_db_key(contribution_id)

    existing = db.get_contribution(contribution_id)
    if existing:
        return {
            "message": "Upload already completed — pending admin approval",
            "contribution_id": contribution_id,
            "contributor": existing.get("contributor") or "Anonymous",
            "tile_count": existing.get("tile_count", 0),
        }

    try:
        total_size = r2_storage.get_object_size(pending_key)
    except FileNotFoundError:
        raise ValueError("Uploaded file not found in storage")

    if total_size == 0:
        r2_storage.delete_object(pending_key)
        raise ValueError("Empty upload")
    if total_size > settings.MAX_UPLOAD_SIZE:
        r2_storage.delete_object(pending_key)
        raise ValueError("File too large")

    tmp_path = _download_to_temp(pending_key)
    try:
        tile_count = _validate_upload(tmp_path)
    except ValueError:
        r2_storage.delete_object(pending_key)
        raise
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    contributor_name = _normalise_contributor(contributor)
    db.create_contribution(contribution_id, contributor_name, tile_count, api_key)

    return {
        "message": "Upload received — pending admin approval",
        "contribution_id": contribution_id,
        "contributor": contributor_name or "Anonymous",
        "tile_count": tile_count,
    }


# ---------------------------------------------------------------------------
# Merge logic
# ---------------------------------------------------------------------------

def _merge_into_combined(upload_path: str, combined_path: str) -> dict:
    combined_conn = sqlite3.connect(combined_path)
    upload_conn = sqlite3.connect(upload_path)
    try:
        cur = upload_conn.execute(f"SELECT position, data FROM {MAPPIECE_TABLE}")
        added = 0
        skipped = 0
        batch_size = 2000

        while True:
            rows = cur.fetchmany(batch_size)
            if not rows:
                break
            for pos, data in rows:
                existing = combined_conn.execute(
                    f"SELECT 1 FROM {MAPPIECE_TABLE} WHERE position = ?", (pos,)
                ).fetchone()
                if existing:
                    skipped += 1
                else:
                    combined_conn.execute(
                        f"INSERT INTO {MAPPIECE_TABLE} (position, data) VALUES (?, ?)",
                        (pos, data),
                    )
                    added += 1
            combined_conn.commit()

        # blockidmapping
        try:
            for id_val, data in upload_conn.execute(
                f"SELECT id, data FROM {BLOCKIDMAPPING_TABLE}"
            ):
                combined_conn.execute(
                    f"INSERT OR IGNORE INTO {BLOCKIDMAPPING_TABLE} (id, data) VALUES (?, ?)",
                    (id_val, data),
                )
            combined_conn.commit()
        except sqlite3.OperationalError:
            pass

        after_count = combined_conn.execute(
            f"SELECT COUNT(*) FROM {MAPPIECE_TABLE}"
        ).fetchone()[0]

        return {
            "tiles_uploaded": added + skipped,
            "tiles_new": added,
            "tiles_existing": skipped,
            "combined_total": after_count,
        }
    finally:
        upload_conn.close()
        combined_conn.close()


# ---------------------------------------------------------------------------
# Admin key check
# ---------------------------------------------------------------------------

def _verify_admin_key(api_key: str):
    if not settings.ADMIN_API_KEY:
        raise ValueError("No admin API key configured on server")
    if api_key != settings.ADMIN_API_KEY:
        raise ValueError("Forbidden — admin API key required")


def _is_admin_key(api_key: str) -> bool:
    return bool(settings.ADMIN_API_KEY) and api_key == settings.ADMIN_API_KEY


def _get_contribution_status(api_key: str) -> dict:
    """Compute whether a non-admin user is currently allowed to contribute.

    Returns a dict shaped for /contribute/info:
      can_contribute, cooldown_reason ('pending'|'cooldown'|None),
      pending_contribution_id, next_allowed_at (ISO), cooldown_days.
    Admins always get can_contribute=True with null reason.
    """
    base = {
        "can_contribute": True,
        "cooldown_reason": None,
        "pending_contribution_id": None,
        "next_allowed_at": None,
        "cooldown_days": CONTRIBUTION_COOLDOWN_DAYS,
    }
    if _is_admin_key(api_key) or not api_key:
        return base

    pending = db.get_user_pending_contribution(api_key)
    if pending:
        return {
            **base,
            "can_contribute": False,
            "cooldown_reason": "pending",
            "pending_contribution_id": pending.get("id"),
        }

    last_approval = db.get_user_last_approval(api_key)
    if last_approval and last_approval.get("approved_at"):
        approved_at = last_approval["approved_at"]
        next_allowed = approved_at + timedelta(days=CONTRIBUTION_COOLDOWN_DAYS)
        if next_allowed > datetime.now(timezone.utc):
            return {
                **base,
                "can_contribute": False,
                "cooldown_reason": "cooldown",
                "next_allowed_at": next_allowed.isoformat(),
            }

    return base


def _check_contribution_limits(api_key: str):
    """Raise HTTPException(429) if a non-admin user is over the contribution limit."""
    status = _get_contribution_status(api_key)
    if status["can_contribute"]:
        return
    if status["cooldown_reason"] == "pending":
        raise HTTPException(
            status_code=429,
            detail=(
                "You already have a pending contribution awaiting review. "
                "Withdraw it before submitting another."
            ),
        )
    if status["cooldown_reason"] == "cooldown":
        next_allowed = status["next_allowed_at"]
        raise HTTPException(
            status_code=429,
            detail=(
                f"You can contribute again on {next_allowed}. "
                f"Limit: one approved contribution per {CONTRIBUTION_COOLDOWN_DAYS} days."
            ),
        )


def _compute_pending_world_bounds(pending_db_path: str):
    """Return (min_x, max_x, min_z, max_z) in world-block coords for the
    pending contribution, or None if the DB is empty."""
    conn = sqlite3.connect(pending_db_path)
    try:
        row = conn.execute(
            f"""
            SELECT
                MIN(position & ?),
                MAX(position & ?),
                MIN(position >> ?),
                MAX(position >> ?)
            FROM {MAPPIECE_TABLE}
            """,
            (POSITION_MASK, POSITION_MASK, POSITION_BITS, POSITION_BITS),
        ).fetchone()
    finally:
        conn.close()
    if not row or row[0] is None:
        return None
    min_tx, max_tx, min_tz, max_tz = row
    # Tile coords → world block coords (each tile = TILE_SIZE blocks; positions
    # are tile indices around DEFAULT_MAP_MIDDLE which is in raw tile-grid units).
    return (
        int(min_tx) * TILE_SIZE,
        (int(max_tx) + 1) * TILE_SIZE - 1,
        int(min_tz) * TILE_SIZE,
        (int(max_tz) + 1) * TILE_SIZE - 1,
    )


# ---------------------------------------------------------------------------
# Preview rendering
# ---------------------------------------------------------------------------

def _render_preview(combined_path: str, upload_path: str, max_dimension: int = 2048) -> bytes:
    """Render combined + upload map with new tiles highlighted in green."""
    from ..core.mapdb import (
        TILE_SIZE, STANDARD_BLOB_SIZE,
        decode_position, decode_tile_numpy, decode_tile_fallback, _sample_one_pixel,
    )
    from PIL import Image
    import numpy as np
    import io

    # Collect positions from combined
    combined_positions: Set[int] = set()
    combined_conn = sqlite3.connect(combined_path)
    try:
        combined_positions = {
            r[0] for r in combined_conn.execute(f"SELECT position FROM {MAPPIECE_TABLE}")
        }
    except sqlite3.OperationalError:
        pass
    finally:
        combined_conn.close()

    # Collect positions from upload
    up_conn = sqlite3.connect(upload_path)
    upload_positions = {
        r[0] for r in up_conn.execute(f"SELECT position FROM {MAPPIECE_TABLE}")
    }
    up_conn.close()

    new_positions = upload_positions - combined_positions
    all_positions = combined_positions | upload_positions

    if not all_positions:
        raise ValueError("No tiles to render")

    all_coords = [decode_position(p) for p in all_positions]
    min_x = min(c[0] for c in all_coords)
    max_x = max(c[0] for c in all_coords)
    min_z = min(c[1] for c in all_coords)
    max_z = max(c[1] for c in all_coords)

    w_chunks = max_x - min_x + 1
    h_chunks = max_z - min_z + 1
    full_w = w_chunks * TILE_SIZE
    full_h = h_chunks * TILE_SIZE

    scale = max(1, max(full_w // max_dimension, full_h // max_dimension))
    img_w = max(1, full_w // scale)
    img_h = max(1, full_h // scale)

    img_arr = np.zeros((img_h, img_w, 4), dtype=np.uint8)

    def _paint_tiles(db_path: str, highlight_positions: Optional[Set[int]] = None):
        conn = sqlite3.connect(db_path)
        try:
            cur = conn.execute(f"SELECT position, data FROM {MAPPIECE_TABLE}")
            batch_size = 2000
            while True:
                rows = cur.fetchmany(batch_size)
                if not rows:
                    break
                for pos_val, blob in rows:
                    cx, cz = decode_position(pos_val)
                    is_highlight = highlight_positions and pos_val in highlight_positions

                    if scale <= TILE_SIZE:
                        if len(blob) == STANDARD_BLOB_SIZE:
                            tile = decode_tile_numpy(blob)
                        else:
                            tile = decode_tile_fallback(blob)

                        if is_highlight:
                            tinted = tile.copy().astype(np.float32)
                            tinted[:, :, 0] = tinted[:, :, 0] * 0.5
                            tinted[:, :, 1] = np.minimum(tinted[:, :, 1] * 0.5 + 128, 255)
                            tinted[:, :, 2] = tinted[:, :, 2] * 0.5
                            tile = tinted.astype(np.uint8)

                        if scale == 1:
                            bx = (cx - min_x) * TILE_SIZE
                            bz = (cz - min_z) * TILE_SIZE
                            img_arr[bz:bz + TILE_SIZE, bx:bx + TILE_SIZE] = tile
                        else:
                            sampled = tile[::scale, ::scale]
                            sh, sw = sampled.shape[:2]
                            bx = (cx - min_x) * TILE_SIZE // scale
                            bz = (cz - min_z) * TILE_SIZE // scale
                            ew = min(sw, img_w - bx)
                            eh = min(sh, img_h - bz)
                            if ew > 0 and eh > 0:
                                img_arr[bz:bz + eh, bx:bx + ew] = sampled[:eh, :ew]
                    else:
                        bx = (cx - min_x) * TILE_SIZE // scale
                        bz = (cz - min_z) * TILE_SIZE // scale
                        if 0 <= bx < img_w and 0 <= bz < img_h:
                            if len(blob) >= STANDARD_BLOB_SIZE:
                                r, g, b, a = _sample_one_pixel(blob)
                            else:
                                r, g, b, a = 0, 0, 0, 255
                            if is_highlight:
                                r = int(r * 0.5)
                                g = min(int(g * 0.5) + 128, 255)
                                b = int(b * 0.5)
                            img_arr[bz, bx] = [r, g, b, a]
        finally:
            conn.close()

    if combined_positions:
        _paint_tiles(combined_path)
    _paint_tiles(upload_path, highlight_positions=new_positions)

    img = Image.fromarray(img_arr, "RGBA")
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


# ===========================================================================
# Routes
# ===========================================================================

@router.get("/contribute/info")
async def contribute_info(request: Request, api_key: str = Depends(verify_api_key)):
    """Map ID, combined tile count, pending contributions and approved log."""
    check_rate_limit(api_key)

    total_tiles = db.get_cached_tile_count()
    pending = db.list_pending_contributions(requesting_key=api_key)
    withdrawn = db.list_withdrawn_contributions(requesting_key=api_key)
    approved = db.get_approved_log(limit=20)

    # Serialise datetimes for JSON
    for row in pending + withdrawn:
        for k in ("created_at", "approved_at", "withdrawn_at"):
            if row.get(k) and hasattr(row[k], "isoformat"):
                row[k] = row[k].isoformat()
    for row in pending:
        row["preview_image_url"] = str(
            request.url_for("contribute_preview", contribution_id=row["id"])
        )
        preview_key = r2_storage.pending_preview_key(row["id"])
        row["preview_signed_url"] = r2_storage.generate_presigned_download_url(
            preview_key,
            expires_seconds=3 * 24 * 60 * 60,
        )
    for row in approved:
        if row.get("approved_at") and hasattr(row["approved_at"], "isoformat"):
            row["approved_at"] = row["approved_at"].isoformat()

    contribution_status = _get_contribution_status(api_key)

    return {
        "map_id": settings.CONTRIBUTE_MAP_ID,
        "total_tiles": total_tiles,
        "pending": pending,
        "withdrawn": withdrawn,
        "approved": approved,
        "is_admin": _is_admin_key(api_key),
        **contribution_status,
    }


@router.post("/contribute/upload-url")
async def contribute_upload_url(
    payload: ContributeUploadInitRequest,
    api_key: str = Depends(verify_contribute_permission),
):
    """Create a presigned upload URL so the browser can upload directly to R2."""
    check_rate_limit(api_key)
    _check_contribution_limits(api_key)

    if payload.size_bytes <= 0:
        return JSONResponse(status_code=400, content={"detail": "Empty upload"})
    if payload.size_bytes > settings.MAX_UPLOAD_SIZE:
        return JSONResponse(status_code=413, content={"detail": "File too large"})
    if payload.file_name and not payload.file_name.lower().endswith(".db"):
        return JSONResponse(status_code=400, content={"detail": "Only .db map files are supported"})

    contribution_id = uuid.uuid4().hex[:12]
    pending_key = r2_storage.pending_db_key(contribution_id)

    return {
        "contribution_id": contribution_id,
        "upload_method": "PUT",
        "upload_url": r2_storage.generate_presigned_upload_url(
            pending_key,
            expires_seconds=UPLOAD_URL_TTL_SECONDS,
            content_type="application/octet-stream",
        ),
        "upload_headers": {
            "Content-Type": "application/octet-stream",
        },
        "expires_in_seconds": UPLOAD_URL_TTL_SECONDS,
        # Return the api_key so /complete can be associated with the same key
        "_api_key": api_key,
    }


@router.post("/contribute/complete")
async def contribute_complete(
    payload: ContributeUploadCompleteRequest,
    api_key: str = Depends(verify_contribute_permission),
):
    """Validate an uploaded R2 object and register it as a pending contribution."""
    check_rate_limit(api_key)
    _check_contribution_limits(api_key)

    contribution_id = payload.contribution_id.strip()
    if not contribution_id:
        return JSONResponse(status_code=400, content={"detail": "Missing contribution ID"})

    try:
        return _finalize_uploaded_contribution(contribution_id, payload.contributor, api_key)
    except ValueError as e:
        detail = str(e)
        status = 413 if detail == "File too large" else 400
        if detail == "Uploaded file not found in storage":
            status = 404
        return JSONResponse(status_code=status, content={"detail": detail})


@router.post("/contribute")
async def contribute_upload(
    request: Request,
    contributor: str = Query("", description="Optional contributor name"),
    api_key: str = Depends(verify_contribute_permission),
):
    """Upload a .db map file. Validated and stored in R2 as pending."""
    check_rate_limit(api_key)
    _check_contribution_limits(api_key)

    fd, tmp_path = tempfile.mkstemp(suffix=".db")
    try:
        total_size = 0
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                total_size += len(chunk)
                if total_size > settings.MAX_UPLOAD_SIZE:
                    f.close()
                    os.unlink(tmp_path)
                    return JSONResponse(status_code=413, content={"detail": "File too large"})
                f.write(chunk)

        if total_size == 0:
            os.unlink(tmp_path)
            return JSONResponse(status_code=400, content={"detail": "Empty upload"})

        cid = uuid.uuid4().hex[:12]

        # Upload to R2
        _upload_from_path(tmp_path, r2_storage.pending_db_key(cid))
        try:
            return _finalize_uploaded_contribution(cid, contributor, api_key)
        except ValueError as e:
            detail = str(e)
            status = 413 if detail == "File too large" else 400
            return JSONResponse(status_code=status, content={"detail": detail})
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@router.get("/contribute/preview/{contribution_id}")
async def contribute_preview(
    contribution_id: str,
    api_key: str = Depends(verify_api_key),
):
    """Return preview PNG for a pending contribution.

    First request renders and stores preview in R2; later requests serve cached PNG.
    """
    check_rate_limit(api_key)

    meta = db.get_contribution(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    pending_key = r2_storage.pending_db_key(contribution_id)
    preview_key = r2_storage.pending_preview_key(contribution_id)

    # Serve cached preview when available.
    if r2_storage.object_exists(preview_key):
        png_bytes = r2_storage.download_bytes(preview_key)
        return Response(
            content=png_bytes,
            media_type="image/png",
            headers={
                "Content-Disposition": f"inline; filename={contribution_id}.png",
                "X-Preview-Cache": "hit",
            },
        )

    if not r2_storage.object_exists(pending_key):
        return JSONResponse(status_code=404, content={"detail": "Contribution database missing"})

    # Download both DBs to temp files for SQLite operations
    combined_tmp = _ensure_combined_db_temp()
    pending_tmp = _download_to_temp(pending_key)
    try:
        png_bytes = _render_preview(combined_tmp, pending_tmp)
        r2_storage.upload_bytes(preview_key, png_bytes, content_type="image/png")
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})
    finally:
        os.unlink(combined_tmp)
        os.unlink(pending_tmp)

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "Content-Disposition": f"inline; filename={contribution_id}.png",
            "X-Preview-Cache": "miss",
        },
    )


@router.post("/contribute/{contribution_id}/approve")
async def contribute_approve(
    contribution_id: str,
    api_key: str = Depends(verify_api_key),
):
    """Admin-only: merge a pending contribution into the combined map."""
    try:
        _verify_admin_key(api_key)
    except ValueError as e:
        return JSONResponse(status_code=403, content={"detail": str(e)})

    meta = db.get_contribution(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    pending_key = r2_storage.pending_db_key(contribution_id)
    if not r2_storage.object_exists(pending_key):
        return JSONResponse(status_code=404, content={"detail": "Contribution database missing"})

    # Download both to temp, merge, re-upload combined
    combined_tmp = _ensure_combined_db_temp()
    pending_tmp = _download_to_temp(pending_key)
    affected_bounds = None
    try:
        # Capture affected world-block bounds BEFORE merging so we know which
        # cache chunks to invalidate. Falls back to None on any error → full regen.
        try:
            affected_bounds = _compute_pending_world_bounds(pending_tmp)
        except Exception:
            affected_bounds = None

        stats = _merge_into_combined(pending_tmp, combined_tmp)

        # Refresh cached TOPS stats from the merged local DB file.
        from ..core.mapdb import get_map_stats_from_path
        db.set_tops_map_stats(get_map_stats_from_path(combined_tmp))

        # Upload updated combined DB back to R2
        _upload_from_path(combined_tmp, r2_storage.COMBINED_DB_KEY)
    finally:
        os.unlink(combined_tmp)
        os.unlink(pending_tmp)

    # Update Supabase
    db.mark_approved(
        contribution_id,
        tiles_new=stats["tiles_new"],
        tiles_existing=stats["tiles_existing"],
        combined_total=stats["combined_total"],
    )
    db.set_cached_tile_count(stats["combined_total"])

    # Smart cache invalidation — kick off a background regen of all configured
    # resolution levels, but only for chunks that intersect the contributed
    # bounding box. Existing chunks outside that area are reused.
    try:
        start_map_generation_job(
            sorted(RESOLUTION_LEVELS.keys()),
            affected_bounds=affected_bounds,
        )
    except Exception:
        pass

    # Move approved .db into archive storage
    archived_key = r2_storage.archived_db_key(contribution_id)
    archive_moved = False
    try:
        r2_storage.move_object(pending_key, archived_key)
        archive_moved = True
    except Exception:
        # Do not fail approval if archive move fails; keep pending object as fallback.
        archive_moved = False

    r2_storage.delete_object(r2_storage.pending_preview_key(contribution_id))

    result = {"message": "Contribution approved and merged", **stats}
    if archive_moved:
        result["archived_db_key"] = archived_key
    else:
        result["archive_warning"] = "Contribution approved but DB archive move failed"
    return result


@router.post("/contribute/{contribution_id}/withdraw")
async def contribute_withdraw(
    contribution_id: str,
    api_key: str = Depends(verify_api_key),
):
    """Owner: soft-delete a pending contribution.

    Removes the .db file from R2, anonymises the contributor name, and marks
    the contribution as 'withdrawn'. The record remains visible on the frontend.
    """
    meta = db.get_contribution(contribution_id)
    if not meta:
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})
    if meta.get("status") != "pending":
        return JSONResponse(
            status_code=409,
            content={"detail": "Only pending contributions can be withdrawn"},
        )
    if meta.get("submitted_by_key") != api_key:
        return JSONResponse(status_code=403, content={"detail": "You did not submit this contribution"})

    # Remove the .db and any cached preview from R2
    r2_storage.delete_object(r2_storage.pending_db_key(contribution_id))
    r2_storage.delete_object(r2_storage.pending_preview_key(contribution_id))

    # Soft-delete in DB (anonymise + status='withdrawn')
    db.withdraw_contribution(contribution_id, api_key)

    return {"message": "Contribution withdrawn"}


@router.post("/contribute/{contribution_id}/reject")
async def contribute_reject(
    contribution_id: str,
    api_key: str = Depends(verify_api_key),
):
    """Admin-only: reject and delete a pending contribution."""
    try:
        _verify_admin_key(api_key)
    except ValueError as e:
        return JSONResponse(status_code=403, content={"detail": str(e)})

    meta = db.get_contribution(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    # Delete .db from R2
    r2_storage.delete_object(r2_storage.pending_db_key(contribution_id))
    r2_storage.delete_object(r2_storage.pending_preview_key(contribution_id))

    # Delete metadata from Supabase
    db.delete_contribution(contribution_id)

    return {"message": "Contribution rejected and deleted"}
