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

import logging
import threading
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


def _process_one(row: dict) -> None:
    """Run the full pipeline for one screenshot request and persist."""
    request_id = row["id"]
    key_a = row.get("screenshot_a_key")
    key_b = row.get("screenshot_b_key")
    if not key_a or not key_b:
        db.set_tl_screenshot_analysis_failed(
            request_id, "missing screenshot R2 keys"
        )
        return

    try:
        raw_a = r2_storage.download_bytes(key_a)
        raw_b = r2_storage.download_bytes(key_b)
    except Exception as exc:
        logger.exception("tl_screenshot worker: download failed for %s", request_id)
        db.set_tl_screenshot_analysis_failed(request_id, f"download: {exc}")
        return

    try:
        clean_a = pipeline.strip_exif_keep_timestamps(raw_a)
        clean_b = pipeline.strip_exif_keep_timestamps(raw_b)
    except Exception as exc:
        logger.exception("tl_screenshot worker: EXIF strip failed for %s", request_id)
        db.set_tl_screenshot_analysis_failed(request_id, f"exif: {exc}")
        return

    # Re-upload the cleaned PNGs so on-disk copies have no metadata. We also
    # store the EXIF-extracted timestamps separately on the request row.
    try:
        r2_storage.upload_bytes(key_a, clean_a.clean_png_bytes, content_type="image/png")
        r2_storage.upload_bytes(key_b, clean_b.clean_png_bytes, content_type="image/png")
    except Exception:
        # Non-fatal — the originals still work for review.
        logger.exception("tl_screenshot worker: re-upload of cleaned PNG failed for %s", request_id)

    img_a = Image.open(io.BytesIO(clean_a.clean_png_bytes))
    img_b = Image.open(io.BytesIO(clean_b.clean_png_bytes))

    # Minimap detection.
    bbox_a = pipeline.detect_minimap_bbox(img_a)
    bbox_b = pipeline.detect_minimap_bbox(img_b)
    minimap_a_img = pipeline.crop_minimap(img_a, bbox_a) if bbox_a else None
    minimap_b_img = pipeline.crop_minimap(img_b, bbox_b) if bbox_b else None

    # Cache the minimap crop in R2 so the admin UI can display it side-by-side.
    crop_a_key = r2_storage.tl_screenshot_minimap_crop_key(request_id, "a")
    crop_b_key = r2_storage.tl_screenshot_minimap_crop_key(request_id, "b")
    if minimap_a_img is not None:
        try:
            r2_storage.upload_bytes(
                crop_a_key, pipeline.pil_to_png_bytes(minimap_a_img), content_type="image/png"
            )
        except Exception:
            logger.exception("tl_screenshot worker: minimap crop A upload failed for %s", request_id)
            crop_a_key = None
    else:
        crop_a_key = None
    if minimap_b_img is not None:
        try:
            r2_storage.upload_bytes(
                crop_b_key, pipeline.pil_to_png_bytes(minimap_b_img), content_type="image/png"
            )
        except Exception:
            logger.exception("tl_screenshot worker: minimap crop B upload failed for %s", request_id)
            crop_b_key = None
    else:
        crop_b_key = None

    # OCR per slot.
    ocr_a = pipeline.ocr_coordinates(img_a)
    ocr_b = pipeline.ocr_coordinates(img_b)

    # Initial coords mirror OCR (admin can edit later).
    coords_a = {"x": ocr_a.x, "y": ocr_a.y, "z": ocr_a.z}
    coords_b = {"x": ocr_b.x, "y": ocr_b.y, "z": ocr_b.z}

    # Minimap match — only meaningful if we have coords AND a detected minimap.
    if minimap_a_img is not None and ocr_a.x is not None and ocr_a.z is not None:
        match_a = pipeline.compare_minimap_to_level5(
            minimap_a_img, x_center=int(ocr_a.x), z_center=int(ocr_a.z)
        )
    else:
        match_a = pipeline.MinimapMatchResult(
            score=0.0,
            method="no_minimap" if minimap_a_img is None else "no_coords",
            chunks_used=0, scale=None, sampled_window=None,
        )
    if minimap_b_img is not None and ocr_b.x is not None and ocr_b.z is not None:
        match_b = pipeline.compare_minimap_to_level5(
            minimap_b_img, x_center=int(ocr_b.x), z_center=int(ocr_b.z)
        )
    else:
        match_b = pipeline.MinimapMatchResult(
            score=0.0,
            method="no_minimap" if minimap_b_img is None else "no_coords",
            chunks_used=0, scale=None, sampled_window=None,
        )

    # Persist the server-map window each match used so the admin can
    # eyeball it next to the user's minimap crop in the review dialog.
    # Failures are non-fatal — the rest of the analysis still works.
    for slot, match in (("a", match_a), ("b", match_b)):
        if match.sampled_image is None:
            continue
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

    warnings = pipeline.build_validation_warnings(
        ocr_a=ocr_a, ocr_b=ocr_b,
        coords_a=coords_a, coords_b=coords_b,
        minimap_a=match_a, minimap_b=match_b,
        taken_at_a=clean_a.taken_at, taken_at_b=clean_b.taken_at,
    )
    if bbox_a is None:
        warnings.append({
            "code": "minimap_not_detected",
            "severity": "warning",
            "message": "Screenshot A: could not locate the minimap frame in the top-right.",
        })
    if bbox_b is None:
        warnings.append({
            "code": "minimap_not_detected",
            "severity": "warning",
            "message": "Screenshot B: could not locate the minimap frame in the top-right.",
        })

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
        minimap_crop_a_key=crop_a_key,
        minimap_crop_b_key=crop_b_key,
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
