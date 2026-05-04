# Plan: zstd compression for combined DB, backups, and contribution archives

Adds an admin-controlled feature that compresses the persistent map artefacts in R2 with zstd. Storage and egress savings are largest on the combined DB (≈11 GB → ~700 MB at level 10), but the same primitive is reused for weekly + manual backups and per-contribution archive `.db` files. The UI lives on the existing feature flags page; the toggle is a flag, the level + threads are settings, and a live preview card shows the admin the predicted time and ratio before saving.

The change is correctness-preserving and reversible: the **combined DB** keeps a raw + compressed pair with a runtime fallback, while **backups and per-contribution archives** exist as exactly one form (raw OR compressed) at any moment, governed by the flag at write-time. Pre-existing archives are eagerly migrated to match the new format on flag flip.

---

## Asymmetric storage rule (the key invariant)

| Artefact | Flag OFF | Flag ON | Fallback at read time? |
|---|---|---|---|
| `globalservermap.db` | raw only | raw + `.zst` | **Yes** — readers prefer `.zst` if its `x-amz-meta-source-etag` matches the raw key's ETag, else download raw |
| `backups/backup-<key>.db` | raw only (server-side `copy_object`) | `.zst` only (download → compress → upload) | **No** — readers detect extension and decompress when needed |
| `archived/<id>.db` | raw only | `.zst` only | **No** — read path detects extension |
| `undo/<id>.replaced.db` | raw only | `.zst` only | **No** — read path detects extension |
| `undo/<id>.added.bin` | raw only | raw only (unchanged) | n/a |

**Why combined DB has both forms:** highest-traffic file. Cache misses must succeed even if the background `.zst` job is mid-flight, has crashed, or hasn't run yet for a freshly flipped flag. The raw upload at [admin_contributions.py L251](../backend/app/routes/admin_contributions.py#L251) stays as today; the `.zst` is layered on top as pure optimisation.

**Why backups + archives are single-form:** written once, read rarely (revert / restore). No churn, no concurrent reads racing a background job, no need for fallback. Doubling storage for files the admin already chose to compress would defeat the point.

---

## Phase 1 — Backend foundations

### 1.1 `app_settings` table

Add to schema bootstrap in [backend/app/core/database.py](../backend/app/core/database.py):

```sql
CREATE TABLE IF NOT EXISTS app_settings (
    key            TEXT PRIMARY KEY,
    value          JSONB NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by_key TEXT
);
```

Helpers: `get_setting(key, default)`, `set_setting(key, value, api_key)`, `list_settings()`. In-process cache with 30 s TTL mirroring [feature_flags.py](../backend/app/core/feature_flags.py). Flags stay strict booleans.

### 1.2 Compression module

New `backend/app/core/compression.py`. Wraps `zstandard`:

- `compress_file(src, dst, level, threads) -> dict` — streaming chunk loop, mirrors [backend/compress_db.py](../backend/compress_db.py).
- `decompress_file(src, dst) -> dict` — streaming.
- `is_zstd_file(path) -> bool` — magic-byte sniff (`28 b5 2f fd`).
- `resolve_threads(preset)` — maps `"single"|"half"|"all"` to int via `os.cpu_count()`.
- `CALIBRATION_PER_GIB: dict[int, dict]` — fitted from `compress_db.py` benchmark runs at levels 3/10/15/19/22.

Add `zstandard` to [backend/requirements.txt](../backend/requirements.txt).

### 1.3 R2 key conventions

Extend [backend/app/core/r2_storage.py](../backend/app/core/r2_storage.py):

- `COMBINED_DB_ZSTD_KEY = "globalservermap.db.zst"` constant.
- `archived_db_key(cid, *, compressed=False)`, `undo_replaced_key(cid, *, compressed=False)` — append `.zst` when requested.
- `head_artefact_with_format(raw_key) -> tuple[str, bool]` — return (existing_key, is_compressed) preferring `.zst`. Raises `FileNotFoundError` if neither exists.

### 1.4 Feature flag

Add `compress_artefacts` (default OFF) in [feature_flags.py](../backend/app/core/feature_flags.py). Single flag governs all four artefact types — no per-artefact toggles.

### 1.5 Settings shape

Single setting key `compression_settings`:
```json
{ "level": 10, "threads_preset": "half" }
```
- `level`: int 1..22, validated server-side.
- `threads_preset`: `"single" | "half" | "all"`, resolved at run time so the same setting works across deploys.

### 1.6 Admin endpoints

New `backend/app/routes/admin_settings.py`:

- `GET /api/admin/settings/compression` → `{ level, threads_preset, resolved_threads, cpu_count }`
- `PATCH /api/admin/settings/compression` → body `{ level, threads_preset }`
- `POST /api/admin/settings/compression/estimate` → returns `{ db_size_bytes, estimated_compressed_bytes, estimated_compress_seconds, estimated_decompress_seconds, ratio }`
- `GET /api/admin/system/cpu-info` → `{ cpu_count, presets: { single: 1, half: N//2, all: N } }`
- `GET /api/admin/settings/compression/status` → in-memory `_last_compress_run` snapshot
- `GET /api/admin/settings/compression/migration-status` → migration progress

---

## Phase 2 — Hook compression into write paths

### 2.1 Combined DB after approval (background, with raw fallback)

At [admin_contributions.py L251](../backend/app/routes/admin_contributions.py#L251), after `r2_storage.upload_file(combined_tmp, COMBINED_DB_KEY)` and `invalidate_combined_db_cache()`:

- If flag ON: hand the local merged temp file to a daemon worker `compress_combined_db_async(local_path, source_etag)`. Worker compresses, uploads `.zst` with `x-amz-meta-source-etag`, then unlinks. Single in-process `_combined_compress_lock` (latest-wins).
- Failure logged but never propagates: raw upload already succeeded.

### 2.2 Per-contribution archive (async with leak sweeper)

Replace `r2_storage.move_object(pending_key, archived_key)` at [contribute_r2.py L2325-L2331](../backend/app/routes/contribute_r2.py#L2325-L2331):

1. If flag OFF: today's `move_object` (free, instant).
2. If flag ON: enqueue `compress_pending_to_archive_async(cid)`:
   - Download `pending_key` to temp.
   - Compress to `archived/<id>.db.zst`.
   - Upload `.zst` with `x-amz-meta-source-key=<pending_key>`.
   - Verify upload, then `delete_object(pending_key)`.

**Leak sweeper**: hourly periodic task (extend [cleanup_history.py](../backend/app/tasks/cleanup_history.py)) re-enqueues any pending objects without matching archives beyond a 1-hour grace. Startup hook resumes after restart.

### 2.3 `undo/<id>.replaced.db` (async)

Same worker queue, written as `undo/<id>.replaced.db.zst`. `undo/<id>.added.bin` left raw.

### 2.4 Backups (foreground, blocking)

[weekly_backup.py](../backend/app/tasks/weekly_backup.py) and [admin_backups.py](../backend/app/routes/admin_backups.py):
- Flag OFF: existing `r2_storage.copy_object(...)` server-side copy (zero egress).
- Flag ON: download via `get_combined_db_cached()`, compress to temp `.zst`, upload to `backups/backup-<key>.db.zst`.

Restore detects `.zst` extension and decompresses to a temp before promoting.

### 2.5 Reader fallback for combined DB

Extend `get_combined_db_cached()` in [contribute_r2.py L261-L315](../backend/app/routes/contribute_r2.py#L261-L315):

1. HEAD `COMBINED_DB_KEY` → raw ETag (truth source).
2. If local cache ETag matches → return cached path.
3. Cache miss + flag ON: HEAD `.zst`, verify `x-amz-meta-source-etag == raw_etag`. If yes → download `.zst`, decompress, write raw_etag to sidecar.
4. Else → today's raw download.

`invalidate_combined_db_cache()` also drops `cache_path + ".zst"` files.

### 2.6 Reader path for backups + archives

- **Restore** ([admin_backups.py](../backend/app/routes/admin_backups.py)): detect `.zst` suffix, stream-decompress.
- **Revert** ([admin_contributions.py revert_contribution](../backend/app/routes/admin_contributions.py#L112)): use `head_artefact_with_format` for `archived/<id>.db` and `undo/<id>.replaced.db`.

---

## Phase 3 — Eager migration on flag flip OFF→ON

One-shot background `migration_runner` driven by Postgres queue (use `SELECT id FROM contributions WHERE preview_retained_until > NOW()` — not R2 listing):

1. For each archived contribution: download `.db` → compress → upload `.zst` → delete `.db`. Atomic per file.
2. Same for `undo/<id>.replaced.db`.
3. Honours `heavy_compute_enabled` kill switch.
4. Status via `GET /api/admin/settings/compression/migration-status`.

Reverse direction (ON→OFF) does **not** rehydrate — readers permanently support both formats.

---

## Phase 4 — Frontend

### 4.1 Toggle on the feature flags page

In [AdminFeatureFlagsPage.tsx](../frontend/src/pages/admin/AdminFeatureFlagsPage.tsx):
- Add `compress_artefacts` to operational switches (Archive icon).
- `whenOn`: "Combined map DB, backups, and per-contribution archives are compressed with zstd before upload."
- `whenOff`: "Artefacts stored uncompressed (today's behaviour). Existing compressed files remain readable."
- Confirm dialog on enable explaining eager migration.

### 4.2 Settings panel

`<CompressionSettingsPanel />` mounted when flag is ON (mirrors `<HeavyComputeRunner />` precedent at [L258-L269](../frontend/src/pages/admin/AdminFeatureFlagsPage.tsx#L258-L269)):

- Slider 1..22 with snap markers `Fast (3) · Balanced (10) · High (15) · Max (22)`.
- Three-button radio for thread presets, labelled with resolved CPU count.
- Live preview card debounced 300 ms, calls estimate endpoint.
- Save button only when dirty.
- Status line for last compression run + migration progress.

### 4.3 API helpers

Six new helpers + TS types in [api.ts](../frontend/src/lib/api.ts). React Query namespace `["admin","compression-settings"]` separate from flags cache.

---

## Phase 5 — Verification

1. Schema migration check (`\d app_settings`).
2. Settings round trip via curl + UI.
3. **Estimate accuracy**: compare endpoint vs actual `compress_db.py` runs at `(level=3, threads=single)` and `(level=19, threads=all)`; require ±25% accuracy.
4. Approval flag OFF → no `.zst` produced.
5. Approval flag ON → response unaffected; combined `.zst` appears within 1–5 min with matching ETag; `archived/<id>.db.zst` appears within ~30 s and pending is deleted.
6. Cache-miss reader uses `.zst` (visible in logs).
7. Stale archive falls back to raw.
8. Background combined compression crash → startup hook + sweeper recover.
9. Per-contribution archive crash recovery via leak sweeper.
10. Backup with flag ON → `.db.zst` round-trips through restore.
11. Backup with flag OFF → still uses zero-egress copy.
12. Revert with mixed-format archives — both succeed.
13. Eager migration converts all pre-existing archives, status reaches `phase=done`.
14. UI debounce + label reactivity.
15. `heavy_compute_enabled` kill switch pauses + resumes the migration cleanly.

---

## Relevant files

**New:**
- `backend/app/core/compression.py`
- `backend/app/routes/admin_settings.py`
- `backend/app/tasks/compress_workers.py`
- `frontend/src/components/admin/CompressionSettingsPanel.tsx`

**Modified backend:**
- [backend/app/core/database.py](../backend/app/core/database.py) — `app_settings` DDL + helpers.
- [backend/app/core/feature_flags.py](../backend/app/core/feature_flags.py) — register `compress_artefacts`.
- [backend/app/core/r2_storage.py](../backend/app/core/r2_storage.py) — `COMBINED_DB_ZSTD_KEY`, `compressed=` parameter, `head_artefact_with_format` helper.
- [backend/app/routes/admin_contributions.py L240-L260](../backend/app/routes/admin_contributions.py#L240-L260) — background combined worker; revert uses `head_artefact_with_format`.
- [backend/app/routes/contribute_r2.py L261-L315, L2325](../backend/app/routes/contribute_r2.py#L261-L315) — extend cache miss path; conditional async-compress for archive.
- [backend/app/tasks/weekly_backup.py](../backend/app/tasks/weekly_backup.py), [backend/app/routes/admin_backups.py](../backend/app/routes/admin_backups.py) — flag-gated branching.
- [backend/app/tasks/cleanup_history.py](../backend/app/tasks/cleanup_history.py) — find/delete whichever extension exists.
- [backend/app/main.py](../backend/app/main.py) — startup hooks for archive sweeper + migration resume.
- [backend/requirements.txt](../backend/requirements.txt) — `zstandard`.

**Modified frontend:**
- [frontend/src/pages/admin/AdminFeatureFlagsPage.tsx](../frontend/src/pages/admin/AdminFeatureFlagsPage.tsx)
- [frontend/src/lib/api.ts](../frontend/src/lib/api.ts) — six helpers + types.

**Docs:**
- [docs/users/feature-flags.md](../docs/users/feature-flags.md)
- [docs/multiplayer/storage-and-data-flow.md](../docs/multiplayer/storage-and-data-flow.md)

---

## Decisions

- New `app_settings` JSONB table; `feature_flags` stays bool-only.
- Single flag `compress_artefacts` for all artefacts.
- Asymmetric storage rule (combined = raw + `.zst` with fallback; backups + archives = single-form).
- Combined DB: async background after raw upload (admin doesn't wait).
- Per-contribution archive: async background with hourly leak sweeper.
- `undo/<id>.replaced.db` compressed; `undo/<id>.added.bin` left raw.
- Backups: foreground blocking — admin understands "create backup" is slow.
- Pre-existing archives: eagerly migrated on OFF→ON; ON→OFF does not rehydrate.
- Filename convention: append `.zst`.
- Estimates: backend endpoint scaling stored calibration by current R2 DB size.
- Threads: three fixed presets, labelled with resolved CPU count.
- Algorithm: zstd only.
- Out of scope: VACUUM-before-upload, sqlite-zstd, compression of `pending/<id>.db` and `undo/<id>.added.bin`.

---

## Further considerations

1. **Calibration drift on Render's 0.5-CPU starter tier** — ship two tables (`local`, `render`) selected by env var.
2. **First flag-flip combined DB has no `.zst`** — also enqueue a one-shot combined compression on flag flip.
3. **CPU contention** — single shared compression executor (one-at-a-time semaphore) with combined-DB job at higher priority.
4. **Cleanup task interaction**: thread `compressed=` through [cleanup_history.py](../backend/app/tasks/cleanup_history.py).
5. **R2 listing performance during migration**: drive from Postgres rather than R2 listing.
