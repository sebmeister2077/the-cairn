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
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from ..auth import require_admin
from ..config import settings
from ..core import database as db
from ..core import feature_flags as ff
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/resources", tags=["admin-resources"])


# Presigned URLs live for the S3v4 maximum (7 days) so the admin's session
# almost never triggers a re-sign round-trip. Refresh anything within the
# buffer below.
_TILE_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60
_TILE_URL_REFRESH_BUFFER_SECONDS = 30 * 60

# Parallelism for fanning bundle members out to R2. Each worker owns one
# boto3 client (boto3 clients are thread-safe), so this maps directly to
# concurrent PUTs. 16 was the sweet spot for ~2k small tile uploads in
# local testing — higher counts saturate the Render egress without
# meaningfully reducing wall time.
_R2_UPLOAD_CONCURRENCY = 16

# Throttle DB writes from the worker. With 1878 tiles and per-file updates
# we'd hammer Postgres for no UI benefit. Flush whichever comes first.
_PROGRESS_FLUSH_EVERY_FILES = 25
_PROGRESS_FLUSH_EVERY_SECONDS = 1.0



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


def _unpack_bundle(
    zip_path: str,
    seed: str,
    version: str,
    *,
    job_id: Optional[str] = None,
) -> dict:
    """Validate manifest + structure, then upload every member into the
    staging prefix. Returns the parsed manifest dict.

    When ``job_id`` is given, the row in ``resources_upload_jobs`` is
    patched with progress updates (file count + bytes) as the upload
    proceeds.

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

        # Pre-walk the zip once so we know the totals up-front; it's the
        # only way to give the FE an accurate "X of Y" rather than a
        # rolling counter.
        members = [
            info for info in zf.infolist()
            if info.filename and not info.filename.endswith("/")
        ]
        total_files = len(members)
        total_bytes = sum(int(i.file_size) for i in members)
        if job_id is not None:
            try:
                db.update_resources_upload_job(
                    job_id,
                    total_files=total_files,
                    total_bytes=total_bytes,
                    phase=f"Uploading {total_files} files to storage",
                )
            except Exception:
                logger.exception("resources: failed to seed job totals (%s)", job_id)

        # ZipFile is NOT thread-safe for concurrent reads, so each worker
        # opens its own ZipFile against the same on-disk path. We pass the
        # filename string + ZipInfo + key + content_type and let the worker
        # pull the bytes itself.
        def _key_and_ct(info: zipfile.ZipInfo) -> tuple[str, str]:
            name = info.filename
            if name == _MANIFEST_NAME:
                return r2_storage.resources_manifest_key(seed, version, staging=True), "application/json"
            if name == _DEPOSITS_NAME:
                return r2_storage.resources_deposits_key(seed, version, staging=True), "application/octet-stream"
            if name.startswith(_TILES_PREFIX):
                return prefix + name, "image/png"
            raise HTTPException(
                status_code=400, detail=f"Unexpected bundle entry: {name}"
            )

        # Validate member classification up-front (so a bad name fails
        # before we kick off the thread pool).
        plan: list[tuple[zipfile.ZipInfo, str, str]] = []
        for info in members:
            key, ct = _key_and_ct(info)
            plan.append((info, key, ct))

        # Progress accumulators are owned by this thread; workers report
        # back via futures.
        processed = 0
        uploaded_bytes = 0
        last_flush_at = time.monotonic()
        last_flush_files = 0

        def _do_upload(item: tuple[zipfile.ZipInfo, str, str]) -> int:
            info, key, content_type = item
            # Each worker re-opens the zip read-only; this is cheap because
            # ZipFile keeps a tiny in-memory directory and seeks on demand.
            with zipfile.ZipFile(zip_path, "r") as worker_zf:
                with worker_zf.open(info, "r") as src:
                    data = src.read()
            # ``upload_bytes`` PUTs in a single round-trip — fine for
            # tiles and the small manifest. ``deposits.sqlite`` may be
            # tens of MB; boto3 transparently switches to multipart only
            # via ``upload_file`` / ``upload_fileobj``, so for the SQLite
            # we go through the path-based variant.
            if info.file_size > 8 * 1024 * 1024:
                with tempfile.NamedTemporaryFile(delete=False) as tmp:
                    tmp_path = tmp.name
                    tmp.write(data)
                try:
                    r2_storage.upload_file(tmp_path, key, content_type=content_type)
                finally:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
            else:
                r2_storage.upload_bytes(key, data, content_type=content_type)
            return int(info.file_size)

        with ThreadPoolExecutor(
            max_workers=_R2_UPLOAD_CONCURRENCY,
            thread_name_prefix="resources-upload",
        ) as pool:
            futures = [pool.submit(_do_upload, item) for item in plan]
            try:
                for fut in as_completed(futures):
                    size = fut.result()  # re-raises worker exceptions
                    processed += 1
                    uploaded_bytes += size
                    now = time.monotonic()
                    if job_id is not None and (
                        processed - last_flush_files >= _PROGRESS_FLUSH_EVERY_FILES
                        or now - last_flush_at >= _PROGRESS_FLUSH_EVERY_SECONDS
                        or processed == total_files
                    ):
                        try:
                            db.update_resources_upload_job(
                                job_id,
                                processed_files=processed,
                                uploaded_bytes=uploaded_bytes,
                            )
                        except Exception:
                            logger.exception(
                                "resources: progress flush failed (%s)", job_id
                            )
                        last_flush_at = now
                        last_flush_files = processed
            except Exception:
                # Cancel anything still queued so we don't keep PUTting
                # bytes after a worker has already failed.
                for f in futures:
                    f.cancel()
                raise

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
    """Stream a .zip resources bundle to disk, then hand off to a
    background worker that unpacks it into R2.

    The handler returns ``{"job_id": ...}`` as soon as the bytes are
    spooled. The FE then polls ``/admin/resources/jobs/{job_id}`` for
    progress (file count + bytes uploaded + phase). This keeps the
    HTTP request short — Render's request timeout would otherwise kill
    the connection mid-fanout for any non-trivial bundle.
    """
    _require_flag()
    if not settings.CANONICAL_WORLD_SEED or not settings.CANONICAL_WORLD_VS_VERSION:
        raise HTTPException(
            status_code=503,
            detail=(
                "CANONICAL_WORLD_SEED / CANONICAL_WORLD_VS_VERSION are not "
                "configured on the server. Set them before uploading a bundle."
            ),
        )

    # Reject a second concurrent upload before we even spool the bytes
    # — otherwise the browser would happily push 1 GiB onto disk only
    # for the worker to find another job already running.
    with _job_lock:
        if _active_job_id is not None:
            raise HTTPException(
                status_code=409,
                detail="Another resources bundle upload is already in progress.",
            )

    seed = settings.CANONICAL_WORLD_SEED
    version = settings.CANONICAL_WORLD_VS_VERSION
    cap = settings.RESOURCES_BUNDLE_MAX_BYTES

    fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix="vs-resources-")
    spooled = False
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

        # Hand-off to background worker. Once we've created the job and
        # spawned the thread, the worker owns ``tmp_path`` and is
        # responsible for unlinking it.
        job_id = uuid.uuid4().hex
        try:
            db.create_resources_upload_job(
                job_id, seed, version,
                phase="Spooled to disk, starting unpack",
                total_bytes=total,
            )
        except Exception:
            logger.exception("resources: failed to create job row %s", job_id)
            raise HTTPException(
                status_code=500, detail="Failed to record upload job"
            )

        with _job_lock:
            if _active_job_id is not None:
                # Lost the race against another concurrent upload that
                # cleared its own check above. Roll back the row.
                try:
                    db.update_resources_upload_job(
                        job_id,
                        status="failed",
                        error="Another upload took the slot first",
                        completed=True,
                    )
                except Exception:
                    pass
                raise HTTPException(
                    status_code=409,
                    detail="Another resources bundle upload is already in progress.",
                )
            globals()["_active_job_id"] = job_id

        thread = threading.Thread(
            target=_run_upload_job,
            args=(job_id, tmp_path, seed, version, total),
            name=f"resources-job-{job_id[:8]}",
            daemon=True,
        )
        thread.start()
        spooled = True
        return JSONResponse(
            status_code=202,
            content={"job_id": job_id, "size_bytes": total},
        )
    finally:
        # Only unlink here if we did NOT successfully hand the file off
        # to the worker. The worker unlinks it on completion / failure.
        if not spooled:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Async upload worker
# ---------------------------------------------------------------------------
#
# Single-flight: one bundle unpack at a time. The lock guards the
# ``_active_job_id`` global, which doubles as the "is something running?"
# flag for the upload endpoint.

_job_lock = threading.Lock()
_active_job_id: Optional[str] = None


def _run_upload_job(
    job_id: str, zip_path: str, seed: str, version: str, total_bytes: int,
) -> None:
    """Daemon thread body: validate, unpack into staging, swap pointer."""
    global _active_job_id
    try:
        try:
            db.update_resources_upload_job(
                job_id, phase="Validating manifest"
            )
        except Exception:
            logger.exception("resources: failed to set phase (%s)", job_id)

        try:
            manifest = _unpack_bundle(zip_path, seed, version, job_id=job_id)
        except HTTPException as exc:
            try:
                db.update_resources_upload_job(
                    job_id,
                    status="failed",
                    error=str(exc.detail),
                    completed=True,
                )
            except Exception:
                logger.exception("resources: failed to mark job failed (%s)", job_id)
            return
        except Exception as exc:
            logger.exception("resources: unpack raised for %s", job_id)
            try:
                db.update_resources_upload_job(
                    job_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                    completed=True,
                )
            except Exception:
                logger.exception("resources: failed to mark job failed (%s)", job_id)
            return

        try:
            db.update_resources_upload_job(
                job_id, status="swapping", phase="Promoting bundle to active"
            )
        except Exception:
            logger.exception("resources: failed to set swapping (%s)", job_id)

        try:
            _swap_pointer_and_cleanup(seed, version)
        except Exception as exc:
            logger.exception("resources: pointer swap failed for %s", job_id)
            try:
                db.update_resources_upload_job(
                    job_id,
                    status="failed",
                    error=f"Pointer swap failed: {type(exc).__name__}: {exc}",
                    completed=True,
                )
            except Exception:
                pass
            return

        try:
            db.update_resources_upload_job(
                job_id,
                status="complete",
                phase=f"Active: {seed} / {version}",
                completed=True,
            )
        except Exception:
            logger.exception("resources: final mark-complete failed (%s)", job_id)
        logger.info(
            "resources: upload job %s complete (seed=%s version=%s, %d bytes)",
            job_id, seed, version, total_bytes,
        )
    finally:
        try:
            os.unlink(zip_path)
        except OSError:
            pass
        with _job_lock:
            if _active_job_id == job_id:
                _active_job_id = None


@router.get("/jobs/active")
async def resources_active_job(_: str = Depends(require_admin)):
    """Return the most recent in-flight job, or the most recent finished
    job if nothing is running. Returns ``{"job": null}`` if no job has
    ever been created."""
    _require_flag()
    try:
        job = db.get_active_resources_upload_job()
    except Exception:
        logger.exception("resources: failed to read active job")
        raise HTTPException(status_code=500, detail="Failed to read job state")
    return {"job": _serialize_job(job) if job else None}


@router.get("/jobs/{job_id}")
async def resources_job(job_id: str, _: str = Depends(require_admin)):
    _require_flag()
    try:
        job = db.get_resources_upload_job(job_id)
    except Exception:
        logger.exception("resources: failed to read job %s", job_id)
        raise HTTPException(status_code=500, detail="Failed to read job state")
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _serialize_job(job)


def _serialize_job(job: dict) -> dict:
    """Coerce psycopg row → JSON-friendly dict the FE understands."""
    def _iso(value) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value)

    return {
        "id": job.get("id"),
        "seed": job.get("seed"),
        "vs_version": job.get("vs_version"),
        "status": job.get("status"),
        "phase": job.get("phase"),
        "total_files": int(job.get("total_files") or 0),
        "processed_files": int(job.get("processed_files") or 0),
        "total_bytes": int(job.get("total_bytes") or 0),
        "uploaded_bytes": int(job.get("uploaded_bytes") or 0),
        "error": job.get("error"),
        "created_at": _iso(job.get("created_at")),
        "updated_at": _iso(job.get("updated_at")),
        "completed_at": _iso(job.get("completed_at")),
    }


def kick_on_startup() -> None:
    """Called from ``main.py`` startup hook. Resurrects any in-flight
    job rows whose worker thread died with the previous process —
    they're unreachable now, so we just mark them failed so the FE
    doesn't keep polling them."""
    try:
        revived = db.reset_stuck_resources_upload_jobs()
        if revived:
            logger.warning(
                "resources: marked %d stale upload job(s) as failed at startup",
                revived,
            )
    except Exception:
        logger.exception("resources: startup reset failed")



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
