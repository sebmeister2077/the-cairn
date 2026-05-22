"""Async worker that fully validates freshly-uploaded contribution .db files.

Why a worker instead of doing this inline in ``/contribute/complete``?

The pending DB lives in R2 and may legitimately be 4–5 GB for full-server
uploads. The Render Starter tier the backend runs on has 0.5 CPU + 512 MB
RAM and a hard request timeout of a couple of minutes. Pulling several GB
across the network and running ``SELECT COUNT(*)`` on it inside the request
handler routinely exceeded that timeout, leaving the browser with a
"Failed to fetch" error and no Supabase row, even though the bytes were
safely in R2.

The new flow:

  1. ``/contribute/complete`` does a HEAD + a 100-byte range read to confirm
     the file is a real SQLite database, then inserts the row with
     ``validation_status='pending'`` and ``tile_count=0`` and returns
     immediately.
  2. This worker then drains pending rows one at a time:
       * downloads the pending DB to a temp file (boto3 streams chunks, so
         RAM stays bounded even for multi-GB files);
       * opens it with ``sqlite3``, confirms the ``mappiece`` table exists
         and is non-empty, computes total tile count, and (if the
         contribution carries a Phase-2 region) the in-region tile count;
       * on success: flips ``validation_status`` to ``'valid'`` and writes
         the real ``tile_count``;
       * on failure (malformed DB, no ``mappiece`` table, empty, region
         contains zero tiles, or attempts cap exhausted): deletes both the
         contribution row and the R2 object so the user is rolled back to
         the same state as if they had never uploaded.

The architecture mirrors :mod:`backend.app.tasks.match_score` — a single
in-process daemon thread, ``FOR UPDATE SKIP LOCKED`` claim semantics so
multiple workers / processes can race safely on the same Postgres table,
and a ``kick_on_startup`` hook so a backend restart mid-validation doesn't
strand contributions in ``'pending'`` forever.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Optional

from ..core import database as db

logger = logging.getLogger("uvicorn.error")

_job_lock = threading.Lock()
_active_thread: Optional[threading.Thread] = None


def is_job_running() -> bool:
    return _active_thread is not None and _active_thread.is_alive()


def _process_one(job: dict) -> None:
    """Validate one claimed contribution. Local imports keep the module
    cheap to import at app startup."""
    from ..core import r2_storage
    from ..routes.contribute_r2 import (
        _validate_upload,
        _count_pending_tiles,
        _download_to_temp,
    )

    cid = job["id"]
    attempts = int(job.get("validation_attempts") or 0)
    region: Optional[tuple] = None
    if job.get("update_region_min_x") is not None:
        region = (
            int(job["update_region_min_x"]),
            int(job["update_region_max_x"]),
            int(job["update_region_min_z"]),
            int(job["update_region_max_z"]),
        )

    pending_key = r2_storage.pending_db_key(cid)

    # If the contribution row was withdrawn / deleted between claim and now
    # there's nothing to do. Clear ``validation_status`` so the row can't
    # be re-claimed forever (the claim already bumped attempts; without
    # this, the row stays pending until the cap, then gets "revived" on
    # the next restart and the loop repeats).
    meta = db.get_contribution(cid)
    if not meta or meta.get("status") != "pending":
        logger.info("validate_uploads: skipping %s — no longer pending", cid)
        try:
            db.clear_validation_status(cid)
        except Exception:
            logger.exception("validate_uploads: clear-status failed for %s", cid)
        return
    if meta.get("validation_status") != "pending":
        # Already validated by another worker / a manual override.
        return

    if not r2_storage.object_exists(pending_key):
        logger.warning(
            "validate_uploads: pending object missing for %s — deleting row", cid,
        )
        try:
            db.delete_contribution(cid)
        except Exception:
            logger.exception("validate_uploads: row delete failed for %s", cid)
        return

    tmp_path: Optional[str] = None
    failure_reason: Optional[str] = None
    tile_count: int = 0
    validation_persisted = False
    try:
        tmp_path = _download_to_temp(pending_key)
        try:
            tile_count = _validate_upload(tmp_path)
        except ValueError as e:
            failure_reason = str(e)
        else:
            if region is not None:
                in_region, _total = _count_pending_tiles(tmp_path, region)
                if in_region == 0:
                    failure_reason = (
                        "The selected region contains zero tiles from the "
                        "upload."
                    )

            # Validation succeeded — flip status and pre-render the preview
            # while ``tmp_path`` is still alive. Doing both inside this
            # block (before the cleanup ``finally``) means the preview
            # renderer reuses the just-downloaded pending DB instead of
            # forcing the admin's first ``GET /contribute/preview`` to
            # re-download it (~30 s on a multi-GB DB) and re-render from
            # cold (~15\u201360 s wall). The Tier 3.2 sidecar cache on the
            # combined side keeps the render itself cheap.
            if failure_reason is None:
                try:
                    db.set_validation_valid(cid, tile_count)
                    validation_persisted = True
                except Exception:
                    logger.exception(
                        "validate_uploads: persisting 'valid' failed for %s", cid
                    )
                else:
                    _maybe_prerender_preview(cid, tmp_path)
    except Exception as exc:
        # Network / SQLite / temp-file errors — surface as a retryable
        # failure rather than poisoning the row.
        logger.exception("validate_uploads: %s raised during validation", cid)
        try:
            db.set_validation_error(cid, f"{type(exc).__name__}: {exc}")
        except Exception:
            logger.exception("validate_uploads: error-record failed for %s", cid)
        if attempts >= db.VALIDATION_MAX_ATTEMPTS:
            _drop_contribution(cid, pending_key, "validation kept failing")
        return
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if failure_reason is not None:
        # Deterministic failure (bad schema, empty file, empty region) — no
        # point retrying. Roll the contribution back entirely.
        _drop_contribution(cid, pending_key, failure_reason)
        return

    # ``set_validation_valid`` already ran inside the try-block (see above)
    # so the preview pre-render can use the still-live tmp file. The
    # ``validation_persisted`` flag is only False if the flip raised mid-
    # transaction \u2014 in which case another worker will pick this row up on
    # the next pass.
    if not validation_persisted:
        logger.warning(
            "validate_uploads: status flip did not persist for %s \u2014 will retry", cid
        )


def _maybe_prerender_preview_disabled() -> bool:
    """Env opt-out for tests and emergency disablement."""
    return os.environ.get("PREVIEW_PRERENDER_DISABLE", "") in (
        "1", "true", "yes", "on",
    )


def _maybe_prerender_preview(cid: str, pending_path: str) -> None:
    """Best-effort: render the preview PNG and upload it to the R2 cache
    slot so the admin's first ``GET /contribute/preview/{cid}`` is a hit.

    Reuses the still-on-disk ``pending_path`` left by the validation
    download \u2014 avoids one multi-GB R2 round-trip vs. the on-demand path.

    Any failure (including unexpected exceptions in the renderer or R2
    upload) is logged and swallowed. Validation success is never gated on
    a successful pre-render \u2014 the on-demand handler is the fallback.
    """
    if _maybe_prerender_preview_disabled():
        return
    try:
        from ..core import r2_storage
        from ..core.feature_flags import is_heavy_compute_allowed
        from ..routes.contribute_r2 import (
            _render_and_cache_preview_sync,
            get_combined_db_cached,
        )
    except Exception:
        logger.exception(
            "validate_uploads: preview pre-render import failed for %s "
            "(non-fatal)", cid,
        )
        return

    # Honour the same heavy-compute kill switch the on-demand handler does.
    try:
        if not is_heavy_compute_allowed():
            logger.info(
                "validate_uploads: skipping preview pre-render for %s \u2014 "
                "heavy_compute_enabled is OFF", cid,
            )
            return
    except Exception:
        logger.exception(
            "validate_uploads: heavy-compute check failed for %s "
            "(skipping pre-render)", cid,
        )
        return

    # If an admin already requested the preview (very narrow race), don't
    # waste work re-rendering. The on-demand handler's per-contribution
    # asyncio lock dedupes concurrent HTTP-side renders; this is the
    # cross-process counterpart for the post-validation path.
    preview_key = r2_storage.pending_preview_key(cid)
    try:
        if r2_storage.object_exists(preview_key):
            logger.info(
                "validate_uploads: preview for %s already cached \u2014 "
                "skipping pre-render", cid,
            )
            return
    except Exception:
        # If the existence check fails, fall through and try the render
        # anyway \u2014 a redundant re-upload is cheaper than skipping.
        logger.exception(
            "validate_uploads: preview-existence check failed for %s "
            "(continuing with render)", cid,
        )

    try:
        combined_path = get_combined_db_cached()
    except Exception:
        logger.exception(
            "validate_uploads: combined-DB cache fetch failed for %s "
            "(skipping pre-render)", cid,
        )
        return

    try:
        _render_and_cache_preview_sync(cid, pending_path, combined_path)
        logger.info("validate_uploads: pre-rendered preview for %s", cid)
    except ValueError as e:
        # Deterministic renderer failure (e.g. empty bounds). Not retryable;
        # admin's on-demand request will surface the same error.
        logger.warning(
            "validate_uploads: preview pre-render returned error for %s: %s",
            cid, e,
        )
    except Exception:
        logger.exception(
            "validate_uploads: preview pre-render failed for %s "
            "(non-fatal \u2014 on-demand path remains)", cid,
        )


def _drop_contribution(cid: str, pending_key: str, reason: str) -> None:
    """Delete both the Supabase row and the R2 object. Logs the reason."""
    from ..core import r2_storage

    logger.info("validate_uploads: rolling back %s — %s", cid, reason)
    try:
        r2_storage.delete_object(pending_key)
    except Exception:
        logger.exception("validate_uploads: R2 delete failed for %s", cid)
    try:
        db.delete_contribution(cid)
    except Exception:
        logger.exception("validate_uploads: row delete failed for %s", cid)


def _worker_loop() -> None:
    """Drain pending validation jobs until the queue is empty."""
    global _active_thread
    try:
        while True:
            try:
                job = db.claim_pending_validation_job()
            except Exception:
                logger.exception("validate_uploads: claim failed; exiting worker")
                job = None

            if not job:
                with _job_lock:
                    try:
                        job = db.claim_pending_validation_job()
                    except Exception:
                        logger.exception("validate_uploads: claim under lock failed")
                        job = None
                    if not job:
                        _active_thread = None
                        return

            cid = job["id"]
            logger.info(
                "validate_uploads: processing %s (attempt %s)",
                cid, job.get("validation_attempts"),
            )
            _process_one(job)
    finally:
        with _job_lock:
            if _active_thread is threading.current_thread():
                _active_thread = None


def start_job(cid: Optional[str] = None, *, force: bool = False) -> bool:
    """Ensure the worker thread is running.

    ``cid`` is just a hint — the worker always drains the full queue, so
    callers don't need to pass it. ``force=True`` bypasses the
    ``heavy_compute_enabled`` kill switch and is reserved for the admin
    "Run heavy compute now" bulk endpoint and the in-flight worker that
    re-spawns itself. Returns True if a new worker was spawned, False if
    one is already running or if the kill switch blocked the spawn."""
    global _active_thread
    # Heavy-compute kill switch. We deliberately gate *here* (not inside the
    # worker loop) so any worker that's currently mid-drain finishes the
    # queue — only new spawns are blocked.
    if not force:
        try:
            from ..core.feature_flags import is_heavy_compute_allowed
            if not is_heavy_compute_allowed():
                logger.info(
                    "validate_uploads: skipping spawn — heavy_compute_enabled is OFF"
                )
                return False
        except Exception:
            logger.exception("validate_uploads: feature-flag check failed")
    with _job_lock:
        if _active_thread is not None and _active_thread.is_alive():
            return False
        if cid is None:
            try:
                if not db.has_pending_validation_jobs():
                    return False
            except Exception:
                logger.exception("validate_uploads: pending check failed")
                return False

        t = threading.Thread(
            target=_worker_loop,
            name="validate-uploads-worker",
            daemon=True,
        )
        _active_thread = t
        t.start()
        return True


def kick_on_startup() -> None:
    """Re-enqueue any rows left ``validation_status='pending'`` from a
    previous process. Called from ``main.py``'s startup hook.

    Also revives "zombie" rows whose attempts counter is at the cap but
    that were never cleanly rolled back — these are uniformly the result of
    a worker process being SIGKILL-ed mid-validation (OOM, dyno restart),
    not a deterministic validation failure (deterministic failures delete
    the row before this state is reachable)."""
    if os.getenv("VALIDATE_UPLOADS_DISABLE_STARTUP_KICK") == "1":
        return
    try:
        revived = db.reset_stuck_validations()
        if revived:
            logger.warning(
                "validate_uploads: revived %d zombie row(s) left at attempts cap by "
                "a previously killed worker",
                revived,
            )
    except Exception:
        logger.exception("validate_uploads: reset_stuck_validations failed")
    try:
        start_job()
    except Exception:
        logger.exception("validate_uploads: startup kick failed")
