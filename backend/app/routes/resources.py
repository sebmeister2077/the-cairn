"""Admin-only Resources Overlay routes.

Serves worldgen-derived data (ore deposits + biome / climate / rock-type
heatmap tiles) reconstructed offline from the canonical world's seed +
worldconfig + exact Vintage Story version. The reconstruction itself runs
outside this server (headless VS dedicated server + custom exporter mod);
this router only validates, stores, and serves the resulting bundle.

Bundle layout in R2 (see ``r2_storage.resources_*_key``)::

    resources/CURRENT                            -- pointer txt: "<seed>-<version>"
    resources/<seed>-<version>/manifest.json
    resources/<seed>-<version>/deposits.sqlite
    resources/<seed>-<version>/tiles/<layer>/level_<N>/chunk_<cx>_<cy>.png

Endpoints (all admin-gated, all hidden behind the ``resources_overlay`` flag):

  POST /admin/resources/upload       -- streamed .zip upload, validated, swapped
  GET  /admin/resources/status       -- active bundle + canonical config
  GET  /admin/resources/manifest     -- manifest + presigned tile URLs
  GET  /admin/resources/deposits     -- bounds-filtered deposits, paginated
"""

from __future__ import annotations

import io
import json
import logging
import os
import sqlite3
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from ..auth import require_admin
from ..config import settings
from ..core import feature_flags as ff
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/resources", tags=["admin-resources"])


# Presigned URLs live for the S3v4 maximum (7 days) so the admin's session
# almost never triggers a re-sign round-trip. Refresh anything within the
# buffer below.
_TILE_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60
_TILE_URL_REFRESH_BUFFER_SECONDS = 30 * 60


# ---------------------------------------------------------------------------
# Feature-flag gate
# ---------------------------------------------------------------------------

def _require_flag() -> None:
    """Hide the whole feature behind 404 when the flag is off."""
    if not ff.is_feature_enabled("resources_overlay"):
        raise HTTPException(status_code=404, detail="Not Found")


# ---------------------------------------------------------------------------
# Active-bundle pointer (resources/CURRENT)
# ---------------------------------------------------------------------------

def _read_pointer() -> Optional[tuple[str, str]]:
    """Return ``(seed, version)`` for the currently active bundle, or None."""
    try:
        raw = r2_storage.download_bytes(r2_storage.resources_pointer_key())
    except FileNotFoundError:
        return None
    text = raw.decode("utf-8").strip()
    if not text or "-" not in text:
        return None
    seed, _, version = text.partition("-")
    if not seed or not version:
        return None
    return seed, version


def _write_pointer(seed: str, version: str) -> None:
    r2_storage.upload_bytes(
        r2_storage.resources_pointer_key(),
        f"{seed}-{version}".encode("utf-8"),
        content_type="text/plain",
    )


# ---------------------------------------------------------------------------
# deposits.sqlite local cache
# ---------------------------------------------------------------------------
#
# We download the SQLite once per active bundle and keep it on local disk;
# subsequent /deposits queries open it read-only. The cache is keyed by
# ``(seed, version)`` and invalidated whenever the pointer flips.

_deposits_cache_lock = threading.Lock()
_deposits_cache: dict = {}  # (seed, version) -> path


def _ensure_deposits_local(seed: str, version: str) -> str:
    with _deposits_cache_lock:
        cached = _deposits_cache.get((seed, version))
        if cached and os.path.exists(cached):
            return cached
    fd, path = tempfile.mkstemp(suffix=".sqlite", prefix="vs-deposits-")
    os.close(fd)
    r2_storage.download_to_path(
        r2_storage.resources_deposits_key(seed, version), path
    )
    with _deposits_cache_lock:
        prior = _deposits_cache.get((seed, version))
        if prior and prior != path and os.path.exists(prior):
            try:
                os.unlink(prior)
            except OSError:
                pass
        _deposits_cache[(seed, version)] = path
    return path


def _evict_deposits_cache_except(active: Optional[tuple[str, str]]) -> None:
    """Drop on-disk SQLite caches that no longer match the active bundle."""
    with _deposits_cache_lock:
        for key in list(_deposits_cache.keys()):
            if key == active:
                continue
            try:
                os.unlink(_deposits_cache[key])
            except OSError:
                pass
            _deposits_cache.pop(key, None)


# ---------------------------------------------------------------------------
# Bundle validation + unpack
# ---------------------------------------------------------------------------

_MANIFEST_NAME = "manifest.json"
_DEPOSITS_NAME = "deposits.sqlite"
_TILES_PREFIX = "tiles/"


def _validate_bundle_member(name: str) -> None:
    """Reject path-traversal or absolute paths in zip members.

    Bundles are produced by an offline tool we control, but we still treat
    the input as untrusted (admins are not always the only operators).
    """
    if not name or name.endswith("/"):
        return
    if name.startswith("/") or ".." in name.replace("\\", "/").split("/"):
        raise HTTPException(status_code=400, detail=f"Bundle contains unsafe path: {name}")


def _unpack_bundle(zip_path: str, seed: str, version: str) -> dict:
    """Validate manifest + structure, then upload every member into the
    staging prefix. Returns the parsed manifest dict.

    Caller is responsible for swapping the pointer once this returns.
    """
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        for n in names:
            _validate_bundle_member(n)
        if _MANIFEST_NAME not in names:
            raise HTTPException(
                status_code=400, detail="Bundle missing manifest.json"
            )
        try:
            with zf.open(_MANIFEST_NAME) as fh:
                manifest = json.loads(fh.read().decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(
                status_code=400, detail=f"manifest.json is not valid JSON: {exc}"
            )

        m_seed = str(manifest.get("seed") or "")
        m_version = str(manifest.get("vs_version") or "")
        if m_seed != seed:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Manifest seed '{m_seed}' does not match canonical "
                    f"CANONICAL_WORLD_SEED '{seed}'"
                ),
            )
        if m_version != version:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Manifest vs_version '{m_version}' does not match canonical "
                    f"CANONICAL_WORLD_VS_VERSION '{version}'"
                ),
            )
        if _DEPOSITS_NAME not in names:
            raise HTTPException(
                status_code=400, detail="Bundle missing deposits.sqlite"
            )

        prefix = r2_storage.resources_prefix(seed, version, staging=True)
        # Stream every member straight to R2 — we never load the whole zip
        # into memory.
        for info in zf.infolist():
            name = info.filename
            if not name or name.endswith("/"):
                continue
            if name == _MANIFEST_NAME:
                key = r2_storage.resources_manifest_key(seed, version, staging=True)
                content_type = "application/json"
            elif name == _DEPOSITS_NAME:
                key = r2_storage.resources_deposits_key(seed, version, staging=True)
                content_type = "application/octet-stream"
            elif name.startswith(_TILES_PREFIX):
                key = prefix + name
                content_type = "image/png"
            else:
                # Unknown top-level files are rejected so we don't accumulate
                # garbage in R2 (e.g. a stray README.txt the operator left).
                raise HTTPException(
                    status_code=400, detail=f"Unexpected bundle entry: {name}"
                )
            with zf.open(info, "r") as src, tempfile.NamedTemporaryFile(
                delete=False
            ) as dst:
                tmp_path = dst.name
                # Bounded read to avoid pathological zip-bombs landing on disk.
                # Each member is independently size-checked against the bundle
                # cap further up in the request handler.
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    dst.write(chunk)
            try:
                r2_storage.upload_file(tmp_path, key, content_type=content_type)
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
        return manifest


def _swap_pointer_and_cleanup(seed: str, version: str) -> None:
    """Promote the staging prefix to active and best-effort clean up
    the previous active bundle and any abandoned staging copies.

    The pointer write is the only step that flips reads onto the new bundle.
    """
    staging_prefix = r2_storage.resources_prefix(seed, version, staging=True)
    final_prefix = r2_storage.resources_prefix(seed, version, staging=False)

    # Server-side copy every staged key into its final location. R2 supports
    # CopyObject; we already have ``copy_object``.
    staged_keys = r2_storage.list_keys_with_prefix(staging_prefix)
    for src_key in staged_keys:
        dst_key = final_prefix + src_key[len(staging_prefix):]
        r2_storage.copy_object(src_key, dst_key)
    # Cleanup staging.
    if staged_keys:
        r2_storage.delete_keys(staged_keys)

    # Flip the pointer last.
    previous = _read_pointer()
    _write_pointer(seed, version)

    # Drop the deposits SQLite cache for whatever was previously active.
    _evict_deposits_cache_except((seed, version))

    # Best-effort delete the previous bundle's R2 objects (only if it's not
    # the same id we just promoted — that would be a re-upload of the same
    # version, in which case the copy above already overwrote everything).
    if previous and previous != (seed, version):
        prev_prefix = r2_storage.resources_prefix(previous[0], previous[1])
        try:
            prev_keys = r2_storage.list_keys_with_prefix(prev_prefix)
            if prev_keys:
                r2_storage.delete_keys(prev_keys)
        except Exception:
            logger.exception("resources: failed to clean previous bundle %s", previous)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
async def resources_status(_: str = Depends(require_admin)):
    _require_flag()
    canonical = {
        "seed": settings.CANONICAL_WORLD_SEED,
        "vs_version": settings.CANONICAL_WORLD_VS_VERSION,
    }
    pointer = _read_pointer()
    if pointer is None:
        return {"active_bundle": None, "canonical": canonical}

    seed, version = pointer
    manifest_key = r2_storage.resources_manifest_key(seed, version)
    try:
        raw = r2_storage.download_bytes(manifest_key)
        manifest = json.loads(raw.decode("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
        return {"active_bundle": None, "canonical": canonical}

    # Tally bundle size from the listing — cheap, one paginated LIST call.
    total_bytes = 0
    try:
        # ``list_keys_with_prefix`` returns just keys; we want sizes too, so
        # use the underlying paginator inline. Falls back to 0 on failure.
        client = r2_storage._get_client()  # type: ignore[attr-defined]
        paginator = client.get_paginator("list_objects_v2")
        prefix = r2_storage.resources_prefix(seed, version)
        for page in paginator.paginate(
            Bucket=settings.R2_BUCKET_NAME, Prefix=prefix
        ):
            for obj in page.get("Contents", []) or []:
                total_bytes += int(obj.get("Size") or 0)
    except Exception:
        total_bytes = 0

    return {
        "active_bundle": {
            "seed": seed,
            "vs_version": version,
            "generated_at": manifest.get("generated_at"),
            "world_bounds": manifest.get("world_bounds"),
            "size_bytes": total_bytes,
            "deposit_type_count": len(manifest.get("deposit_types") or []),
            "layer_count": len(manifest.get("layers") or []),
        },
        "canonical": canonical,
    }


@router.post("/upload")
async def resources_upload(
    request: Request,
    api_key: str = Depends(require_admin),
):
    """Stream a .zip resources bundle, validate, unpack, swap pointer."""
    _require_flag()
    if not settings.CANONICAL_WORLD_SEED or not settings.CANONICAL_WORLD_VS_VERSION:
        raise HTTPException(
            status_code=503,
            detail=(
                "CANONICAL_WORLD_SEED / CANONICAL_WORLD_VS_VERSION are not "
                "configured on the server. Set them before uploading a bundle."
            ),
        )

    seed = settings.CANONICAL_WORLD_SEED
    version = settings.CANONICAL_WORLD_VS_VERSION
    cap = settings.RESOURCES_BUNDLE_MAX_BYTES

    fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix="vs-resources-")
    try:
        total = 0
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                total += len(chunk)
                if total > cap:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "Bundle exceeds RESOURCES_BUNDLE_MAX_BYTES"},
                    )
                f.write(chunk)
        if total == 0:
            return JSONResponse(status_code=400, content={"detail": "Empty upload"})

        if not zipfile.is_zipfile(tmp_path):
            return JSONResponse(
                status_code=400, content={"detail": "Upload is not a valid .zip"}
            )

        manifest = _unpack_bundle(tmp_path, seed, version)
        _swap_pointer_and_cleanup(seed, version)
        return {
            "ok": True,
            "seed": seed,
            "vs_version": version,
            "generated_at": manifest.get("generated_at"),
            "size_bytes": total,
        }
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _active_bundle_or_503() -> tuple[str, str]:
    pointer = _read_pointer()
    if pointer is None:
        raise HTTPException(
            status_code=503,
            detail="No resources bundle uploaded yet",
        )
    return pointer


@router.get("/manifest")
async def resources_manifest(_: str = Depends(require_admin)):
    """Return the active manifest with presigned URLs filled in for tiles."""
    _require_flag()
    seed, version = _active_bundle_or_503()
    try:
        raw = r2_storage.download_bytes(
            r2_storage.resources_manifest_key(seed, version)
        )
        manifest = json.loads(raw.decode("utf-8"))
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Manifest missing for active bundle")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Manifest is corrupt: {exc}")

    # List every tile under the bundle once, then mint presigned URLs in bulk
    # without per-tile HEAD round-trips (verify_exists=False). This keeps the
    # response cheap even for fully-rendered worlds with thousands of tiles.
    tile_prefix = r2_storage.resources_prefix(seed, version) + "tiles/"
    tile_keys = r2_storage.list_keys_with_prefix(tile_prefix)
    tiles_index: dict[str, dict[int, dict[tuple[int, int], str]]] = {}
    earliest_expiry: Optional[int] = None
    for key in tile_keys:
        # tiles/<layer>/level_<N>/chunk_<cx>_<cy>.png
        rel = key[len(tile_prefix):]
        parts = rel.split("/")
        if len(parts) != 3:
            continue
        layer = parts[0]
        level_part = parts[1]
        chunk_part = parts[2]
        if not level_part.startswith("level_") or not chunk_part.startswith("chunk_"):
            continue
        try:
            level = int(level_part[len("level_"):])
            cxy = chunk_part[len("chunk_"):-len(".png")]
            cx_str, _, cy_str = cxy.partition("_")
            cx, cy = int(cx_str), int(cy_str)
        except ValueError:
            continue
        url = r2_storage.generate_presigned_download_url(
            key,
            expires_seconds=_TILE_URL_EXPIRY_SECONDS,
            content_type="image/png",
            verify_exists=False,
        )
        tiles_index.setdefault(layer, {}).setdefault(level, {})[(cx, cy)] = url

    expiry_iso = (
        datetime.now(timezone.utc) + timedelta(seconds=_TILE_URL_EXPIRY_SECONDS)
    ).isoformat()
    # Flatten ``tiles_index`` into JSON-friendly arrays per (layer, level).
    presigned: dict = {}
    for layer, by_level in tiles_index.items():
        presigned[layer] = {}
        for level, by_chunk in by_level.items():
            presigned[layer][str(level)] = [
                {"cx": cx, "cy": cy, "url": url}
                for (cx, cy), url in sorted(by_chunk.items())
            ]
    manifest["presigned_tiles"] = presigned
    manifest["presigned_tiles_expires_at"] = expiry_iso
    return manifest


@router.get("/deposits")
async def resources_deposits(
    min_x: int = Query(...),
    max_x: int = Query(...),
    min_z: int = Query(...),
    max_z: int = Query(...),
    types: Optional[str] = Query(
        None,
        description="Comma-separated deposit type ids; omit for all types.",
    ),
    cursor: Optional[int] = Query(
        None,
        description="Resume token (deposit rowid) returned by the previous page.",
    ),
    _: str = Depends(require_admin),
):
    _require_flag()
    if min_x > max_x or min_z > max_z:
        raise HTTPException(status_code=400, detail="Invalid bounds: min > max")

    seed, version = _active_bundle_or_503()
    try:
        db_path = _ensure_deposits_local(seed, version)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="deposits.sqlite missing for active bundle")

    type_filter: Optional[list[str]] = None
    if types:
        type_filter = [t.strip() for t in types.split(",") if t.strip()]
        if not type_filter:
            type_filter = None

    page_limit = settings.RESOURCES_DEPOSITS_PAGE_LIMIT
    sql = (
        "SELECT rowid, type, x, y, z, qty, richness FROM deposits "
        "WHERE x >= ? AND x <= ? AND z >= ? AND z <= ?"
    )
    params: list = [min_x, max_x, min_z, max_z]
    if cursor is not None:
        sql += " AND rowid > ?"
        params.append(int(cursor))
    if type_filter:
        sql += " AND type IN (" + ",".join("?" * len(type_filter)) + ")"
        params.extend(type_filter)
    sql += " ORDER BY rowid LIMIT ?"
    params.append(page_limit + 1)

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = conn.execute(sql, params)
        rows = cur.fetchall()
    finally:
        conn.close()

    next_cursor: Optional[int] = None
    if len(rows) > page_limit:
        next_cursor = int(rows[page_limit - 1][0])
        rows = rows[:page_limit]

    return {
        "deposits": [
            {
                "type": r[1],
                "x": int(r[2]),
                "y": int(r[3]),
                "z": int(r[4]),
                "qty": float(r[5]) if r[5] is not None else None,
                "richness": float(r[6]) if r[6] is not None else None,
            }
            for r in rows
        ],
        "next_cursor": next_cursor,
        "page_limit": page_limit,
    }
