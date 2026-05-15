"""Image-processing pipeline for screenshot-based TL contributions.

Pure functions used by :mod:`backend.app.tasks.process_tl_screenshot_request`.
All heavy third-party imports (cv2, rapidocr) are deferred to function
bodies so the module can be imported cheaply at app startup even if the
optional deps aren't installed in dev.

Pipeline:
    raw png bytes
        -> strip_exif_keep_timestamps  (Pillow)
        -> detect_minimap_bbox         (numpy edge-detect, top-right region)
        -> ocr_coordinates             (RapidOCR over a HUD crop)
        -> compare_minimap_to_level5   (cv2.matchTemplate multi-scale)
"""

from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image, ExifTags

from . import r2_storage
from .mapdb import TILE_SIZE


logger = logging.getLogger("uvicorn.error")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Region of the screenshot to search for the minimap (top-right corner).
# The Vintage Story minimap is anchored to the top-right of the viewport
# and may sit flush against the top/right screen edges (no visible frame
# on those sides) — only the bottom and left edges are reliably present
# as a transition between the flat-shaded map and the 3D world behind.
# Fractions of (height, width). Anything outside this box is masked off
# before edge-detection.
MINIMAP_SEARCH_TOP_FRAC = 0.0
MINIMAP_SEARCH_BOTTOM_FRAC = 0.55
MINIMAP_SEARCH_LEFT_FRAC = 0.55
MINIMAP_SEARCH_RIGHT_FRAC = 1.0

# Minimum minimap side (px) we'll accept as a real frame. Smaller = noise.
MINIMAP_MIN_SIDE_PX = 80

# Sobel edge-strength multiplier over the column/row median that the
# detected left/bottom edge must clear to be accepted as the minimap
# boundary (vs. ambient terrain noise).
MINIMAP_EDGE_PROMINENCE = 2.5

# Half-window in BLOCKS sampled from the level-5 cache around the player
# coordinate when scoring the minimap. Generous so even a heavily-zoomed-out
# minimap (which can show ~300+ blocks across at the lowest UI scale) still
# fits inside the sampled area with slop for matching.
LEVEL5_HALF_WINDOW_BLOCKS = 256

# UI overlays drawn on top of the minimap (player dot, waypoint pins,
# prospecting dots) are vivid, high-saturation colours that don't exist
# in the server map crop. We detect them by HSV saturation and inpaint
# them out before matching so they neither add noise nor anchor a false
# correlation peak.
OVERLAY_SATURATION_MIN = 170     # 0–255; fairly aggressive cut-off
OVERLAY_VALUE_MIN = 90           # ignore dark/black UI text
OVERLAY_INPAINT_RADIUS = 4       # px; cv2.inpaint Telea radius

# ORB feature-matching parameters. ORB is scale- and rotation-invariant
# and copes well with the very different rendering of the in-game minimap
# (3D-shaded) vs the level-5 server cache (flat per-block colour).
#
# These are tuned for a HARD case: the minimap is often zoomed in so far
# that it covers <2% of the 512x512-block server crop. Two consequences:
#
#   * The pyramid must span a wide scale range. Default (8 levels, 1.2x)
#     only covers ~3.6x; a heavily-zoomed-in minimap can be 5-6x larger
#     px/block than the flat server cache. We use 12 levels at 1.15x to
#     cover ~5.4x.
#   * Lowe's ratio test gets unreliable when one image covers a tiny
#     fraction of the other: every query descriptor has thousands of
#     unrelated candidates, so the runner-up is almost always close to
#     the true match. We loosen the ratio and rely on RANSAC for the
#     real outlier rejection.
#   * Scoring as ``inliers / len(good)`` is noisy with small ``good``
#     counts. We instead score by absolute inlier count saturating at
#     ``ORB_INLIER_TARGET`` so "few but geometrically consistent" still
#     reports a meaningful non-zero score.
ORB_MAX_FEATURES = 4000          # generous for the bigger server crop
ORB_PYRAMID_LEVELS = 12
ORB_PYRAMID_SCALE = 1.15
ORB_EDGE_THRESHOLD = 8           # let features sit close to the border
ORB_LOWE_RATIO = 0.85            # permissive; RANSAC rejects the noise
ORB_MIN_GOOD_MATCHES = 4         # cv2.findHomography needs >= 4
ORB_RANSAC_REPROJ_PX = 8.0       # px; allow some shading distortion
ORB_INLIER_TARGET = 25           # inliers; >= this saturates score to 1.0


@dataclass
class StripResult:
    clean_png_bytes: bytes
    taken_at: Optional[datetime]


@dataclass
class OCRResult:
    x: Optional[int]
    y: Optional[int]
    z: Optional[int]
    raw_text: str
    confidence: float

    def to_dict(self) -> dict:
        return {
            "x": self.x,
            "y": self.y,
            "z": self.z,
            "raw_text": self.raw_text,
            "confidence": self.confidence,
        }


@dataclass
class MinimapMatchResult:
    score: float
    method: str
    chunks_used: int
    scale: Optional[float]
    sampled_window: Optional[dict]  # {x_min, x_max, z_min, z_max}
    # The stitched & cropped server-map window used as the match-template
    # search space. Kept off ``to_dict`` so it doesn't get persisted as
    # JSON; the worker uploads it to R2 separately for admin review.
    sampled_image: Optional[np.ndarray] = None

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "method": self.method,
            "chunks_used": self.chunks_used,
            "scale": self.scale,
            "sampled_window": self.sampled_window,
        }


# ---------------------------------------------------------------------------
# EXIF strip
# ---------------------------------------------------------------------------

_EXIF_DATETIME_TAGS = {"DateTimeOriginal", "DateTime", "DateTimeDigitized"}


def _parse_exif_datetime(raw: str) -> Optional[datetime]:
    """EXIF format is ``"YYYY:MM:DD HH:MM:SS"``. Return None on bad input."""
    if not raw or not isinstance(raw, str):
        return None
    try:
        dt = datetime.strptime(raw.strip(), "%Y:%m:%d %H:%M:%S")
        return dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def strip_exif_keep_timestamps(png_bytes: bytes) -> StripResult:
    """Re-encode the image as a clean PNG with no metadata except the
    extracted EXIF DateTimeOriginal/DateTime (returned alongside, not
    embedded).

    Raises :class:`ValueError` if the bytes are not a decodable image.
    """
    try:
        img = Image.open(io.BytesIO(png_bytes))
        img.load()
    except Exception as exc:
        raise ValueError(f"Not a decodable image: {exc}") from exc

    taken_at: Optional[datetime] = None
    try:
        exif = img.getexif()
        if exif:
            tag_lookup = {v: k for k, v in ExifTags.TAGS.items()}
            for tag_name in ("DateTimeOriginal", "DateTime", "DateTimeDigitized"):
                tag_id = tag_lookup.get(tag_name)
                if tag_id is None:
                    continue
                val = exif.get(tag_id)
                if val:
                    parsed = _parse_exif_datetime(str(val))
                    if parsed:
                        taken_at = parsed
                        break
    except Exception:
        # EXIF parsing is best-effort; never let it break the pipeline.
        logger.exception("screenshot_pipeline: EXIF parse failed")

    # Force RGB and re-encode without any metadata chunks.
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    out = io.BytesIO()
    save_kwargs = {"format": "PNG", "optimize": False}
    img.save(out, **save_kwargs)
    return StripResult(clean_png_bytes=out.getvalue(), taken_at=taken_at)


# ---------------------------------------------------------------------------
# Minimap detection (numpy-only, no OpenCV needed)
# ---------------------------------------------------------------------------

def detect_minimap_bbox(image: Image.Image) -> Optional[Tuple[int, int, int, int]]:  # noqa: C901
    """Locate the minimap in the top-right corner of the image.

    Returns ``(x, y, w, h)`` in image-pixel coords or ``None`` if no
    plausible minimap was found.

    Algorithm: the VS minimap is anchored to the top-right viewport
    corner with no consistent frame colour (sometimes a faint dark hair
    line, sometimes nothing). What *is* reliable is the strong
    luminance/colour discontinuity between the flat-shaded map and the
    3D world behind it on the **left** and **bottom** sides. We:

    1. Crop the top-right search region.
    2. Run a heavily-blurred Sobel filter so within-minimap terrain
       detail is suppressed but the long boundary edges survive.
    3. Pick the column with the strongest vertical edge (left side)
       and the row with the strongest horizontal edge (bottom side),
       both required to clear a noise floor.
    4. Assume the minimap extends from there to the top-right corner.
    """
    arr = np.asarray(image.convert("RGB"))
    h, w = arr.shape[:2]
    y0 = int(h * MINIMAP_SEARCH_TOP_FRAC)
    y1 = int(h * MINIMAP_SEARCH_BOTTOM_FRAC)
    x0 = int(w * MINIMAP_SEARCH_LEFT_FRAC)
    x1 = int(w * MINIMAP_SEARCH_RIGHT_FRAC)
    region = arr[y0:y1, x0:x1]
    rh, rw = region.shape[:2]
    if rh < MINIMAP_MIN_SIDE_PX or rw < MINIMAP_MIN_SIDE_PX:
        return None

    try:
        import cv2  # type: ignore
    except Exception:
        logger.warning(
            "opencv-python-headless not installed; minimap detection disabled"
        )
        return None

    gray = cv2.cvtColor(region, cv2.COLOR_RGB2GRAY)
    # Heavy blur kills interior terrain edges while preserving the
    # ~screen-spanning boundary.
    blurred = cv2.GaussianBlur(gray, (9, 9), 0)
    sx = np.abs(cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=5))
    sy = np.abs(cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=5))

    col_strength = sx.sum(axis=0).astype(np.float64)  # shape (rw,)
    row_strength = sy.sum(axis=1).astype(np.float64)  # shape (rh,)

    # Constrain the left edge to the inner 5%-90% of the search region
    # (avoids picking up the screen-edge gradient on either side).
    left_lo = max(2, int(rw * 0.05))
    left_hi = max(left_lo + 1, int(rw * 0.90))
    left_slice = col_strength[left_lo:left_hi]
    if left_slice.size == 0:
        return None
    left_col = left_lo + int(np.argmax(left_slice))

    # Bottom edge: search from 20% down (skips the always-noisy top-of-
    # screen area where translocator name banner overlaps).
    bot_lo = max(2, int(rh * 0.20))
    bot_hi = rh - 1
    if bot_hi <= bot_lo:
        return None
    bot_slice = row_strength[bot_lo:bot_hi]
    bottom_row = bot_lo + int(np.argmax(bot_slice))

    col_med = float(np.median(col_strength)) or 1.0
    row_med = float(np.median(row_strength)) or 1.0
    if (
        col_strength[left_col] < col_med * MINIMAP_EDGE_PROMINENCE
        or row_strength[bottom_row] < row_med * MINIMAP_EDGE_PROMINENCE
    ):
        logger.info(
            "screenshot_pipeline: minimap bbox rejected (weak edges) image=%dx%d region=%dx%d "
            "col_strength=%.1f vs %.1f*%g, row_strength=%.1f vs %.1f*%g",
            w, h, rw, rh,
            float(col_strength[left_col]), col_med, MINIMAP_EDGE_PROMINENCE,
            float(row_strength[bottom_row]), row_med, MINIMAP_EDGE_PROMINENCE,
        )
        return None

    side_w = rw - left_col
    side_h = bottom_row
    if side_w < MINIMAP_MIN_SIDE_PX or side_h < MINIMAP_MIN_SIDE_PX:
        logger.info(
            "screenshot_pipeline: minimap bbox rejected (too small) side=%dx%d min=%d region=%dx%d",
            side_w, side_h, MINIMAP_MIN_SIDE_PX, rw, rh,
        )
        return None
    aspect = side_w / max(1, side_h)
    if not (0.55 <= aspect <= 1.8):
        logger.info(
            "screenshot_pipeline: minimap bbox rejected (bad aspect) side=%dx%d aspect=%.2f",
            side_w, side_h, aspect,
        )
        return None

    logger.info(
        "screenshot_pipeline: minimap bbox detected at (%d,%d) size=%dx%d (region %dx%d, left_col=%d bot_row=%d)",
        x0 + left_col, y0, side_w, side_h, rw, rh, left_col, bottom_row,
    )
    return (x0 + left_col, y0, side_w, side_h)


def crop_minimap(image: Image.Image, bbox: Tuple[int, int, int, int]) -> Image.Image:
    """Return the minimap interior (inset by a couple of pixels to drop
    the frame itself)."""
    x, y, w, h = bbox
    inset = 3
    x0 = max(0, x + inset)
    y0 = max(0, y + inset)
    x1 = min(image.width, x + w - inset)
    y1 = min(image.height, y + h - inset)
    return image.crop((x0, y0, x1, y1))


# ---------------------------------------------------------------------------
# OCR — coordinate text
# ---------------------------------------------------------------------------

# Vintage Story HUD prints coordinates in many styles depending on user
# settings: "X=1234 Y=110 Z=-5678", "1234, 110, -5678", "Player: 1234 110 -5678",
# etc. The regex below handles the common ones.
_COORD_REGEX_LABELLED = re.compile(
    r"X[=:\s]+(-?\d{1,7})[\s,]+Y[=:\s]+(-?\d{1,5})[\s,]+Z[=:\s]+(-?\d{1,7})",
    re.IGNORECASE,
)
_COORD_REGEX_TRIPLE = re.compile(
    r"(?<![\d-])(-?\d{2,7})\s*[,\s]\s*(-?\d{1,5})\s*[,\s]\s*(-?\d{2,7})(?![\d])"
)


def _parse_coord_text(text: str) -> Tuple[Optional[int], Optional[int], Optional[int]]:
    """Return (x, y, z) parsed from OCR text. Any value missing → None."""
    m = _COORD_REGEX_LABELLED.search(text)
    if m:
        try:
            return int(m.group(1)), int(m.group(2)), int(m.group(3))
        except ValueError:
            pass
    m = _COORD_REGEX_TRIPLE.search(text)
    if m:
        try:
            return int(m.group(1)), int(m.group(2)), int(m.group(3))
        except ValueError:
            pass
    return None, None, None


def ocr_coordinates(image: Image.Image) -> OCRResult:
    """Run RapidOCR on the bottom 25% of the image (where the VS HUD
    prints coordinates by default). Falls back to the full image if
    nothing is parsed from the crop.
    """
    raw_text, confidence = _run_rapidocr(_hud_crop(image))
    logger.info(
        "screenshot_pipeline: HUD-crop OCR text=%r conf=%.3f",
        (raw_text or "")[:200], confidence,
    )
    x, y, z = _parse_coord_text(raw_text)
    if x is None or z is None:
        # Try the full image — some users move the HUD.
        full_text, full_conf = _run_rapidocr(image)
        logger.info(
            "screenshot_pipeline: full-image OCR fallback text=%r conf=%.3f",
            (full_text or "")[:200], full_conf,
        )
        if full_text:
            fx, fy, fz = _parse_coord_text(full_text)
            if fx is not None and fz is not None:
                return OCRResult(
                    x=fx, y=fy, z=fz, raw_text=full_text, confidence=full_conf
                )
            # Keep the longer text for admin display even if parsing failed.
            if len(full_text) > len(raw_text):
                raw_text = full_text
                confidence = max(confidence, full_conf)
    logger.info(
        "screenshot_pipeline: OCR parsed coords x=%s y=%s z=%s conf=%.3f",
        x, y, z, confidence,
    )
    return OCRResult(x=x, y=y, z=z, raw_text=raw_text, confidence=confidence)


def _hud_crop(image: Image.Image) -> Image.Image:
    h = image.height
    return image.crop((0, int(h * 0.75), image.width, h))


def _run_rapidocr(image: Image.Image) -> Tuple[str, float]:
    """Run RapidOCR on a PIL image; returns (concatenated text, mean confidence).

    Lazy-imports rapidocr so missing dep doesn't break app boot. On any
    failure returns ``("", 0.0)`` — the caller will surface it as a
    low-confidence OCR result and the admin can still type coordinates
    manually.
    """
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
    except Exception:
        logger.warning("rapidocr_onnxruntime not installed; OCR disabled")
        return "", 0.0

    engine = _get_rapidocr_engine()
    if engine is None:
        return "", 0.0

    arr = np.asarray(image.convert("RGB"))
    try:
        result, _elapsed = engine(arr)
    except Exception:
        logger.exception(
            "rapidocr inference failed (image %dx%d)", image.width, image.height
        )
        return "", 0.0

    if not result:
        logger.info(
            "screenshot_pipeline: rapidocr returned no text (image %dx%d)",
            image.width, image.height,
        )
        return "", 0.0

    parts: List[str] = []
    confs: List[float] = []
    for item in result:
        # rapidocr returns [box, text, confidence]
        try:
            _, text, conf = item
        except (ValueError, TypeError):
            continue
        if text:
            parts.append(str(text))
        try:
            confs.append(float(conf))
        except (ValueError, TypeError):
            pass

    return " ".join(parts), (float(np.mean(confs)) if confs else 0.0)


_rapidocr_engine = None
_rapidocr_init_failed = False


def _get_rapidocr_engine():
    """Lazy-init RapidOCR engine. Returns None if init failed previously."""
    global _rapidocr_engine, _rapidocr_init_failed
    if _rapidocr_engine is not None:
        return _rapidocr_engine
    if _rapidocr_init_failed:
        return None
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
        logger.info("screenshot_pipeline: initialising RapidOCR engine (first call)")
        _rapidocr_engine = RapidOCR()
        logger.info("screenshot_pipeline: RapidOCR engine ready")
    except Exception:
        logger.exception("rapidocr engine init failed; disabling OCR for this process")
        _rapidocr_init_failed = True
        return None
    return _rapidocr_engine


# ---------------------------------------------------------------------------
# Minimap-vs-server comparison via level-5 chunks
# ---------------------------------------------------------------------------

def _inpaint_minimap_overlays(rgb: np.ndarray, cv2) -> np.ndarray:
    """Replace high-saturation UI overlay pixels (player dot, waypoint pins,
    prospecting markers, etc.) with the surrounding terrain via Telea
    inpainting.

    The server-map crop has none of these, so leaving them in the template
    drops the correlation peak and adds spurious matches wherever the
    server map happens to have similarly bright pixels. We dilate the
    raw HSV mask slightly so anti-aliased pixel rings are also removed.
    """
    try:
        hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
        sat = hsv[..., 1]
        val = hsv[..., 2]
        mask = ((sat >= OVERLAY_SATURATION_MIN) & (val >= OVERLAY_VALUE_MIN)).astype(
            np.uint8
        ) * 255
        if not mask.any():
            return rgb
        # Dilate to capture the soft edge of each marker.
        kernel = np.ones((3, 3), dtype=np.uint8)
        mask = cv2.dilate(mask, kernel, iterations=2)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        inpainted = cv2.inpaint(bgr, mask, OVERLAY_INPAINT_RADIUS, cv2.INPAINT_TELEA)
        return cv2.cvtColor(inpainted, cv2.COLOR_BGR2RGB)
    except Exception:
        logger.exception("_inpaint_minimap_overlays failed; falling back to raw RGB")
        return rgb


def _canny(gray: np.ndarray, cv2) -> np.ndarray:
    """Auto-thresholded Canny edge map. Smoothed first so JPEG-style noise
    in the minimap doesn't dominate the edge response."""
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    median = float(np.median(blurred))
    lo = int(max(0, 0.66 * median))
    hi = int(min(255, 1.33 * median))
    return cv2.Canny(blurred, lo, hi)


def _orb_geometric_match(
    minimap_gray: np.ndarray,
    sampled_gray: np.ndarray,
    cv2,
) -> Tuple[float, int, int]:
    """Match the minimap into the sampled server crop via ORB + RANSAC.

    Returns ``(score, inlier_count, good_match_count)`` where ``score``
    is in ``[0, 1]`` and is computed from the absolute inlier count
    saturating at ``ORB_INLIER_TARGET``. A genuine match yields a tight,
    geometrically-consistent cluster of inliers; a wrong location yields
    scattered matches that RANSAC discards almost entirely (typically 0-3
    inliers → score < 0.15).
    """
    orb = cv2.ORB_create(
        nfeatures=ORB_MAX_FEATURES,
        scaleFactor=ORB_PYRAMID_SCALE,
        nlevels=ORB_PYRAMID_LEVELS,
        edgeThreshold=ORB_EDGE_THRESHOLD,
    )
    kp_a, des_a = orb.detectAndCompute(minimap_gray, None)
    kp_b, des_b = orb.detectAndCompute(sampled_gray, None)
    if des_a is None or des_b is None or len(kp_a) < 2 or len(kp_b) < 2:
        return 0.0, 0, 0

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    try:
        knn = bf.knnMatch(des_a, des_b, k=2)
    except cv2.error:
        return 0.0, 0, 0

    # Lowe's ratio test: keep matches that are noticeably better than the
    # runner-up. The ratio is intentionally permissive (0.85) because the
    # minimap may cover a tiny fraction of the server crop, in which case
    # every query descriptor finds a near-duplicate runner-up by chance.
    # RANSAC below filters the geometric noise that survives.
    good = []
    for pair in knn:
        if len(pair) < 2:
            continue
        m, n = pair
        if m.distance < ORB_LOWE_RATIO * n.distance:
            good.append(m)

    if len(good) < ORB_MIN_GOOD_MATCHES:
        return 0.0, 0, len(good)

    src_pts = np.float32(
        [kp_a[m.queryIdx].pt for m in good]
    ).reshape(-1, 1, 2)
    dst_pts = np.float32(
        [kp_b[m.trainIdx].pt for m in good]
    ).reshape(-1, 1, 2)

    # Homography is a superset of similarity (scale + translation +
    # rotation + perspective). For a flat 2D map projection the result
    # should be very close to a similarity transform, so RANSAC inliers
    # are a strong "these matches agree on a single placement" signal.
    _H, mask = cv2.findHomography(
        src_pts, dst_pts, cv2.RANSAC, ORB_RANSAC_REPROJ_PX,
    )
    if mask is None:
        return 0.0, 0, len(good)

    inliers = int(mask.sum())
    # Saturating absolute-count score. Wrong locations rarely produce
    # >3 RANSAC inliers; real matches commonly produce 10-50+. Mapping
    # 25 inliers → 1.0 keeps the useful range monotonic without making
    # "good but small overlap" matches look bad.
    score = min(1.0, inliers / float(ORB_INLIER_TARGET))
    return float(max(0.0, score)), inliers, len(good)


def compare_minimap_to_level5(
    minimap: Image.Image,
    *,
    x_center: int,
    z_center: int,
    half_window_blocks: int = LEVEL5_HALF_WINDOW_BLOCKS,
) -> MinimapMatchResult:
    """Sample the level-5 cache (1 px = 1 block) around the player's
    coordinate, then run multi-scale template matching of the minimap
    crop against that window.

    Returns a :class:`MinimapMatchResult` with ``score`` in ``[0, 1]``
    where higher is more confident. ``method`` is one of:

    - ``"matchTemplate"`` — successful similarity scoring,
    - ``"no_chunks"`` — none of the relevant level-5 chunks exist on R2
      (area unexplored on the server map; warning emitted upstream),
    - ``"opencv_unavailable"`` — cv2 import failed; comparison skipped,
    - ``"error"`` — uncaught exception during matching.
    """
    try:
        sampled, chunks_used, window = _sample_level5_window(
            x_center=x_center,
            z_center=z_center,
            half_window_blocks=half_window_blocks,
        )
    except Exception:
        logger.exception("compare_minimap_to_level5: sample failed")
        return MinimapMatchResult(score=0.0, method="error", chunks_used=0,
                                  scale=None, sampled_window=None)

    if sampled is None or chunks_used == 0:
        return MinimapMatchResult(
            score=0.0, method="no_chunks", chunks_used=0,
            scale=None, sampled_window=window, sampled_image=sampled,
        )

    try:
        import cv2  # type: ignore
    except Exception:
        logger.warning("opencv-python-headless not installed; minimap match disabled")
        return MinimapMatchResult(
            score=0.0, method="opencv_unavailable", chunks_used=chunks_used,
            scale=None, sampled_window=window, sampled_image=sampled,
        )

    try:
        sampled_gray = cv2.cvtColor(sampled, cv2.COLOR_RGB2GRAY)
        minimap_rgb = np.asarray(minimap.convert("RGB"))
        minimap_clean = _inpaint_minimap_overlays(minimap_rgb, cv2)
        minimap_gray = cv2.cvtColor(minimap_clean, cv2.COLOR_RGB2GRAY)

        # The in-game minimap and the level-5 server cache render the same
        # blocks with very different visuals: the minimap has full 3D
        # lighting/shading, the cache is flat per-block colour. That kills
        # raw pixel correlation (NCC, edges) even at the correct location.
        # Instead, do feature-based matching with geometric verification:
        #   1. ORB keypoints + descriptors on both images
        #   2. BFMatcher.knnMatch(k=2) + Lowe ratio test for "good" matches
        #   3. RANSAC homography over the good matches; count inliers
        # A real match yields a tight, geometrically-consistent cluster of
        # inliers; a wrong location yields scattered noise that RANSAC
        # rejects almost entirely. The reported score is the inlier ratio.
        score, inliers, kp_count = _orb_geometric_match(
            minimap_gray, sampled_gray, cv2,
        )
        return MinimapMatchResult(
            score=score,
            method="orb_ransac",
            chunks_used=chunks_used,
            # ``scale`` is no longer a single zoom factor (ORB is scale-
            # invariant), so we surface the absolute inlier count instead
            # so the admin can see "matched 42 keypoints, 38 geometrically
            # consistent" rather than guessing what 0.7 means.
            scale=float(inliers) if kp_count > 0 else None,
            sampled_window=window,
            sampled_image=sampled,
        )
    except Exception:
        logger.exception("compare_minimap_to_level5: orb match failed")
        return MinimapMatchResult(
            score=0.0, method="error", chunks_used=chunks_used,
            scale=None, sampled_window=window, sampled_image=sampled,
        )


def _sample_level5_window(
    *,
    x_center: int,
    z_center: int,
    half_window_blocks: int,
) -> Tuple[Optional[np.ndarray], int, Optional[dict]]:
    """Download the level-5 cache chunks covering the requested window
    and stitch them into one numpy RGB array.

    Returns ``(stitched, chunks_used, window_dict)`` where ``window_dict``
    is the world-block bbox we tried to sample. Returns ``(None, 0, ...)``
    when level-5 metadata isn't available.
    """
    # Translate world coords (centred at world middle) into level-5 image-pixel
    # coords. At level 5 every cache pixel is 1 world block; the image origin
    # is the chunk-aligned top-left corner of the explored bounds, recorded in
    # the level metadata as ``min_x/min_z`` (chunk indices).
    metadata = _load_level5_metadata()
    if metadata is None:
        logger.warning(
            "screenshot_pipeline: level-5 metadata.json missing/unreadable on R2 "
            "(check R2_BUCKET_NAME / endpoint / pre-generated tops cache)"
        )
        return None, 0, None

    chunk_grid = int(metadata.get("chunk_grid", 64))
    image_w = int(metadata.get("image_w", 0))
    image_h = int(metadata.get("image_h", 0))
    chunk_w = int(metadata.get("chunk_w", 0))
    chunk_h = int(metadata.get("chunk_h", 0))
    scale = int(metadata.get("scale", 1)) or 1

    if image_w <= 0 or image_h <= 0 or chunk_w <= 0 or chunk_h <= 0:
        return None, 0, None

    # World block (x, z) -> image pixel (px, py).
    #
    # OCR returns coordinates in the same centered VS world-block space the
    # frontend uses (range roughly ±512000 around 0). The level metadata
    # exposes ``start_x`` / ``start_z`` as the centered world-block coord of
    # the image's top-left pixel — i.e. ``min_chunk_* * TILE_SIZE -
    # DEFAULT_MAP_MIDDLE``. We must use those, not raw ``min_x * TILE_SIZE``,
    # otherwise the computed pixel center is offset by ~512000 blocks and
    # always falls outside the image (→ chunks_used=0 → "no_chunks" warning
    # even though the data is there). No Z flip: the map renderer and the
    # frontend both treat +Z as image-down, matching the OCR coord.
    start_block_x = int(metadata.get("start_x", 0))
    start_block_z = int(metadata.get("start_z", 0))

    px_center = int((x_center - start_block_x) / scale)
    py_center = int((z_center - start_block_z) / scale)

    half = max(8, int(half_window_blocks / scale))
    px0 = max(0, px_center - half)
    py0 = max(0, py_center - half)
    px1 = min(image_w, px_center + half)
    py1 = min(image_h, py_center + half)

    window_dict = {
        "x_min": x_center - half_window_blocks,
        "x_max": x_center + half_window_blocks,
        "z_min": z_center - half_window_blocks,
        "z_max": z_center + half_window_blocks,
    }

    if px1 <= px0 or py1 <= py0:
        return None, 0, window_dict

    # Figure out which chunks intersect the window.
    cx_min = max(0, px0 // chunk_w)
    cy_min = max(0, py0 // chunk_h)
    cx_max = min(chunk_grid - 1, (px1 - 1) // chunk_w)
    cy_max = min(chunk_grid - 1, (py1 - 1) // chunk_h)

    cells: dict = {}  # (cx, cy) -> np.ndarray
    chunks_used = 0
    missing = 0
    decode_fail = 0
    for cy in range(cy_min, cy_max + 1):
        for cx in range(cx_min, cx_max + 1):
            key = r2_storage.tops_map_level_chunk_key(5, cx, cy)
            try:
                raw = r2_storage.download_bytes(key)
            except FileNotFoundError:
                missing += 1
                continue
            except Exception:
                logger.exception(
                    "screenshot_pipeline: level-5 chunk download failed key=%s", key
                )
                missing += 1
                continue
            try:
                tile = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"))
            except Exception:
                logger.exception(
                    "screenshot_pipeline: level-5 chunk decode failed key=%s", key
                )
                decode_fail += 1
                continue
            cells[(cx, cy)] = tile
            chunks_used += 1

    logger.info(
        "screenshot_pipeline: level-5 sample around (x=%d,z=%d) chunks=%d missing=%d decode_fail=%d "
        "grid=(%d..%d, %d..%d) px_window=(%d,%d,%d,%d) image=%dx%d",
        x_center, z_center, chunks_used, missing, decode_fail,
        cx_min, cx_max, cy_min, cy_max, px0, py0, px1, py1, image_w, image_h,
    )

    if not cells:
        return None, 0, window_dict

    # Stitch the relevant chunks. Use chunk_w/chunk_h placement; the last
    # column/row may be larger but that's fine because we crop afterwards.
    stitched_w = (cx_max - cx_min + 1) * chunk_w
    stitched_h = (cy_max - cy_min + 1) * chunk_h
    # If a tile is larger (last col/row) we extend to fit it.
    for (cx, cy), tile in cells.items():
        right = (cx - cx_min) * chunk_w + tile.shape[1]
        bottom = (cy - cy_min) * chunk_h + tile.shape[0]
        if right > stitched_w:
            stitched_w = right
        if bottom > stitched_h:
            stitched_h = bottom

    canvas = np.zeros((stitched_h, stitched_w, 3), dtype=np.uint8)
    for (cx, cy), tile in cells.items():
        ox = (cx - cx_min) * chunk_w
        oy = (cy - cy_min) * chunk_h
        h2, w2 = tile.shape[:2]
        canvas[oy:oy + h2, ox:ox + w2] = tile

    # Crop the stitched canvas to the actual world window (in image-pixel
    # coords relative to the stitched origin).
    crop_x0 = px0 - cx_min * chunk_w
    crop_y0 = py0 - cy_min * chunk_h
    crop_x1 = crop_x0 + (px1 - px0)
    crop_y1 = crop_y0 + (py1 - py0)
    crop_x0 = max(0, crop_x0)
    crop_y0 = max(0, crop_y0)
    crop_x1 = min(canvas.shape[1], crop_x1)
    crop_y1 = min(canvas.shape[0], crop_y1)
    if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
        return None, chunks_used, window_dict
    return canvas[crop_y0:crop_y1, crop_x0:crop_x1].copy(), chunks_used, window_dict


def _load_level5_metadata() -> Optional[dict]:
    """Download the level-5 metadata.json from R2. Returns None if missing."""
    key = r2_storage.tops_map_level_metadata_key(5)
    try:
        import json
        raw = r2_storage.download_bytes(key)
        meta = json.loads(raw.decode("utf-8"))
        logger.info(
            "screenshot_pipeline: loaded level-5 metadata key=%s image=%sx%s chunk=%sx%s "
            "grid=%s scale=%s start=(%s,%s)",
            key, meta.get("image_w"), meta.get("image_h"),
            meta.get("chunk_w"), meta.get("chunk_h"),
            meta.get("chunk_grid"), meta.get("scale"),
            meta.get("start_x"), meta.get("start_z"),
        )
        return meta
    except FileNotFoundError:
        logger.warning(
            "screenshot_pipeline: level-5 metadata key not found on R2: %s "
            "(bucket=%s) \u2014 run pregenerate_tops_map_cache.py?",
            key, r2_storage._bucket(),
        )
        return None
    except Exception:
        logger.exception("screenshot_pipeline: failed to load level-5 metadata key=%s", key)
        return None


# ---------------------------------------------------------------------------
# Validation warnings
# ---------------------------------------------------------------------------

DISTANCE_MIN_BLOCKS = 1000
DISTANCE_MAX_BLOCKS = 14000
OCR_LOW_CONFIDENCE_THRESHOLD = 0.70
MINIMAP_LOW_MATCH_THRESHOLD = 0.30
EXIF_STALE_DAYS = 30


def build_validation_warnings(
    *,
    ocr_a: OCRResult,
    ocr_b: OCRResult,
    coords_a: dict,
    coords_b: dict,
    minimap_a: MinimapMatchResult,
    minimap_b: MinimapMatchResult,
    taken_at_a: Optional[datetime],
    taken_at_b: Optional[datetime],
) -> list:
    """Aggregate human-readable warnings the admin sees in the review UI.

    None of these warnings BLOCK approval — they're advisory. Codes are
    stable so the frontend can style them.
    """
    warnings: list = []

    def _coord(d: dict, key: str) -> Optional[int]:
        v = d.get(key)
        return int(v) if isinstance(v, (int, float)) else None

    xa, za = _coord(coords_a, "x"), _coord(coords_a, "z")
    xb, zb = _coord(coords_b, "x"), _coord(coords_b, "z")

    # Distance check (Euclidean XZ).
    if xa is not None and za is not None and xb is not None and zb is not None:
        dx, dz = xa - xb, za - zb
        dist = (dx * dx + dz * dz) ** 0.5
        if dist < DISTANCE_MIN_BLOCKS:
            warnings.append({
                "code": "distance_too_short",
                "severity": "warning",
                "message": (
                    f"Distance between TLs is {dist:.0f} blocks "
                    f"(< {DISTANCE_MIN_BLOCKS}). Real TL pairs are usually farther apart."
                ),
            })
        elif dist > DISTANCE_MAX_BLOCKS:
            warnings.append({
                "code": "distance_too_long",
                "severity": "warning",
                "message": (
                    f"Distance between TLs is {dist:.0f} blocks "
                    f"(> {DISTANCE_MAX_BLOCKS}). Real TL pairs are usually closer."
                ),
            })
    else:
        warnings.append({
            "code": "coords_missing",
            "severity": "error",
            "message": "Could not parse X/Z from one or both screenshots.",
        })

    # OCR confidence per slot.
    for slot, ocr in (("A", ocr_a), ("B", ocr_b)):
        if ocr.confidence < OCR_LOW_CONFIDENCE_THRESHOLD:
            warnings.append({
                "code": "ocr_low_confidence",
                "severity": "warning",
                "message": (
                    f"Screenshot {slot}: OCR confidence {ocr.confidence:.2f} "
                    f"below {OCR_LOW_CONFIDENCE_THRESHOLD}. Verify coordinates."
                ),
            })

    # Minimap match.
    for slot, mm in (("A", minimap_a), ("B", minimap_b)):
        if mm.method == "no_chunks":
            warnings.append({
                "code": "minimap_no_server_map",
                "severity": "warning",
                "message": (
                    f"Screenshot {slot}: no server map data for that area on the "
                    f"TOPS map yet — cannot verify the screenshot is from this server."
                ),
            })
        elif mm.method == "opencv_unavailable":
            warnings.append({
                "code": "minimap_match_unavailable",
                "severity": "info",
                "message": "Minimap matching disabled (opencv not installed).",
            })
        elif mm.method == "error":
            warnings.append({
                "code": "minimap_match_error",
                "severity": "warning",
                "message": f"Screenshot {slot}: minimap match failed.",
            })
        elif mm.score < MINIMAP_LOW_MATCH_THRESHOLD:
            warnings.append({
                "code": "minimap_low_match",
                "severity": "warning",
                "message": (
                    f"Screenshot {slot}: minimap match score {mm.score:.2f} "
                    f"below {MINIMAP_LOW_MATCH_THRESHOLD}. The screenshot may not "
                    f"be from this server (or the area is partially unexplored)."
                ),
            })

    # EXIF staleness.
    now = datetime.now(timezone.utc)
    for slot, taken_at in (("A", taken_at_a), ("B", taken_at_b)):
        if taken_at is None:
            continue
        delta = abs((now - taken_at).total_seconds())
        if delta > EXIF_STALE_DAYS * 86400:
            warnings.append({
                "code": "exif_stale",
                "severity": "info",
                "message": (
                    f"Screenshot {slot} was taken on {taken_at.date().isoformat()} "
                    f"(> {EXIF_STALE_DAYS} days ago). May have been taken from a "
                    f"different game state."
                ),
            })

    return warnings


# ---------------------------------------------------------------------------
# Duplicate-pair warnings (existing live TLs + other pending submissions)
# ---------------------------------------------------------------------------

DUPLICATE_PAIR_RADIUS_BLOCKS = 200


def _coord_pair_endpoints_overlap(
    a: tuple,
    b: tuple,
    *,
    radius: int = DUPLICATE_PAIR_RADIUS_BLOCKS,
) -> bool:
    """Orientation-agnostic: do TL pair ``a``'s endpoints both fall within
    ``radius`` blocks of TL pair ``b``'s endpoints? Both pairs must be in
    the SAME coordinate space (either both world-Z or both geojson-Z)."""
    ax1, az1, ax2, az2 = a
    bx1, bz1, bx2, bz2 = b
    r2 = radius * radius

    def near(x1: int, z1: int, x2: int, z2: int) -> bool:
        dx = x1 - x2
        dz = z1 - z2
        return dx * dx + dz * dz <= r2

    fwd = near(ax1, az1, bx1, bz1) and near(ax2, az2, bx2, bz2)
    rev = near(ax1, az1, bx2, bz2) and near(ax2, az2, bx1, bz1)
    return fwd or rev


def build_duplicate_pair_warnings(
    *,
    coords_a: dict,
    coords_b: dict,
    existing_pairs: list,
    other_pending: list,
    radius: int = DUPLICATE_PAIR_RADIUS_BLOCKS,
) -> list:
    """Warnings for "this TL is already on the map" and "another user has
    a pending submission for this TL pair".

    All coordinate inputs MUST be in the same Z convention as the OCR
    coords (i.e. world space, +Z = north). The caller is responsible for
    flipping geojson-stored Z before passing it in.

    ``existing_pairs`` — list of ``(x1, z1, x2, z2)`` tuples for live TLs.
    ``other_pending`` — list of ``{coords: (x1, z1, x2, z2),
    submitter_display_name: str|None}``.
    """
    warnings: list = []

    def _coord(d, k):
        v = d.get(k) if isinstance(d, dict) else None
        return int(v) if isinstance(v, (int, float)) else None

    xa, za = _coord(coords_a, "x"), _coord(coords_a, "z")
    xb, zb = _coord(coords_b, "x"), _coord(coords_b, "z")
    if xa is None or za is None or xb is None or zb is None:
        # Without coords we can't compare. The coords_missing warning from
        # build_validation_warnings already flags this case.
        return warnings

    submitted = (xa, za, xb, zb)

    for e in existing_pairs:
        try:
            if _coord_pair_endpoints_overlap(submitted, e, radius=radius):
                warnings.append({
                    "code": "tl_pair_already_exists",
                    "severity": "warning",
                    "message": (
                        f"This TL pair is within {radius} blocks of a translocator "
                        f"already on the map "
                        f"(({e[0]}, {e[1]}) ↔ ({e[2]}, {e[3]})). "
                        f"Likely a duplicate submission."
                    ),
                })
                break
        except (TypeError, ValueError):
            continue

    seen_submitters: set = set()
    for entry in other_pending:
        c = entry.get("coords")
        if not c:
            continue
        try:
            if not _coord_pair_endpoints_overlap(submitted, c, radius=radius):
                continue
        except (TypeError, ValueError):
            continue
        who = entry.get("submitter_display_name") or "another user"
        if who in seen_submitters:
            continue
        seen_submitters.add(who)
        warnings.append({
            "code": "tl_pair_pending_other_user",
            "severity": "warning",
            "message": (
                f"Another pending screenshot submission from {who} covers this "
                f"same TL pair (within {radius} blocks). Review both before "
                f"approving to avoid double entries."
            ),
        })

    return warnings


# ---------------------------------------------------------------------------
# PNG <-> bytes helpers
# ---------------------------------------------------------------------------

def numpy_to_png_bytes(arr: np.ndarray) -> bytes:
    img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def pil_to_png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()
