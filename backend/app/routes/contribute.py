"""Contribute endpoints — players upload map .db files for admin review.

POST /api/contribute          — upload a .db (saved as pending)
GET  /api/contribute/info     — map ID, combined stats, pending & approved list
GET  /api/contribute/preview/:id — render a preview PNG (combined + new tiles highlighted)
POST /api/contribute/:id/approve — admin-only: merge pending contribution
POST /api/contribute/:id/reject  — admin-only: discard pending contribution
"""

import json
import os
import sqlite3
import tempfile
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Set

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response

from ..auth import verify_api_key
from ..config import settings
from ..rate_limiter import check_rate_limit

router = APIRouter()

MAPPIECE_TABLE = "mappiece"
BLOCKIDMAPPING_TABLE = "blockidmapping"


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _data_dir() -> Path:
    return Path(settings.CONTRIBUTE_DATA_DIR)


def _pending_dir() -> Path:
    return _data_dir() / "pending"


def _combined_db_path() -> Path:
    return _data_dir() / "globalservermap.db"


def _log_path() -> Path:
    return _data_dir() / "contributions.json"


def _ensure_dirs():
    _data_dir().mkdir(parents=True, exist_ok=True)
    _pending_dir().mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Combined DB helpers
# ---------------------------------------------------------------------------

def _ensure_combined_db(db_path: Path):
    if db_path.exists():
        return
    conn = sqlite3.connect(str(db_path))
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


def _tile_count_file() -> Path:
    return _data_dir() / "tile_count.txt"


def _read_cached_tile_count() -> int:
    p = _tile_count_file()
    if p.exists():
        try:
            return int(p.read_text().strip())
        except (ValueError, OSError):
            pass
    # Fallback: count from DB and cache
    return _recount_and_cache()


def _recount_and_cache() -> int:
    db_path = _combined_db_path()
    count = 0
    if db_path.exists():
        conn = sqlite3.connect(str(db_path))
        try:
            count = conn.execute(f"SELECT COUNT(*) FROM {MAPPIECE_TABLE}").fetchone()[0]
        except sqlite3.OperationalError:
            count = 0
        finally:
            conn.close()
    _tile_count_file().write_text(str(count))
    return count


def _update_cached_tile_count(count: int):
    _ensure_dirs()
    _tile_count_file().write_text(str(count))


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


# ---------------------------------------------------------------------------
# Pending contribution metadata
# ---------------------------------------------------------------------------

def _save_meta(cid: str, contributor: str, tile_count: int):
    meta = {
        "id": cid,
        "contributor": contributor or "Anonymous",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tile_count": tile_count,
        "status": "pending",
    }
    (_pending_dir() / f"{cid}.json").write_text(
        json.dumps(meta, indent=2), encoding="utf-8"
    )


def _read_meta(cid: str) -> Optional[dict]:
    p = _pending_dir() / f"{cid}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _list_pending() -> List[dict]:
    d = _pending_dir()
    if not d.exists():
        return []
    items = []
    for f in sorted(d.glob("*.json")):
        try:
            meta = json.loads(f.read_text(encoding="utf-8"))
            if meta.get("status") == "pending":
                items.append(meta)
        except (json.JSONDecodeError, OSError):
            continue
    return items


# ---------------------------------------------------------------------------
# Contribution log (approved merges)
# ---------------------------------------------------------------------------

def _append_log(entry: dict):
    log = _log_path()
    entries: list = []
    if log.exists():
        try:
            entries = json.loads(log.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            entries = []
    entries.append(entry)
    log.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def _read_log() -> list:
    log = _log_path()
    if not log.exists():
        return []
    try:
        return json.loads(log.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


# ---------------------------------------------------------------------------
# Merge logic
# ---------------------------------------------------------------------------

def _merge_into_combined(upload_path: str, combined_path: Path) -> dict:
    combined_conn = sqlite3.connect(str(combined_path))
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


# ---------------------------------------------------------------------------
# Preview rendering
# ---------------------------------------------------------------------------

def _render_preview(combined_path: Path, upload_path: str, max_dimension: int = 2048) -> bytes:
    """Render combined + upload map with new tiles highlighted in green."""
    from ..core.mapdb import (
        TILE_SIZE, STANDARD_BLOB_SIZE, POSITION_BITS, POSITION_MASK,
        decode_position, decode_tile_numpy, decode_tile_fallback, _sample_one_pixel,
    )
    from PIL import Image
    import numpy as np
    import io

    # Collect positions from combined
    combined_positions: Set[int] = set()
    if combined_path.exists():
        conn = sqlite3.connect(str(combined_path))
        try:
            combined_positions = {
                r[0] for r in conn.execute(f"SELECT position FROM {MAPPIECE_TABLE}")
            }
        except sqlite3.OperationalError:
            pass
        finally:
            conn.close()

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

    # Helper to paint tiles from a db
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

                        # Apply green tint to highlighted tiles
                        if is_highlight:
                            tinted = tile.copy().astype(np.float32)
                            tinted[:, :, 0] = tinted[:, :, 0] * 0.5  # R
                            tinted[:, :, 1] = np.minimum(tinted[:, :, 1] * 0.5 + 128, 255)  # G boost
                            tinted[:, :, 2] = tinted[:, :, 2] * 0.5  # B
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

    # Paint combined first (base layer), then upload with new tiles highlighted
    if combined_path.exists() and combined_positions:
        _paint_tiles(str(combined_path))
    _paint_tiles(upload_path, highlight_positions=new_positions)

    img = Image.fromarray(img_arr, "RGBA")
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


# ===========================================================================
# Routes
# ===========================================================================

@router.get("/contribute/info")
async def contribute_info(api_key: str = Depends(verify_api_key)):
    """Map ID, combined tile count, pending contributions, and approved log."""
    check_rate_limit(api_key)
    _ensure_dirs()

    total_tiles = _read_cached_tile_count()
    pending = _list_pending()
    approved = _read_log()

    return {
        "map_id": settings.CONTRIBUTE_MAP_ID,
        "total_tiles": total_tiles,
        "pending": pending,
        "approved": approved[-20:],
    }


@router.post("/contribute")
async def contribute_upload(
    request: Request,
    contributor: str = Query("", description="Optional contributor name"),
    api_key: str = Depends(verify_api_key),
):
    """Upload a .db map file. It is saved as pending for admin review."""
    check_rate_limit(api_key)

    # Stream raw request body to disk — bypasses multipart size limits
    _ensure_dirs()
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

        try:
            tile_count = _validate_upload(tmp_path)
        except ValueError as e:
            return JSONResponse(status_code=400, content={"detail": str(e)})

        # Save as pending
        _ensure_dirs()
        cid = uuid.uuid4().hex[:12]
        pending_db = _pending_dir() / f"{cid}.db"

        # Move temp file to pending dir
        import shutil
        shutil.move(tmp_path, str(pending_db))
        tmp_path = None  # prevent cleanup

        _save_meta(cid, contributor, tile_count)

        return {
            "message": "Upload received — pending admin approval",
            "contribution_id": cid,
            "contributor": contributor or "Anonymous",
            "tile_count": tile_count,
        }
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@router.get("/contribute/preview/{contribution_id}")
async def contribute_preview(
    contribution_id: str,
    api_key: str = Depends(verify_api_key),
):
    """Render a preview PNG: combined map + new tiles from this contribution highlighted."""
    check_rate_limit(api_key)
    _ensure_dirs()

    meta = _read_meta(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    pending_db = _pending_dir() / f"{contribution_id}.db"
    if not pending_db.exists():
        return JSONResponse(status_code=404, content={"detail": "Contribution database missing"})

    combined = _combined_db_path()
    _ensure_combined_db(combined)

    try:
        png_bytes = _render_preview(combined, str(pending_db))
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Content-Disposition": "inline; filename=preview.png"},
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

    _ensure_dirs()
    meta = _read_meta(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    pending_db = _pending_dir() / f"{contribution_id}.db"
    if not pending_db.exists():
        return JSONResponse(status_code=404, content={"detail": "Contribution database missing"})

    combined = _combined_db_path()
    _ensure_combined_db(combined)

    stats = _merge_into_combined(str(pending_db), combined)

    # Mark as approved and clean up
    meta["status"] = "approved"
    meta["approved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    meta.update(stats)
    (_pending_dir() / f"{contribution_id}.json").write_text(
        json.dumps(meta, indent=2), encoding="utf-8"
    )

    # Remove the pending .db file
    try:
        pending_db.unlink()
    except OSError:
        pass

    # Add to approved log
    _append_log({
        "id": contribution_id,
        "contributor": meta.get("contributor", "Anonymous"),
        "approved_at": meta["approved_at"],
        "tiles_new": stats["tiles_new"],
        "tiles_existing": stats["tiles_existing"],
        "combined_total": stats["combined_total"],
    })

    _update_cached_tile_count(stats["combined_total"])

    return {"message": "Contribution approved and merged", **stats}


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

    _ensure_dirs()
    meta = _read_meta(contribution_id)
    if not meta or meta.get("status") != "pending":
        return JSONResponse(status_code=404, content={"detail": "Contribution not found"})

    # Delete files
    for suffix in (".db", ".json"):
        p = _pending_dir() / f"{contribution_id}{suffix}"
        try:
            p.unlink()
        except OSError:
            pass

    return {"message": "Contribution rejected and deleted"}
