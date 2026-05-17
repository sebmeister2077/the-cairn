# Translocator screenshot contribution flow

The screenshot-based translocator (TL) contribution flow is an alternative to the chat-log path: instead of pasting a `/tpall`-style command log, a logged-in user uploads **two screenshots** — one taken at each endpoint of a paired translocator — and the backend does OCR, an EXIF strip, and a minimap-vs-server-map match. The admin reviews the result and approves or rejects it; an approval merges the new segment into the same `translocators.geojson` as the chat-log path.

This page documents the full technical pipeline: the wire protocol, the database row, the worker, the image-processing stages, and the storage layout.

> Gated by feature flag `translocator_screenshot_contributions` (default **OFF**). Anonymous keys cannot submit — account is required.

## Index

- [High-level flow](#high-level-flow)
- [HTTP API](#http-api)
  - [User endpoints](#user-endpoints)
  - [Admin endpoints](#admin-endpoints)
- [R2 storage layout](#r2-storage-layout)
- [Database row](#database-row)
- [Analysis worker](#analysis-worker)
- [Image pipeline stages](#image-pipeline-stages)
  - [1. EXIF strip & re-upload](#1-exif-strip--re-upload)
  - [2. Minimap detection & crop](#2-minimap-detection--crop)
  - [3. OCR (RapidOCR)](#3-ocr-rapidocr)
  - [4. Minimap-vs-server match (ORB + RANSAC)](#4-minimap-vs-server-match-orb--ransac)
  - [5. Validation warnings](#5-validation-warnings)
- [Approve / reject / withdraw](#approve--reject--withdraw)
- [Operational notes](#operational-notes)

---

## High-level flow

```
┌─────────┐  1. POST upload-url    ┌─────────┐
│ Browser │ ─────────────────────► │ Backend │
│         │ ◄───── request_id + 2 presigned PUT URLs
│         │
│         │  2. PUT screenshot A   ┌────────┐
│         │ ─────────────────────► │   R2   │
│         │  2. PUT screenshot B   │        │
│         │ ─────────────────────► │        │
│         │
│         │  3. POST complete      ┌─────────┐         ┌──────────┐
│         │ ─────────────────────► │ Backend │ ──────► │ Postgres │
│         │                        │         │   INSERT row, kick worker
│         │                        └─────────┘         └──────────┘
└─────────┘                              │
                                         ▼
                       ┌─────────────────────────────────────┐
                       │ tl-screenshot-analysis worker thread │
                       │  per slot:                           │
                       │    download R2 → strip EXIF → re-up  │
                       │    detect minimap bbox → crop → up   │
                       │    OCR coords (RapidOCR)             │
                       │    sample level-5 cache around coords│
                       │    ORB+RANSAC match minimap vs server│
                       │  aggregate warnings → persist row    │
                       └─────────────────────────────────────┘
                                         │
                                         ▼
                       ┌──────────────┐  admin reviews UI,
                       │ Admin routes │  approves → merge into
                       │              │  translocators.geojson +
                       └──────────────┘  audit row, delete R2 objects
```

The browser never streams image bytes through the backend — uploads go **direct to R2** via presigned PUT URLs. The backend only sees the bytes inside the worker, *after* the row exists.

## HTTP API

All paths are prefixed with `/api`. Source: [contribute_tls_screenshots.py](backend/app/routes/contribute_tls_screenshots.py), [admin_translocators_screenshots.py](backend/app/routes/admin_translocators_screenshots.py).

### User endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/contribute-tls/screenshots/upload-url` | Mint a `request_id` + two presigned PUT URLs (slot `a` + `b`), 15-minute TTL |
| `POST` | `/contribute-tls/screenshots/complete` | Verify both objects exist + within 8 MiB cap, insert DB row, kick worker |
| `GET`  | `/contribute-tls/screenshots/mine` | List the caller's own requests (50 most recent) |
| `POST` | `/contribute-tls/screenshots/{id}/withdraw` | Cancel a still-pending request and delete its R2 objects |

Auth: every endpoint requires `require_active_user`; the route handler then calls `_require_account_user(ctx)` which raises **403 `account_required`** for anonymous API keys.

Quotas:
- Per-user pending cap: **`_MAX_PENDING_TL_CONTRIBUTIONS_PER_USER = 90`**. Enforced on both `upload-url` (early reject) and `complete` (race-safe re-check).
- Per-screenshot size cap: **`_MAX_SCREENSHOT_BYTES = 8 MiB`** (PNG). Enforced on `complete` via R2 `HEAD` — oversize objects are deleted before the 400 returns.

Feature flag: every endpoint calls `_ensure_flag_on()`. When the flag is **off**, every call returns **404** with `{ "code": "feature_disabled" }` — a deliberate choice so the feature is invisible to clients, not visibly disabled.

### Admin endpoints

Prefix `/api/admin/translocators/screenshots`. Auth: `require_admin`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `""`                          | Paginated list, filter by `status` / `submitter_api_key_id` (limit ≤ 200) |
| `GET`    | `/{id}`                       | Full row + presigned download URLs for screenshots & minimap/server crops |
| `PATCH`  | `/{id}`                       | Edit `coords_a` / `coords_b` / `label` before approval |
| `POST`   | `/{id}/retry-analysis`        | Reset `analysis_status` to `queued`, re-kick the worker |
| `POST`   | `/{id}/approve`               | Merge into `translocators.geojson`, write audit, delete R2 objects |
| `POST`   | `/{id}/reject`                | Mark rejected with reason, delete R2 objects |

`retry-analysis` has a special case: if `analysis_status='running'` **and** the in-process worker thread is no longer alive (previous process OOM-crashed mid-analysis), the reset is allowed with `allow_running=True`. Without that, a crash would strand the row forever.

## R2 storage layout

All screenshot-flow objects live under one prefix. Keys are generated by helpers in [r2_storage.py](backend/app/core/r2_storage.py#L778-L805):

```
pending-tl-screenshots/
  {request_id}-a.png                  ← original user upload, slot A
  {request_id}-b.png                  ← original user upload, slot B
  {request_id}-a-minimap.png          ← cropped minimap from slot A
  {request_id}-b-minimap.png          ← cropped minimap from slot B
  {request_id}-a-server-crop.png      ← stitched level-5 window the matcher used
  {request_id}-b-server-crop.png      ← stitched level-5 window the matcher used
```

- The original upload PNG gets **rewritten in place** by the worker after EXIF is stripped (same key, no metadata).
- The minimap crop and server crop are uploaded best-effort — failures log but don't abort analysis. The DB column for the minimap crop is set to `NULL` on failure.
- The **server crop key is deterministic** (not stored in the DB). The admin detail endpoint presigns it with `verify_exists=True` and returns `null` when the matcher couldn't sample (e.g. coords outside the level-5 cache).
- On approve / reject / withdraw the row is finalised and all four/six R2 objects are deleted best-effort. Failures are logged but don't roll back the decision.

## Database row

Table: `translocator_screenshot_requests` ([screenshot_tl_requests.py](backend/app/db/models/screenshot_tl_requests.py)).

Columns (Postgres types):

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text` PK | client-generated UUID4 |
| `status` | `text` | `pending` / `approved` / `rejected` / `withdrawn` |
| `submitter_api_key_id` | `text` | FK-ish ref to `api_keys.id` |
| `submitter_display_name` | `text` | snapshot at submit-time |
| `screenshot_a_key`, `screenshot_b_key` | `text` | R2 keys; nulled on decision |
| `minimap_crop_a_key`, `minimap_crop_b_key` | `text` | nulled on decision |
| `screenshot_a_taken_at`, `screenshot_b_taken_at` | `timestamptz` | from EXIF, optional |
| `ocr_a`, `ocr_b` | `jsonb` | `{x, y, z, raw_text, confidence}` |
| `coords_a`, `coords_b` | `jsonb` | initially mirrors OCR, admin can edit |
| `label` | `text` | optional, ≤ 200 chars |
| `analysis_status` | `text` | `queued` / `running` / `done` / `failed` |
| `analysis_error` | `text` | truncated to 1000 chars on failure |
| `validation_warnings` | `jsonb` | `[{code, severity, message, ...}]` |
| `minimap_match` | `jsonb` | `{a: {...}, b: {...}}` per-slot match stats |
| `decision_actor_api_key_id`, `decision_at`, `decision_reason` | | set on approve/reject/withdraw |
| `resulting_segment_id` | `text` | set on approve (UUID of the new geojson feature) |
| `created_at`, `updated_at` | `timestamptz` | |

Indexes: `(status, created_at DESC)`, `(submitter_api_key_id, created_at DESC)`, `(analysis_status)`.

## Analysis worker

Source: [process_tl_screenshot_request.py](backend/app/tasks/process_tl_screenshot_request.py).

Design: **single in-process worker thread** (`threading.Thread`, `daemon=True`), guarded by a module-level `_job_lock` + `_active_thread` reference. Pattern matches `tasks/match_score.py`.

Lifecycle:

1. `start_job()` spawns the thread only if `_active_thread` is `None` or dead. Idempotent — called from `complete_upload`, `retry-analysis`, and startup.
2. `_worker_loop()` keeps claiming rows until the queue is empty:
   - `db.claim_pending_tl_screenshot_analysis()` runs `UPDATE … SET analysis_status='running' WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` — atomic claim safe for a future multi-worker setup.
   - On empty queue, re-checks under `_job_lock` to close the race where a new row gets inserted while the thread is exiting, then `_active_thread = None` and returns.
3. On per-request exception, calls `db.set_tl_screenshot_analysis_failed(id, "<type>: <msg>")`.

Startup recovery: `kick_on_startup()` (called from `main.py` lifespan) runs `reset_stuck_tl_screenshot_analysis()` — any row stuck in `analysis_status='running'` from a previous process is requeued, because the worker is in-process and died with the server. Then `start_job()` is called.

Concurrency: exactly **one** request in flight per process at any time. Slot A and slot B inside a request are processed **strictly sequentially** so the worker's peak working set is one decoded 4K screenshot + one ORB pass, not two — important on a small instance.

Memory discipline (per slot):
- `raw` PNG bytes are `del`'d as soon as the EXIF strip produces `clean.clean_png_bytes`.
- The decoded PIL image is opened inside a `with Image.open(...)` block so it closes even on exception.
- `clean` is `del`'d before the ORB match runs.
- `minimap_img` is closed and `del`'d after the match.
- `match.sampled_image` (the stitched server-map numpy array, the largest single allocation) is uploaded to R2 then set to `None`.
- `gc.collect()` runs at the end of each slot and between slots.

This keeps the **per-request churn** flat. Baseline RSS is still ~600 MB to 1 GB once the worker has run once, because RapidOCR (ONNX runtime), OpenCV, and NumPy lazy-load their native arenas on first use and never return them to the OS. That is one-time initialisation, **not** a leak.

## Image pipeline stages

All stages are pure functions in [screenshot_pipeline.py](backend/app/core/screenshot_pipeline.py). The worker is the only caller in production.

### 1. EXIF strip & re-upload

`strip_exif_keep_timestamps(png_bytes) -> StripResult`

- Decodes the upload with Pillow, extracts the first non-empty `DateTimeOriginal` / `DateTime` / `DateTimeDigitized` EXIF tag (returned as `taken_at`, treated as UTC).
- Re-encodes the image as a clean PNG forced to RGB with **no metadata chunks**.
- The cleaned PNG is then `upload_bytes()`-ed back to R2 over the original key (best-effort: failures log but don't abort, since the original still works for review).

Why: PNGs from screenshot tools can carry GPS, device info, software fingerprints, etc. The clean copy is what's shown to the admin and what gets deleted post-decision.

### 2. Minimap detection & crop

`detect_minimap_bbox(img) -> Optional[bbox]` then `crop_minimap(img, bbox)`.

Strategy:
- Search only the **top-right quadrant** of the screenshot (`MINIMAP_SEARCH_*_FRAC` constants). The VS minimap is anchored top-right and may sit flush against the top/right edges, so only the **bottom** and **left** transitions are reliably present.
- Sobel-style edge response over the masked region; the row/column position whose edge strength clears `MINIMAP_EDGE_PROMINENCE × median` is taken as the bottom / left boundary.
- Minimum side `MINIMAP_MIN_SIDE_PX = 80` rejects noise.
- Failure → bbox is `None`; the request still proceeds (no minimap match), and a `minimap_not_detected` warning is appended.

The crop is uploaded to R2 as `{id}-{slot}-minimap.png` so the admin UI can show it next to the original.

### 3. OCR (RapidOCR)

`ocr_coordinates(img) -> OCRResult`

- Engine: **RapidOCR** (ONNX runtime backend), lazy-singleton in `_get_rapidocr_engine()`. If init fails (model cache unwritable, native deps missing, OOM during load), `_rapidocr_init_failed` latches and OCR returns empty for the rest of the process lifetime — the request still completes with `coords=None` and surfaces the gap as a warning.
- Text is concatenated and run through two regexes:
  - `_COORD_REGEX_LABELLED` — `X: 12345 Y: 110 Z: -6789` style
  - `_COORD_REGEX_TRIPLE` — bare `12345 110 -6789`
- The mean per-token RapidOCR confidence is reported in `ocr.confidence`.

Output: `{x: int|None, y: int|None, z: int|None, raw_text: str, confidence: float}`.

### 4. Minimap-vs-server match (ORB + RANSAC)

`compare_minimap_to_level5(minimap, x_center, z_center) -> MinimapMatchResult`

This is the validation that the screenshot was taken **where the OCR'd coords say** (vs. e.g. a Photoshopped HUD over an unrelated location).

Steps:
1. `_sample_level5_window` translates `(x_center, z_center)` from centred VS world-block space to level-5 image-pixel space using `start_x` / `start_z` from the level metadata (the centred world-block coord of the image's top-left pixel — **not** raw `min_chunk * TILE_SIZE`; using the wrong one was a real bug). Window half-side is `LEVEL5_HALF_WINDOW_BLOCKS = 256`. The chunks intersecting that window are downloaded from R2 and stitched into a single numpy RGB array, then cropped to the requested window.
2. **UI overlay inpainting** (`_inpaint_minimap_overlays`): the player dot, waypoint pins, prospecting markers, etc. are vivid high-saturation pixels that don't exist in the flat server cache. They're masked by HSV saturation / value thresholds, dilated, and Telea-inpainted out. Without this they pull the correlation peak off the true location.
3. **ORB feature matching + RANSAC homography** (`_orb_geometric_match`):
   - ORB keypoints / descriptors on both grayscaled images. The minimap is often zoomed in so far it covers <2% of the 512 × 512-block server crop, so the pyramid is `ORB_PYRAMID_LEVELS = 12` at `ORB_PYRAMID_SCALE = 1.15` (≈5.4× scale range), with `ORB_MAX_FEATURES = 4000` and a low `ORB_EDGE_THRESHOLD = 8`.
   - `BFMatcher.knnMatch(k=2)` + Lowe ratio test (`ORB_LOWE_RATIO = 0.85`, intentionally permissive — RANSAC is the real outlier filter).
   - `cv2.findHomography(... RANSAC ...)` with `ORB_RANSAC_REPROJ_PX = 8.0`. Inliers count is the strong "geometrically consistent placement" signal.
   - Score: saturating absolute-count, `min(1.0, inliers / ORB_INLIER_TARGET)` with `ORB_INLIER_TARGET = 25`. Wrong locations rarely break 3 inliers; real matches typically yield 10–50+.
4. Result includes `method` (`orb_ransac` / `no_chunks` / `opencv_unavailable` / `no_minimap` / `no_coords` / `error`), `score`, `inliers` (surfaced via the `scale` field as an absolute count), and the stitched server crop as a numpy array (uploaded to R2 then immediately released).

Method strings — what each means in the admin UI:

| `method` | Meaning |
|----------|---------|
| `orb_ransac` | Normal match completed; `score` is meaningful |
| `no_chunks` | Coords are in an area the server-map cache hasn't generated for. Warning, but not a rejection signal |
| `no_minimap` | Step 2 failed to find the minimap in the screenshot |
| `no_coords` | OCR didn't extract usable x/z |
| `opencv_unavailable` | `cv2` import failed in this process; deploy issue |
| `error` | Uncaught exception during sampling or matching; check logs |

### 5. Validation warnings

`build_validation_warnings(...)` aggregates advisory issues for the admin UI. None **block** approval — admin can override. Codes are stable so the frontend can style them.

Notable codes (non-exhaustive):
- `minimap_not_detected` (step 2 failed)
- `ocr_low_confidence` (< `OCR_LOW_CONFIDENCE_THRESHOLD = 0.70`)
- `minimap_low_match` (< `MINIMAP_LOW_MATCH_THRESHOLD = 0.30`)
- `distance_out_of_range` (pair distance not in `[1000, 14000]` blocks)
- `screenshot_stale` (EXIF taken > `EXIF_STALE_DAYS = 30` ago)

Plus duplicate-pair warnings from `_build_duplicate_warnings`:
- Same endpoint pair already exists in live `translocators.geojson` (loaded via `contribute_tls._load_translocators_file` + `_existing_segments`). World-Z is flipped on read because the geojson stores `+Z = south` and OCR is in world space (`+Z = north`).
- Another user has a still-pending screenshot request with the same pair (via `list_pending_tl_screenshot_coords_excluding`).

## Approve / reject / withdraw

**Approve** ([admin_translocators_screenshots.py](backend/app/routes/admin_translocators_screenshots.py)):

1. Status must be `pending` and both `coords_a` / `coords_b` must have `x` and `z` (otherwise `coords_incomplete`).
2. Flip world-Z to geojson-Z (`+south`) — see chat-log path for the same flip.
3. Build a `LineString` feature with `properties.source = "screenshot"`, `tag = "user"`, `origin = "user"`, `added_by = submitter_display_name`, etc.
4. Acquire `contribute_tls_routes._translocators_lock` (shared with the chat-log path), load `translocators.geojson` from R2, append, save.
5. Write a `translocators_audit` row with `action='add'`, `submission_stats.source = "screenshot"`, `request_id`, full OCR + minimap_match snapshot. This is what makes screenshot vs chat-log submissions distinguishable in the audit feed.
6. `_delete_request_objects(row)` removes the 4–6 R2 objects.
7. `db.finalise_tl_screenshot_request(... status='approved', resulting_segment_id=segment_id)`.
8. `accounts_db.audit_log(api_key, "tl_screenshot.approve", ...)`.

**Reject**: same shape minus the geojson append; required `reason` (1–500 chars) is stored on the row and in the admin audit log.

**Withdraw** (user-facing): only allowed while `status='pending'` and only by the original submitter. Deletes R2 objects and marks the row `withdrawn`. No segment is written.

There is no undo. An approved segment can only be removed by the normal translocator-deletion admin path, not by reversing this request.

## Operational notes

- **Cold-start RAM** rises ~400–800 MB after the **first** screenshot is processed (RapidOCR ONNX models + OpenCV + NumPy arenas) and stays flat. This is lazy init, not a leak. To verify, watch RSS across several submissions — it should be bounded, not climb linearly per request. See [process_tl_screenshot_request.py](backend/app/tasks/process_tl_screenshot_request.py) for the per-request memory discipline.
- **Boto3 response bodies** are explicitly closed in [r2_storage.py](backend/app/core/r2_storage.py) `download_bytes` / `download_range` so connection-pool entries don't pin response buffers across requests.
- **Level-5 metadata** (`tops_map_level_metadata_key(5)`) is re-downloaded for every `_sample_level5_window` call. That's wasteful (small file, but two R2 round-trips per request) and a fine future optimisation, but it is **not** a memory issue.
- **`opencv-python-headless`** must be installed in the deployment image. If it's not, the worker still runs but every match returns `method='opencv_unavailable'` with `score=0` and the admin loses the geometric-verification signal.
- The **per-user pending cap (90)** is high on purpose — it's meant to stop a runaway client loop, not to throttle normal contribution rate.
- A **failed analysis** (`analysis_status='failed'`) does not block approval. The admin can still see the screenshots, type coords manually via `PATCH`, and approve — useful when OCR is wrong but the screenshots are clearly valid.
- The screenshot path and the chat-log path share `_translocators_lock` in `contribute_tls`. This is the only synchronisation between them; without it, simultaneous approvals could lose a geojson write.
