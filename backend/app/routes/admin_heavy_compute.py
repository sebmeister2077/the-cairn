"""Admin: run all heavy-compute jobs sequentially on demand.

When ``heavy_compute_enabled`` is OFF the small production server stops
spawning validation / match-score / preview workers from user-driven
endpoints (see ``tasks/validate_uploads.py``, ``tasks/match_score.py``,
``routes/contribute_r2.py``). Pending rows then accumulate until an
admin presses the **Run heavy compute now** button on the Manage \u2192
Feature Flags page, which calls ``POST /api/admin/heavy-compute/run-now``
and drains everything in one sequential pass:

  1. revive any zombie validation rows + spawn the validate_uploads worker
     with ``force=True`` (bypasses the kill switch);
  2. spawn the match_score worker with ``force=True`` (only effective when
     the ``match_score`` product flag is also ON);
  3. for each currently-pending contribution that has no cached preview
     PNG in R2, render and upload it.

Step 3 happens on a background thread so the request returns immediately;
the dashboard polls ``GET /api/admin/heavy-compute/status`` for progress.

Admin-gated; safe to call repeatedly (idempotent).
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import List, Optional

from fastapi import APIRouter, Depends

from ..auth import require_admin
from ..core import database as db


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/heavy-compute", tags=["admin-heavy-compute"])


@dataclass
class _RunState:
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    started_by: Optional[str] = None

    # Step 1: validation worker.
    validations_revived: int = 0
    validation_worker_started: bool = False

    # Step 2: match-score worker.
    match_score_worker_started: bool = False
    match_score_skipped_reason: Optional[str] = None  # e.g. "match_score flag is OFF"

    # Step 3: preview pre-render.
    previews_total: int = 0
    previews_rendered: int = 0
    previews_already_cached: int = 0
    previews_failed: int = 0
    previews_failures: List[str] = field(default_factory=list)
    current_preview_id: Optional[str] = None

    error: Optional[str] = None


_state_lock = threading.Lock()
_state: _RunState = _RunState()
_thread: Optional[threading.Thread] = None


def _is_running() -> bool:
    return _thread is not None and _thread.is_alive()


def _state_dict() -> dict:
    with _state_lock:
        return {
            "running": _is_running(),
            "started_at": _state.started_at,
            "finished_at": _state.finished_at,
            "started_by": (
                _state.started_by[:8] + "\u2026" if _state.started_by else None
            ),
            "validations_revived": _state.validations_revived,
            "validation_worker_started": _state.validation_worker_started,
            "match_score_worker_started": _state.match_score_worker_started,
            "match_score_skipped_reason": _state.match_score_skipped_reason,
            "previews_total": _state.previews_total,
            "previews_rendered": _state.previews_rendered,
            "previews_already_cached": _state.previews_already_cached,
            "previews_failed": _state.previews_failed,
            "previews_failures": list(_state.previews_failures),
            "current_preview_id": _state.current_preview_id,
            "error": _state.error,
        }


def _drain_loop() -> None:
    """Sequentially execute all heavy-compute steps. Updates ``_state``."""
    from ..core import feature_flags as ff
    from ..core import r2_storage
    from ..routes.contribute_r2 import (
        _download_to_temp,
        _render_preview,
        get_combined_db_cached,
    )
    from ..tasks import match_score as match_score_task
    from ..tasks import validate_uploads as validate_task

    try:
        # --- Step 1: validations ---------------------------------------
        try:
            revived = db.reset_stuck_validations()
        except Exception:
            logger.exception("heavy-compute: reset_stuck_validations failed")
            revived = 0
        with _state_lock:
            _state.validations_revived = revived
        try:
            spawned = validate_task.start_job(force=True)
        except Exception:
            logger.exception("heavy-compute: validate_uploads start failed")
            spawned = False
        with _state_lock:
            _state.validation_worker_started = spawned

        # --- Step 2: match-score ---------------------------------------
        if not ff.is_feature_enabled("match_score"):
            with _state_lock:
                _state.match_score_skipped_reason = "match_score flag is OFF"
        else:
            try:
                spawned = match_score_task.start_job(force=True)
            except Exception:
                logger.exception("heavy-compute: match_score start failed")
                spawned = False
            with _state_lock:
                _state.match_score_worker_started = spawned

        # --- Step 3: pre-render previews -------------------------------
        try:
            pending_rows = db.list_pending_contributions() or []
        except Exception:
            logger.exception("heavy-compute: list_pending_contributions failed")
            pending_rows = []

        with _state_lock:
            _state.previews_total = len(pending_rows)

        for row in pending_rows:
            cid = row.get("id")
            if not cid:
                continue
            with _state_lock:
                _state.current_preview_id = cid

            preview_key = r2_storage.pending_preview_key(cid)
            try:
                if r2_storage.object_exists(preview_key):
                    with _state_lock:
                        _state.previews_already_cached += 1
                    continue
            except Exception:
                logger.exception(
                    "heavy-compute: object_exists failed for preview of %s", cid
                )
                # Treat as not cached and try to render.

            pending_key = r2_storage.pending_db_key(cid)
            try:
                if not r2_storage.object_exists(pending_key):
                    # Validation may not have run yet (or row got cleaned up).
                    with _state_lock:
                        _state.previews_failed += 1
                        _state.previews_failures.append(
                            f"{cid}: pending DB missing"
                        )
                    continue
            except Exception as exc:
                with _state_lock:
                    _state.previews_failed += 1
                    _state.previews_failures.append(f"{cid}: {exc}")
                continue

            tmp_pending = None
            try:
                combined_tmp = get_combined_db_cached()
                tmp_pending = _download_to_temp(pending_key)
                png_bytes = _render_preview(combined_tmp, tmp_pending)
                r2_storage.upload_bytes(
                    preview_key, png_bytes, content_type="image/png"
                )
                with _state_lock:
                    _state.previews_rendered += 1
            except Exception as exc:
                logger.exception(
                    "heavy-compute: preview render failed for %s", cid
                )
                with _state_lock:
                    _state.previews_failed += 1
                    _state.previews_failures.append(
                        f"{cid}: {type(exc).__name__}: {exc}"
                    )
            finally:
                if tmp_pending:
                    import os as _os
                    try:
                        _os.unlink(tmp_pending)
                    except OSError:
                        pass

        with _state_lock:
            _state.current_preview_id = None
    except Exception as exc:
        logger.exception("heavy-compute: drain loop crashed")
        with _state_lock:
            _state.error = f"{type(exc).__name__}: {exc}"
    finally:
        with _state_lock:
            _state.finished_at = time.time()


@router.post("/run-now")
async def run_heavy_compute_now(api_key: str = Depends(require_admin)) -> dict:
    """Spawn the sequential heavy-compute drain.

    Returns immediately with the new state snapshot; clients poll
    ``GET /admin/heavy-compute/status`` for progress. If a drain is
    already running this is a no-op (returns the in-flight state).
    """
    global _thread, _state
    with _state_lock:
        if _is_running():
            return {
                "started": False,
                "reason": "already_running",
                "status": _state_dict(),
            }
        _state = _RunState(started_at=time.time(), started_by=api_key)

    t = threading.Thread(
        target=_drain_loop,
        name="admin-heavy-compute-drain",
        daemon=True,
    )
    _thread = t
    t.start()
    return {"started": True, "status": _state_dict()}


@router.get("/status")
async def get_heavy_compute_status(
    api_key: str = Depends(require_admin),
) -> dict:
    return _state_dict()
