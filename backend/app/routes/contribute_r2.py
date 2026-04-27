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
from ..core import r2_storage, accounts_db, database as db
from ..core.mapdb import (
    POSITION_BITS,
    POSITION_MASK,
    TILE_SIZE,
    DEFAULT_MAP_MIDDLE,
    RESOLUTION_LEVELS,
)
from ..tasks.generate_map_levels import start_job as start_map_generation_job
from ..tasks import match_score as match_score_task
from ..core.feature_flags import is_feature_enabled

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

    # Phase 1 — kick off async match-score computation. The feature flag is
    # checked here so that disabling it stops *new* jobs from being enqueued
    # while still letting the worker drain anything already in-flight.
    if is_feature_enabled("match_score"):
        try:
            db.set_match_score_pending(contribution_id)
            match_score_task.start_job(contribution_id)
        except Exception:
            # Score is informational — never fail the upload because of it.
            pass

    return {
        "message": "Upload received — pending admin approval",
        "contribution_id": contribution_id,
        "contributor": contributor_name or "Anonymous",
        "tile_count": tile_count,
    }


# ---------------------------------------------------------------------------
# Merge logic
# ---------------------------------------------------------------------------

def _merge_into_combined(upload_path: str, combined_path: str, *, added_writer=None) -> dict:
    """Merge ``upload_path`` into ``combined_path`` (gap-fill, INSERT-or-skip).

    When ``added_writer`` is supplied it is invoked with each freshly-inserted
    ``position`` integer in insertion order. Used by Phase 4b to stream the
    undo log of the contribution to a temp file as we go.
    """
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
                    if added_writer is not None:
                        try:
                            added_writer(pos)
                        except Exception:
                            # Capture failure must never abort the merge — the
                            # caller is responsible for downgrading
                            # ``revert_supported`` if the writer signals it.
                            pass
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


# ---------------------------------------------------------------------------
# Phase 1 — Match-percentage scoring (informational only)
# ---------------------------------------------------------------------------

# 10 random + 1 center pixel per overlapping tile; "similar" if at least
# this many of the 11 samples match (alpha=0 samples don't count toward
# the denominator → a tile with all-transparent samples is skipped entirely).
_MATCH_PIXELS_PER_TILE = 10
_MATCH_SIMILAR_THRESHOLD = 8
# Per-channel tolerance for "match" — VS map renderer can vary by ±1 from
# anti-aliasing rounding even on identical tiles, so be lenient.
_MATCH_PIXEL_TOLERANCE = 6


def _pixel_close(a: tuple, b: tuple) -> bool:
    """Return True if two RGBA tuples match within tolerance, ignoring
    pixels where either side has alpha=0 (no-data marker)."""
    if a[3] == 0 or b[3] == 0:
        return False
    return (
        abs(a[0] - b[0]) <= _MATCH_PIXEL_TOLERANCE
        and abs(a[1] - b[1]) <= _MATCH_PIXEL_TOLERANCE
        and abs(a[2] - b[2]) <= _MATCH_PIXEL_TOLERANCE
    )


def _compute_match_score(
    combined_path: str,
    pending_path: str,
    region: Optional[tuple] = None,
) -> dict:
    """Compute tile-overlap and pixel-similarity stats between two map DBs.

    Strategy:
      1. Open ``combined_path`` and ATTACH ``pending_path`` as ``pend``.
      2. Pull all overlapping ``(position, combined.data, pend.data)`` rows
         in one streaming join. Pending tiles whose position isn't in
         combined contribute to ``pending_total`` but not to the pixel scan.
      3. For each overlapping tile, sample 10 deterministic-pseudo-random
         pixels + the center pixel using ``_sample_n_pixels`` and count it
         as "similar" iff ≥ ``_MATCH_SIMILAR_THRESHOLD`` of the **non-zero-
         alpha** samples match within tolerance.

    ``region`` (Phase 2): when set to ``(min_x, max_x, min_z, max_z)`` in
    world-block coordinates, both sides are filtered to in-region positions
    before scoring.

    Returns the JSON-ready payload that ends up in
    ``contributions.match_score_json``.
    """
    from ..core.mapdb import _sample_n_pixels, decode_position

    pending_conn = sqlite3.connect(pending_path)
    try:
        pending_total = pending_conn.execute(
            f"SELECT COUNT(*) FROM {MAPPIECE_TABLE}"
        ).fetchone()[0] or 0
    finally:
        pending_conn.close()

    if pending_total == 0:
        return {
            "tile_overlap_pct": 0.0,
            "pixel_similar_pct": 0.0,
            "overlap_count": 0,
            "pending_total": 0,
            "tiles_scanned": 0,
            "tiles_similar": 0,
            "region": region,
        }

    combined_conn = sqlite3.connect(combined_path)
    try:
        # Use a literal path here — sqlite3.attach takes a quoted string.
        # Escape single quotes in the path defensively.
        safe_path = pending_path.replace("'", "''")
        combined_conn.execute(f"ATTACH DATABASE '{safe_path}' AS pend")

        overlap_count = 0
        tiles_scanned = 0
        tiles_similar = 0

        cur = combined_conn.execute(
            f"""SELECT main.{MAPPIECE_TABLE}.position,
                       main.{MAPPIECE_TABLE}.data,
                       pend.{MAPPIECE_TABLE}.data
                FROM main.{MAPPIECE_TABLE}
                INNER JOIN pend.{MAPPIECE_TABLE}
                  ON main.{MAPPIECE_TABLE}.position = pend.{MAPPIECE_TABLE}.position"""
        )

        for pos, combined_blob, pending_blob in cur:
            if region is not None:
                # Filter by region — convert tile position → world block bounds
                tx, ty = decode_position(pos)
                tile_min_x = tx * TILE_SIZE
                tile_min_z = ty * TILE_SIZE
                tile_max_x = tile_min_x + TILE_SIZE - 1
                tile_max_z = tile_min_z + TILE_SIZE - 1
                rmin_x, rmax_x, rmin_z, rmax_z = region
                if (tile_max_x < rmin_x or tile_min_x > rmax_x
                        or tile_max_z < rmin_z or tile_min_z > rmax_z):
                    continue

            overlap_count += 1
            try:
                samples_a = _sample_n_pixels(combined_blob, _MATCH_PIXELS_PER_TILE, pos)
                samples_b = _sample_n_pixels(pending_blob, _MATCH_PIXELS_PER_TILE, pos)
            except Exception:
                # Non-decodable blob — skip the pixel comparison for this tile
                # but still count it as overlapping.
                continue

            denominator = 0
            matches = 0
            for a, b in zip(samples_a, samples_b):
                if a[3] == 0 or b[3] == 0:
                    continue
                denominator += 1
                if _pixel_close(a, b):
                    matches += 1

            if denominator == 0:
                continue
            tiles_scanned += 1
            # Threshold scales with how many samples actually had data.
            # 8/11 → ~73% — apply the same ratio when fewer samples count.
            required = max(1, int(round(denominator * _MATCH_SIMILAR_THRESHOLD
                                        / (_MATCH_PIXELS_PER_TILE + 1))))
            if matches >= required:
                tiles_similar += 1
    finally:
        try:
            combined_conn.execute("DETACH DATABASE pend")
        except sqlite3.OperationalError:
            pass
        combined_conn.close()

    tile_overlap_pct = round(100.0 * overlap_count / pending_total, 2)
    pixel_similar_pct = (
        round(100.0 * tiles_similar / tiles_scanned, 2) if tiles_scanned > 0 else 0.0
    )

    return {
        "tile_overlap_pct": tile_overlap_pct,
        "pixel_similar_pct": pixel_similar_pct,
        "overlap_count": overlap_count,
        "pending_total": pending_total,
        "tiles_scanned": tiles_scanned,
        "tiles_similar": tiles_similar,
        "region": region,
    }


def _compute_match_score_for_contribution(cid: str) -> dict:
    """Worker entry point: download both DBs from R2 and run the scorer.

    Raises on any error so :mod:`backend.app.tasks.match_score` can mark
    the row as failed.
    """
    pending_key = r2_storage.pending_db_key(cid)

    combined_tmp = _ensure_combined_db_temp()
    pending_tmp = _download_to_temp(pending_key)
    try:
        return _compute_match_score(combined_tmp, pending_tmp)
    finally:
        for p in (combined_tmp, pending_tmp):
            try:
                os.unlink(p)
            except OSError:
                pass


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
        # Phase 1 — surface the match-score result in a flat ``match_score``
        # field. The raw column values are dropped from the response so the
        # frontend doesn't have to know the storage shape.
        status = row.pop("match_score_status", None)
        score_json = row.pop("match_score_json", None) or {}
        row.pop("match_score_attempts", None)
        if status is None:
            row["match_score"] = None
        elif status == "ready":
            row["match_score"] = {
                "status": "ready",
                "tile_overlap_pct": score_json.get("tile_overlap_pct", 0.0),
                "pixel_similar_pct": score_json.get("pixel_similar_pct", 0.0),
                "overlap_count": score_json.get("overlap_count", 0),
                "pending_total": score_json.get("pending_total", 0),
            }
        elif status == "failed":
            row["match_score"] = {
                "status": "failed",
                "reason": score_json.get("reason"),
            }
        else:
            row["match_score"] = {"status": status}
    for row in approved:
        if row.get("approved_at") and hasattr(row["approved_at"], "isoformat"):
            row["approved_at"] = row["approved_at"].isoformat()

    contribution_status = _get_contribution_status(api_key)

    # Phase 3 — public contribution history. Non-admins see contributions
    # that were approved (or withdrawn-with-preview) within the last
    # ``HISTORY_RETENTION_DAYS`` days. Admins see everything still retained
    # (paginated by ``history_limit``/``history_offset`` query args, default
    # 50). The grid is feature-gated so disabling ``public_history`` makes
    # the field empty for non-admins without breaking the response shape.
    history: list = []
    history_total = 0
    public_history_on = is_feature_enabled("public_history")
    is_admin = _is_admin_key(api_key)
    if public_history_on or is_admin:
        if is_admin:
            history_limit = 50
            history_offset = 0
            try:
                history_limit = max(1, min(200, int(request.query_params.get("history_limit", "50"))))
                history_offset = max(0, int(request.query_params.get("history_offset", "0")))
            except (TypeError, ValueError):
                pass
            since = None
        else:
            history_limit = 100
            history_offset = 0
            since = datetime.now(timezone.utc) - timedelta(
                days=settings.HISTORY_RETENTION_DAYS
            )
        rows = db.list_history_contributions(
            since=since,
            include_withdrawn=True,
            limit=history_limit,
            offset=history_offset,
        )
        history_total = db.count_history_contributions(
            since=since,
            include_withdrawn=True,
        )
        for row in rows:
            cid = row["id"]
            preview_key = r2_storage.history_preview_key(cid)
            signed = r2_storage.generate_presigned_download_url(
                preview_key,
                expires_seconds=3 * 24 * 60 * 60,
            )
            anonymise = (row.get("status") == "withdrawn") or not (
                is_admin
                or (api_key and row.get("submitted_by_key") == api_key)
            )
            entry = {
                "id": cid,
                "status": row.get("status"),
                "contributor": (
                    "Anonymous" if anonymise else (row.get("contributor") or "Anonymous")
                ),
                "tile_count": row.get("tile_count") or 0,
                "tiles_new": row.get("tiles_new"),
                "tiles_existing": row.get("tiles_existing"),
                "combined_total": row.get("combined_total"),
                "approved_at": (
                    row["approved_at"].isoformat()
                    if row.get("approved_at") and hasattr(row["approved_at"], "isoformat")
                    else row.get("approved_at")
                ),
                "withdrawn_at": (
                    row["withdrawn_at"].isoformat()
                    if row.get("withdrawn_at") and hasattr(row["withdrawn_at"], "isoformat")
                    else row.get("withdrawn_at")
                ),
                "preview_signed_url": signed or None,
                "is_mine": bool(api_key and row.get("submitted_by_key") == api_key),
            }
            # Phase 4b — surface revert eligibility so the admin UI can show
            # the Revert button only on rows that can actually be reverted.
            if is_admin:
                approved_at = row.get("approved_at")
                in_window = False
                if approved_at:
                    cutoff = datetime.now(timezone.utc) - timedelta(
                        days=settings.REVERT_WINDOW_DAYS
                    )
                    in_window = approved_at >= cutoff
                entry["revert_supported"] = bool(row.get("revert_supported"))
                entry["revert_added_count"] = row.get("revert_added_count")
                entry["revert_replaced_count"] = row.get("revert_replaced_count")
                entry["reverted_at"] = (
                    row["reverted_at"].isoformat()
                    if row.get("reverted_at") and hasattr(row["reverted_at"], "isoformat")
                    else row.get("reverted_at")
                )
                entry["can_revert"] = bool(
                    is_feature_enabled("per_contribution_revert")
                    and row.get("status") == "approved"
                    and row.get("revert_supported")
                    and in_window
                )
            history.append(entry)

    response = {
        "map_id": settings.CONTRIBUTE_MAP_ID,
        "total_tiles": total_tiles,
        "pending": pending,
        "withdrawn": withdrawn,
        "approved": approved,
        "history": history,
        "history_total": history_total,
        "history_window_days": settings.HISTORY_RETENTION_DAYS,
        "public_history_enabled": public_history_on,
        "is_admin": is_admin,
        "match_score_enabled": is_feature_enabled("match_score"),
        "revert_enabled": is_feature_enabled("per_contribution_revert"),
        "revert_window_days": settings.REVERT_WINDOW_DAYS,
        "withdraw_limit_per_week": settings.WITHDRAW_LIMIT_PER_WEEK,
        **_withdraw_status(api_key),
        **contribution_status,
    }
    return response


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

    # Phase 0a: serialise mutations of the combined .db with a global lock.
    try:
        lock_token = db.acquire_map_lock("approve")
    except db.MapLocked as exc:
        return JSONResponse(status_code=423, content={"detail": str(exc)})

    try:
        # Download both to temp, merge, re-upload combined
        combined_tmp = _ensure_combined_db_temp()
        pending_tmp = _download_to_temp(pending_key)
        affected_bounds = None
        # Phase 4b — stream every newly-inserted position to a local temp
        # file as ``little-endian uint64`` so a future revert can replay
        # the inverse. We hard-cap the file size to
        # ``REVERT_ADDED_BIN_MAX_BYTES`` to avoid pathologically huge undo
        # blobs; if exceeded we mark the contribution as
        # ``revert_supported = false`` (admins fall back to backup-restore).
        import struct
        added_fd, added_tmp_path = tempfile.mkstemp(suffix=".added.bin")
        added_file = os.fdopen(added_fd, "wb")
        added_state = {"count": 0, "bytes": 0, "exceeded": False}
        added_max = settings.REVERT_ADDED_BIN_MAX_BYTES

        def _added_writer(position: int) -> None:
            if added_state["exceeded"]:
                return
            if added_state["bytes"] + 8 > added_max:
                added_state["exceeded"] = True
                return
            added_file.write(struct.pack("<Q", int(position) & 0xFFFFFFFFFFFFFFFF))
            added_state["count"] += 1
            added_state["bytes"] += 8

        try:
            # Capture affected world-block bounds BEFORE merging so we know which
            # cache chunks to invalidate. Falls back to None on any error → full regen.
            try:
                affected_bounds = _compute_pending_world_bounds(pending_tmp)
            except Exception:
                affected_bounds = None

            stats = _merge_into_combined(
                pending_tmp, combined_tmp, added_writer=_added_writer
            )

            # Refresh cached TOPS stats from the merged local DB file.
            from ..core.mapdb import get_map_stats_from_path
            db.set_tops_map_stats(get_map_stats_from_path(combined_tmp))

            # Upload updated combined DB back to R2
            _upload_from_path(combined_tmp, r2_storage.COMBINED_DB_KEY)
        finally:
            try:
                added_file.close()
            except Exception:
                pass
            os.unlink(combined_tmp)
            os.unlink(pending_tmp)

        # Phase 4b — persist the undo blob to R2 unless the cap was hit.
        # ``revert_supported`` is the single boolean the revert endpoint
        # consults; ``revert_added_count`` powers the confirmation dialog.
        revert_supported = (
            (not added_state["exceeded"]) and added_state["count"] > 0
        )
        try:
            if revert_supported:
                r2_storage.upload_file(
                    added_tmp_path,
                    r2_storage.undo_added_key(contribution_id),
                )
            elif added_state["exceeded"]:
                # Capture aborted mid-way — drop any partial bytes that may
                # have been uploaded by a previous attempt under the same id.
                r2_storage.delete_object(
                    r2_storage.undo_added_key(contribution_id)
                )
        except Exception:
            # Failed undo upload should not block approval; mark unsupported.
            revert_supported = False
        finally:
            try:
                os.unlink(added_tmp_path)
            except OSError:
                pass

        try:
            db.set_revert_metadata(
                contribution_id,
                revert_supported=revert_supported,
                added_count=added_state["count"],
                # Region/overwrite mode (Phase 2) populates this; gap-fill is 0.
                replaced_count=0,
                affected_bounds=affected_bounds,
            )
        except Exception:
            pass

        # Update Supabase
        db.mark_approved(
            contribution_id,
            tiles_new=stats["tiles_new"],
            tiles_existing=stats["tiles_existing"],
            combined_total=stats["combined_total"],
        )
        db.set_cached_tile_count(stats["combined_total"])
    finally:
        db.release_map_lock(lock_token)

    # Phase 0d: unified audit log for contribution approvals.
    try:
        accounts_db.audit_log(
            api_key,
            "contribution.approve",
            target=contribution_id,
            metadata={
                "tiles_new": stats["tiles_new"],
                "tiles_existing": stats["tiles_existing"],
                "combined_total": stats["combined_total"],
            },
        )
    except Exception:
        pass

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

    # Phase 3 — promote the preview into the public history bucket and stamp
    # a retention deadline. Admin-uploaded contributions get a longer window
    # because the team uses them as a reviewable audit trail.
    pending_preview_key = r2_storage.pending_preview_key(contribution_id)
    history_preview_key = r2_storage.history_preview_key(contribution_id)
    if r2_storage.object_exists(pending_preview_key):
        try:
            r2_storage.move_object(pending_preview_key, history_preview_key)
        except Exception:
            # Best-effort — fall back to deleting the pending preview so we
            # never leak it under the old key.
            r2_storage.delete_object(pending_preview_key)

    if is_feature_enabled("public_history"):
        retention_days = (
            settings.ADMIN_HISTORY_RETENTION_DAYS
            if _is_admin_key(meta.get("submitted_by_key") or "")
            else settings.HISTORY_RETENTION_DAYS
        )
        try:
            db.set_preview_retained_until(
                contribution_id,
                datetime.now(timezone.utc) + timedelta(days=retention_days),
            )
        except Exception:
            pass

    result = {"message": "Contribution approved and merged", **stats}
    if archive_moved:
        result["archived_db_key"] = archived_key
    else:
        result["archive_warning"] = "Contribution approved but DB archive move failed"
    return result


# ---------------------------------------------------------------------------
# Phase 3 — Withdrawal rate limit (ISO week)
# ---------------------------------------------------------------------------

def _iso_week_start(now: Optional[datetime] = None) -> datetime:
    """Return Monday 00:00 UTC of the ISO week containing ``now``."""
    now = now or datetime.now(timezone.utc)
    iso = now.isocalendar()  # (year, week, weekday) — weekday 1 = Monday
    monday_date = datetime.fromisocalendar(iso[0], iso[1], 1)
    return monday_date.replace(tzinfo=timezone.utc)


def _next_iso_week_start(now: Optional[datetime] = None) -> datetime:
    return _iso_week_start(now) + timedelta(days=7)


def _check_withdraw_limit(api_key: str) -> None:
    """Raise HTTPException(429) when the caller has hit the per-week
    withdrawal cap. Admins are exempt."""
    if _is_admin_key(api_key) or not api_key:
        return
    week_start = _iso_week_start()
    used = db.count_user_withdrawals_in_iso_week(api_key, week_start)
    if used >= settings.WITHDRAW_LIMIT_PER_WEEK:
        next_allowed = _next_iso_week_start()
        raise HTTPException(
            status_code=429,
            detail=(
                f"You've withdrawn {used} contributions this ISO week "
                f"(limit: {settings.WITHDRAW_LIMIT_PER_WEEK}). "
                f"You can withdraw again on {next_allowed.isoformat()}."
            ),
        )


def _withdraw_status(api_key: str) -> dict:
    """Per-key withdrawal counters surfaced on ``/contribute/info`` so the
    frontend can pre-emptively disable the Withdraw button when the user has
    already hit their weekly cap."""
    if _is_admin_key(api_key) or not api_key:
        return {
            "withdrawals_used_this_week": 0,
            "withdraw_next_allowed_at": None,
        }
    week_start = _iso_week_start()
    used = db.count_user_withdrawals_in_iso_week(api_key, week_start)
    next_allowed = (
        _next_iso_week_start().isoformat()
        if used >= settings.WITHDRAW_LIMIT_PER_WEEK
        else None
    )
    return {
        "withdrawals_used_this_week": used,
        "withdraw_next_allowed_at": next_allowed,
    }


@router.post("/contribute/{contribution_id}/withdraw")
async def contribute_withdraw(
    contribution_id: str,
    api_key: str = Depends(verify_api_key),
):
    """Owner: soft-delete a pending contribution.

    Removes the .db file from R2 immediately, anonymises the contributor name,
    and marks the contribution as 'withdrawn'. If a preview was generated it
    is moved into the public history bucket and retained for the same window
    as approved contributions — admins and the contributor can still see what
    was uploaded, which cuts down on "user re-uploads the same wrong file"
    support churn.
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

    # Phase 3 — enforce the per-ISO-week cap before any state mutation.
    _check_withdraw_limit(api_key)

    # Always remove the raw .db immediately — withdraw is privacy-driven.
    r2_storage.delete_object(r2_storage.pending_db_key(contribution_id))

    # If a preview exists, move it into the history bucket; otherwise nothing
    # to retain. Either way the pending preview key ends up empty.
    pending_preview_key = r2_storage.pending_preview_key(contribution_id)
    history_preview_key = r2_storage.history_preview_key(contribution_id)
    preview_retained = False
    if r2_storage.object_exists(pending_preview_key):
        try:
            r2_storage.move_object(pending_preview_key, history_preview_key)
            preview_retained = True
        except Exception:
            r2_storage.delete_object(pending_preview_key)

    # Soft-delete in DB (anonymise + status='withdrawn')
    db.withdraw_contribution(contribution_id, api_key)

    if preview_retained and is_feature_enabled("public_history"):
        try:
            db.set_preview_retained_until(
                contribution_id,
                datetime.now(timezone.utc) + timedelta(days=settings.HISTORY_RETENTION_DAYS),
            )
        except Exception:
            pass

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

    # Phase 0d: unified audit log for rejections.
    try:
        accounts_db.audit_log(api_key, "contribution.reject", target=contribution_id)
    except Exception:
        pass

    return {"message": "Contribution rejected and deleted"}


@router.post("/contribute/{contribution_id}/recompute-match-score")
async def contribute_recompute_match_score(
    contribution_id: str,
    api_key: str = Depends(verify_api_key),
):
    """Admin-only: re-enqueue match-score computation for a pending row.

    Returns 404 when the ``match_score`` feature flag is off (so the route
    is invisible to clients when the feature is disabled). Returns 409 if
    the contribution isn't pending. The worker re-attempt counter is reset
    by ``set_match_score_pending`` only insofar as it bumps attempts; if a
    row has already exceeded ``MATCH_SCORE_MAX_ATTEMPTS`` the worker will
    simply skip it again. Admins should fix the underlying cause first.
    """
    if not is_feature_enabled("match_score"):
        return JSONResponse(status_code=404, content={"detail": "Not found"})

    try:
        _verify_admin_key(api_key)
    except ValueError as e:
        return JSONResponse(status_code=403, content={"detail": str(e)})

    meta = db.get_contribution(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    # Reset attempts so a stuck "failed" row gets a clean retry budget when
    # an admin explicitly asks for one.
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE contributions
                           SET match_score_status = 'pending',
                               match_score_json   = NULL,
                               match_score_attempts = 0
                       WHERE id = %s""",
                    (contribution_id,),
                )
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

    match_score_task.start_job(contribution_id)
    return {"message": "Match-score computation re-enqueued"}
