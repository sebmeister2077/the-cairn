"""Async worker that runs the screenshot analysis pipeline.

Mirrors :mod:`backend.app.tasks.match_score`:

* a single in-process worker thread,
* claims rows from ``translocator_screenshot_requests`` where
  ``status='pending' AND analysis_status='queued'``,
* writes ``ocr_*``, ``coords_*``, ``minimap_match``, ``validation_warnings``
  back to the row.

The worker never blocks the contribute endpoint — even if it fails, the
admin can still view the raw screenshots and type coords manually.
"""

from __future__ import annotations

import gc
import logging
import threading
import time
from typing import Optional

from PIL import Image
import io

from ..core import database as db
from ..core import r2_storage
from ..core import screenshot_pipeline as pipeline


logger = logging.getLogger("uvicorn.error")

_job_lock = threading.Lock()
_active_thread: Optional[threading.Thread] = None


def is_job_running() -> bool:
    return _active_thread is not None and _active_thread.is_alive()


def _load_existing_tl_pairs_world_z() -> list:
    """Pull the live translocators.geojson and return ``[(x1, z1, x2, z2)]``
    in WORLD-Z space (i.e. +Z = north, matching OCR coords). The geojson
    stores +Z = south so we negate on the way out, mirroring how
    contribute_tls.py negates on the way in.

    Returns ``[]`` on any error so duplicate-pair detection degrades to a
    no-op instead of failing the analysis.
    """
    # Late import to avoid circular import (routes -> tasks at app startup).
    try:
        from ..routes import contribute_tls as ct  # type: ignore
    except Exception:
        logger.exception("tl_screenshot worker: contribute_tls import failed")
        return []
    try:
        data = ct._load_translocators_file()  # noqa: SLF001 — internal helper
    except Exception:
        logger.exception("tl_screenshot worker: live translocators load failed")
        return []
    try:
        geo_pairs = ct._existing_segments(data)  # noqa: SLF001
    except Exception:
        logger.exception("tl_screenshot worker: existing-segments parse failed")
        return []
    # Convert geojson Z (+south) -> world Z (+north).
    return [(x1, -z1, x2, -z2) for (x1, z1, x2, z2) in geo_pairs]


def _build_duplicate_warnings(
    request_id: str, coords_a: dict, coords_b: dict
) -> list:
    """Wrap pipeline.build_duplicate_pair_warnings with the IO needed to
    fetch live TLs + other pending requests. Errors fall back to ``[]``."""
    existing = _load_existing_tl_pairs_world_z()
    try:
        rows = db.list_pending_tl_screenshot_coords_excluding(request_id)
    except Exception:
        logger.exception(
            "tl_screenshot worker: list other pending coords failed for %s",
            request_id,
        )
        rows = []
    other_pending: list = []
    for r in rows:
        ca = r.get("coords_a") or {}
        cb = r.get("coords_b") or {}
        try:
            xa = ca.get("x"); za = ca.get("z")
            xb = cb.get("x"); zb = cb.get("z")
            if None in (xa, za, xb, zb):
                continue
            other_pending.append({
                "coords": (int(xa), int(za), int(xb), int(zb)),
                "submitter_display_name": r.get("submitter_display_name"),
                "submitter_api_key_id": r.get("submitter_api_key_id"),
                "id": r.get("id"),
            })
        except (TypeError, ValueError):
            continue
    return pipeline.build_duplicate_pair_warnings(
        coords_a=coords_a,
        coords_b=coords_b,
        existing_pairs=existing,
        other_pending=other_pending,
    )


def _process_slot(request_id: str, slot: str, key: str) -> dict:
    """Run the full per-slot pipeline (download, EXIF strip, re-upload,
    minimap detect/crop/upload, OCR, minimap match, server-crop upload)
    for one screenshot and return everything the caller needs to build
    warnings + persist the row.

    Memory discipline: every large intermediate (raw bytes, cleaned
    bytes, full-resolution PIL/numpy copies, the sampled server-map
    crop) is released as soon as it is no longer needed and a final
    ``gc.collect()`` is fired before returning. The peak working set
    for the slot is therefore one decoded screenshot + one ORB pass,
    not "both screenshots simultaneously" like the original pipeline.
    """
    # 1. Download + EXIF strip. Failures here propagate up; the caller
    # turns them into ``analysis_status='failed'`` rows.
    t_slot = time.monotonic()
    logger.info(
        "tl_screenshot worker: %s slot %s starting (key=%s)",
        request_id, slot, key,
    )
    t0 = time.monotonic()
    raw = r2_storage.download_bytes(key)
    logger.info(
        "tl_screenshot worker: %s slot %s downloaded %d bytes in %.2fs",
        request_id, slot, len(raw), time.monotonic() - t0,
    )
    try:
        clean = pipeline.strip_exif_keep_timestamps(raw)
    finally:
        del raw
    taken_at = clean.taken_at

    # Re-upload the cleaned PNG (no metadata). Non-fatal — originals
    # still work for review.
    try:
        r2_storage.upload_bytes(key, clean.clean_png_bytes, content_type="image/png")
    except Exception:
        logger.exception(
            "tl_screenshot worker: re-upload of cleaned PNG failed for %s slot %s",
            request_id, slot,
        )

    # 2. Decode once, derive minimap + OCR off the same PIL image, then
    # drop both the bytes and the image as soon as we no longer need them.
    img = Image.open(io.BytesIO(clean.clean_png_bytes))
    logger.info(
        "tl_screenshot worker: %s slot %s decoded image %dx%d mode=%s",
        request_id, slot, img.width, img.height, img.mode,
    )
    try:
        t1 = time.monotonic()
        bbox = pipeline.detect_minimap_bbox(img)
        logger.info(
            "tl_screenshot worker: %s slot %s minimap bbox=%s (%.2fs)",
            request_id, slot, bbox, time.monotonic() - t1,
        )
        minimap_img = pipeline.crop_minimap(img, bbox) if bbox else None

        crop_key: Optional[str] = r2_storage.tl_screenshot_minimap_crop_key(
            request_id, slot
        )
        if minimap_img is not None:
            try:
                r2_storage.upload_bytes(
                    crop_key,
                    pipeline.pil_to_png_bytes(minimap_img),
                    content_type="image/png",
                )
            except Exception:
                logger.exception(
                    "tl_screenshot worker: minimap crop %s upload failed for %s",
                    slot, request_id,
                )
                crop_key = None
        else:
            crop_key = None

        ocr = pipeline.ocr_coordinates(img)
        logger.info(
            "tl_screenshot worker: %s slot %s OCR done x=%s y=%s z=%s conf=%.3f",
            request_id, slot, ocr.x, ocr.y, ocr.z, ocr.confidence,
        )
    finally:
        # Free the full-res screenshot before the (memory-heavy) ORB
        # match runs. ``clean`` still holds the cleaned PNG bytes —
        # release those too; the match only needs the minimap crop.
        try:
            img.close()
        except Exception:
            pass
        del img
        del clean

    coords = {"x": ocr.x, "y": ocr.y, "z": ocr.z}

    # 3. Minimap-vs-server match. Skip when we lack the inputs.
    if minimap_img is not None and ocr.x is not None and ocr.z is not None:
        t2 = time.monotonic()
        match = pipeline.compare_minimap_to_level5(
            minimap_img, x_center=int(ocr.x), z_center=int(ocr.z)
        )
        logger.info(
            "tl_screenshot worker: %s slot %s minimap match method=%s score=%.3f "
            "chunks_used=%d (%.2fs)",
            request_id, slot, match.method, match.score, match.chunks_used,
            time.monotonic() - t2,
        )
    else:
        match = pipeline.MinimapMatchResult(
            score=0.0,
            method="no_minimap" if minimap_img is None else "no_coords",
            chunks_used=0, scale=None, sampled_window=None,
        )
        logger.info(
            "tl_screenshot worker: %s slot %s skipping minimap match (method=%s)",
            request_id, slot, match.method,
        )

    # Free the minimap PIL crop now that ORB has consumed it.
    try:
        if minimap_img is not None:
            minimap_img.close()
    except Exception:
        pass
    del minimap_img

    # 4. Persist the server-map crop the match used so the admin UI
    # can show it side-by-side with the user's minimap. Then drop the
    # numpy buffer immediately — it is the largest single allocation
    # left over from the slot and would otherwise live until the row
    # is persisted.
    if match.sampled_image is not None:
        try:
            r2_storage.upload_bytes(
                r2_storage.tl_screenshot_server_crop_key(request_id, slot),
                pipeline.numpy_to_png_bytes(match.sampled_image),
                content_type="image/png",
            )
        except Exception:
            logger.exception(
                "tl_screenshot worker: server-crop upload failed for %s slot %s",
                request_id, slot,
            )
        match.sampled_image = None

    # Encourage CPython to release pooled numpy / OpenCV buffers before
    # the caller starts on the other slot.
    gc.collect()

    logger.info(
        "tl_screenshot worker: %s slot %s complete in %.2fs",
        request_id, slot, time.monotonic() - t_slot,
    )

    return {
        "ocr": ocr,
        "coords": coords,
        "match": match,
        "bbox": bbox,
        "taken_at": taken_at,
        "crop_key": crop_key,
    }


def _process_one(row: dict) -> None:
    """Run the full pipeline for one screenshot request and persist.

    Slots are processed strictly sequentially so the worker only ever
    holds one decoded screenshot in memory at a time — important on the
    512 MB Render plan, where keeping both 4K screenshots resident
    alongside the OCR + ORB working set is enough to OOM the process.
    """
    request_id = row["id"]
    key_a = row.get("screenshot_a_key")
    key_b = row.get("screenshot_b_key")
    logger.info(
        "tl_screenshot worker: starting analysis for %s (key_a=%s key_b=%s)",
        request_id, key_a, key_b,
    )
    t_total = time.monotonic()
    if not key_a or not key_b:
        db.set_tl_screenshot_analysis_failed(
            request_id, "missing screenshot R2 keys"
        )
        return

    try:
        result_a = _process_slot(request_id, "a", key_a)
    except Exception as exc:
        logger.exception(
            "tl_screenshot worker: slot A pipeline failed for %s", request_id
        )
        db.set_tl_screenshot_analysis_failed(request_id, f"slot_a: {exc}")
        return

    # Make doubly sure slot A's working set is gone before slot B starts.
    gc.collect()

    try:
        result_b = _process_slot(request_id, "b", key_b)
    except Exception as exc:
        logger.exception(
            "tl_screenshot worker: slot B pipeline failed for %s", request_id
        )
        db.set_tl_screenshot_analysis_failed(request_id, f"slot_b: {exc}")
        return

    ocr_a = result_a["ocr"]; ocr_b = result_b["ocr"]
    coords_a = result_a["coords"]; coords_b = result_b["coords"]
    match_a = result_a["match"]; match_b = result_b["match"]

    warnings = pipeline.build_validation_warnings(
        ocr_a=ocr_a, ocr_b=ocr_b,
        coords_a=coords_a, coords_b=coords_b,
        minimap_a=match_a, minimap_b=match_b,
        taken_at_a=result_a["taken_at"], taken_at_b=result_b["taken_at"],
    )
    if result_a["bbox"] is None:
        warnings.append({
            "code": "minimap_not_detected",
            "severity": "warning",
            "message": "Screenshot A: could not locate the minimap frame in the top-right.",
        })
    if result_b["bbox"] is None:
        warnings.append({
            "code": "minimap_not_detected",
            "severity": "warning",
            "message": "Screenshot B: could not locate the minimap frame in the top-right.",
        })

    # Duplicate-pair warnings: this TL is already on the map, OR another
    # user has a pending screenshot request for the same pair. Best-effort
    # — failures here must not abort the rest of the analysis.
    try:
        warnings.extend(
            _build_duplicate_warnings(request_id, coords_a, coords_b)
        )
    except Exception:
        logger.exception(
            "tl_screenshot worker: duplicate-pair warning generation failed for %s",
            request_id,
        )

    minimap_match_payload = {
        "a": match_a.to_dict(),
        "b": match_b.to_dict(),
    }

    db.set_tl_screenshot_analysis_result(
        request_id,
        ocr_a=ocr_a.to_dict(),
        ocr_b=ocr_b.to_dict(),
        coords_a=coords_a,
        coords_b=coords_b,
        minimap_match=minimap_match_payload,
        validation_warnings=warnings,
        minimap_crop_a_key=result_a["crop_key"],
        minimap_crop_b_key=result_b["crop_key"],
    )
    logger.info(
        "tl_screenshot worker: %s analysis persisted in %.2fs total "
        "(coords_a=%s coords_b=%s warnings=%d match_a=%s/%.2f match_b=%s/%.2f)",
        request_id, time.monotonic() - t_total,
        coords_a, coords_b, len(warnings),
        match_a.method, match_a.score, match_b.method, match_b.score,
    )


def _worker_loop() -> None:
    global _active_thread
    try:
        while True:
            try:
                row = db.claim_pending_tl_screenshot_analysis()
            except Exception:
                logger.exception("tl_screenshot worker: claim failed")
                row = None

            if not row:
                with _job_lock:
                    try:
                        row = db.claim_pending_tl_screenshot_analysis()
                    except Exception:
                        row = None
                    if not row:
                        _active_thread = None
                        return

            try:
                _process_one(row)
            except Exception as exc:
                logger.exception(
                    "tl_screenshot worker: unhandled error on %s", row.get("id")
                )
                try:
                    db.set_tl_screenshot_analysis_failed(
                        row["id"], f"{type(exc).__name__}: {exc}"
                    )
                except Exception:
                    logger.exception(
                        "tl_screenshot worker: also failed to persist failure"
                    )
    finally:
        with _job_lock:
            if _active_thread is threading.current_thread():
                _active_thread = None


def start_job() -> bool:
    """Ensure the analysis worker is running. Returns True if a new
    thread was spawned, False if one was already alive."""
    global _active_thread
    with _job_lock:
        if _active_thread is not None and _active_thread.is_alive():
            return False
        t = threading.Thread(
            target=_worker_loop,
            name="tl-screenshot-analysis",
            daemon=True,
        )
        _active_thread = t
        t.start()
        return True


def kick_on_startup() -> None:
    """Recover from a previous process that died mid-analysis.

    Any row stuck in ``analysis_status='running'`` is by definition
    orphaned (the worker thread lives inside the server process), so we
    requeue it and spawn the worker so it gets reprocessed without an
    admin having to click ``Retry analysis`` manually. Safe no-op when
    nothing is queued.
    """
    try:
        revived = db.reset_stuck_tl_screenshot_analysis()
    except Exception:
        logger.exception("tl_screenshot worker: reset_stuck on startup failed")
        revived = 0
    if revived:
        logger.info(
            "tl_screenshot worker: revived %d stuck 'running' analysis row(s)",
            revived,
        )
    try:
        start_job()
    except Exception:
        logger.exception("tl_screenshot worker: startup kick start_job failed")
