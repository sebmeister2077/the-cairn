# Contribute

> Frontend route: `/multiplayer/contribute`
> Page: [frontend/src/pages/ContributePage.tsx](../../frontend/src/pages/ContributePage.tsx)
> Backend: [backend/app/routes/contribute_r2.py](../../backend/app/routes/contribute_r2.py) (mounted as `contribute` in [backend/app/main.py](../../backend/app/main.py))

This is the pipeline that turns user-uploaded `.db` files into new tiles on the shared TOPS map. It is the only write path into `globalservermap.db`.

## Pipeline overview

```
[ User has a .db ]
        │
        │  1. Request presigned upload URL  (POST /contribute/upload-url)
        │  2. PUT the .db directly to R2     (browser → R2)
        │  3. Tell the backend it's there   (POST /contribute/complete)
        ▼
[ Pending — visible to admin and owner ]
        │
        │  Admin reviews preview PNG
        │
        ├─ Approve  ──► merge into globalservermap.db, regenerate affected
        │              chunk caches in background, archive the .db.
        ├─ Reject   ──► delete .db + metadata, no merge.
        └─ Owner withdraws ──► delete .db, anonymise contributor, mark withdrawn.
```

There is intentionally no auto-merge. Every contribution must be approved by an admin before any tile lands in the canonical DB.

## Concurrency: the global map lock

Every mutation of `globalservermap.db` (approve, and — in later phases — revert and restore) acquires a row in the Supabase `map_lock` table before downloading the combined DB. The lock has a 10-minute TTL so a crashed worker self-clears, and is keyed by an opaque token so only the holder can release it.

If a second admin tries to approve while a merge is already in progress, the second call returns **HTTP 423 Locked** instead of racing the first writer.

Helpers live in [backend/app/core/database.py](../../backend/app/core/database.py): `acquire_map_lock(action)`, `release_map_lock(token)`, and the `with_map_lock(action)` context manager. Admins can inspect the current holder via `GET /api/admin/map-lock` and force-release a stuck lock via `POST /api/admin/map-lock/force-release` (audited as `lock.force_release`).

## Feature flags

User-visible contribution features beyond the legacy gap-fill flow are gated by Supabase-backed feature flags in the `feature_flags` table. Backend reads go through [`backend/app/core/feature_flags.py`](../../backend/app/core/feature_flags.py) (`is_feature_enabled(key)`, 30 s TTL cache). Disabled flags make their endpoint return **404** so the feature is invisible to non-admins.

Flag keys (all default off):

| Key | Phase | Effect when on |
|---|---|---|
| `match_score` | 1 | Async match-percentage scoring on pending uploads |
| `region_overwrite` | 2 | Region-restricted updates (gated additionally by `region_overwrite` permission) |
| `public_history` | 3 | Approved contributions visible to all read keys for 14 days |
| `weekly_backups` | 4a | Scheduled weekly snapshots of the combined map |
| `per_contribution_revert` | 4b | Admin "Revert" action on approved contributions |
| `backup_restore` | 4a | TOTP-gated restore from a weekly snapshot |

Flags are managed from the **admin Feature Flags panel** that renders at the top of the contribute page when the current key is admin. Toggles are written to `admin_audit_log` as `feature_flag.toggle`.

## Permissions and rate limiting

Three coarse tiers apply (unchanged):

- **Read API key** (any valid key): can view the contribute info page (totals, pending list with friendly previews).
- **Read & Contribute API key** (`verify_contribute_permission`): can request upload URLs, complete uploads, and submit contributions. The frontend hides the form entirely if `getStoredCanContribute()` is false.
- **Admin API key** (`settings.ADMIN_API_KEY`, checked by `_verify_admin_key`): can approve/reject. Admins also bypass cooldown and per-user-pending limits.

In addition, granular per-key permissions live in `api_keys.extra_permissions` (JSONB):

| Permission | Used by | Set via |
|---|---|---|
| `region_overwrite` | Phase 2 region-update endpoints | `PATCH /api/admin/users/{key}/permissions` |

The admin "Permissions" button on each user row in the **Manage → Users** page exposes a dialog with toggles for the supported permissions. Effective permission is `is_admin OR extra_permissions[name] == true`. Backend helpers are `verify_permission(key, name)` and `require_permission(name)` in [backend/app/auth.py](../../backend/app/auth.py).

Non-admin contributors are limited to:

- **One pending contribution at a time.** A second upload while the first is still pending is rejected with HTTP 429 ("Withdraw it before submitting another").
- **One approved contribution per `CONTRIBUTION_COOLDOWN_DAYS = 7`.** The clock starts at the moment of approval, not submission. Until then the upload-url endpoint returns 429 with the next allowed timestamp.

These limits exist because every approval triggers a partial regeneration of the four resolution levels, which is the heaviest operation in the whole system. A flood of small contributions from a single user would queue up an unbounded amount of regen work.

The status is exposed via `_get_contribution_status` and surfaced on the page so the user understands *why* the upload form is disabled. `cooldown_reason` is one of `"pending"`, `"cooldown"`, or null.

## Validation

`_validate_upload(path)` runs on every uploaded `.db`:

1. The file is a SQLite database.
2. The `mappiece` table exists. Anything else is rejected as "not a valid Vintage Story map database".
3. `mappiece` has at least one row. An empty `.db` is explicitly rejected — it's almost always a user mistake (uploaded the wrong file, opened a world they never explored), and lets us avoid creating empty pending records.

The function returns the tile count, which is stored on the contribution record so the admin sees it before deciding to preview.

In addition to validation, the upload path enforces:

- A hard size cap (`MAX_UPLOAD_SIZE`), checked **mid-stream**. A 5 GB upload is killed at the first chunk that pushes us over.
- A `.db` extension on the filename. Just a sanity check at the upload-URL stage; the actual content check is the SQLite open.

## The two upload paths

### Presigned-URL path (preferred)

Used by the page in normal operation. Three steps:

1. `POST /contribute/upload-url` — backend mints a short-lived (`UPLOAD_URL_TTL_SECONDS = 15 min`) presigned PUT URL into R2 at `pending/<contribution_id>.db`. No file has touched the backend yet.
2. Browser PUTs the file directly to R2.
3. `POST /contribute/complete` — backend downloads from R2, runs `_validate_upload`, writes the contribution row to Supabase, and the contribution becomes "pending".

This path exists because Render's free-tier ingress to FastAPI is slow and capped, but R2 PUTs are not. Big map DBs (hundreds of MB) finish in a fraction of the time a multipart-through-FastAPI upload would take. It also keeps the FastAPI process from holding a giant request open.

### Legacy direct upload path

`POST /contribute` accepts the raw body, streams it to a local temp file with the size cap, and uploads to R2 from there. Kept for clients that can't do presigned PUTs (CLI tools, older builds). Functionally equivalent once the file lands in R2.

Both paths converge at `_finalize_uploaded_contribution`, which is the single place where:

- R2 object size is verified.
- `_validate_upload` is run on a freshly downloaded local copy.
- The Supabase row is created via `db.create_contribution`, including `submitted_by_key` (so withdraw can verify ownership).

## Pending list and previews

`GET /contribute/info` is the dashboard data feed:

```json
{
  "map_id": "...",
  "total_tiles": 123456,
  "pending":   [...],
  "withdrawn": [...],
  "approved":  [last 20],
  "is_admin":  true|false,
  "can_contribute": ...,
  "cooldown_reason": "pending" | "cooldown" | null,
  "pending_contribution_id": "...",
  "next_allowed_at": "...",
  "cooldown_days": 7
}
```

Each pending row includes:

- `preview_image_url` — an authenticated route that streams the PNG through the backend.
- `preview_signed_url` — a 3-day presigned R2 URL pointing directly at the cached preview blob.

The frontend tries `preview_signed_url` first and falls back to `preview_image_url` if the signed URL is missing or fails. The reason: the backend route is authenticated and goes through Render, while the signed URL is direct CDN. Direct CDN is dramatically faster for the admin scrolling through a list of pending previews. The signed URL is only handed out when an admin or the owner actually loads the page, so no privacy is given up for a public viewer.

`GET /contribute/preview/{id}` is the rendering and caching endpoint:

- If `pending/<id>.preview.png` already exists in R2, it's returned with `X-Preview-Cache: hit`.
- Otherwise it downloads `globalservermap.db` and the pending `.db` to temp files, runs `_render_preview`, uploads the result back to R2 (so the next request is a hit), returns the PNG with `X-Preview-Cache: miss`.

`_render_preview` is the same renderer used elsewhere with one twist: tiles whose `position` is in the upload but **not** in the combined map are tinted green (`R *= 0.5; G = min(G*0.5 + 128, 255); B *= 0.5`). This makes "what is this contribution actually adding" visually obvious to the admin, so they can spot e.g. "this is just a tiny patch in an already-mapped area" vs. "this is a whole new continent".

The preview is rendered at `max_dimension = 2048`. We deliberately don't render full detail here — the admin needs an overview, not a usable map.

## Match-percentage scoring (informational only)

Each pending contribution is scored against the canonical combined map so the admin reviewing the queue can spot **obviously-wrong files** (other-world DBs, swapped sqlite databases) without downloading them. **The score never gates approval** — it's a hint on the dashboard, not a verdict. Approve/reject behaviour is unchanged.

The score is gated by the [`match_score` feature flag](#feature-flags). When the flag is off, no jobs are enqueued and `/contribute/info` returns `match_score_enabled: false` so the frontend hides the badge entirely. The recompute endpoint also returns 404 in this state.

### How it works

1. **`POST /contribute/complete` enqueues the job.** It writes `contributions.match_score_status = 'pending'` and calls `match_score_task.start_job(cid)`. The `/complete` route returns immediately — scoring is never on the request path.
2. **The async worker** ([backend/app/tasks/match_score.py](../../backend/app/tasks/match_score.py)) is a single in-process thread. It claims one row at a time using `claim_pending_match_score_job()` (`SELECT ... FOR UPDATE SKIP LOCKED`), so multiple uvicorn workers race safely.
3. The worker downloads the combined map and the pending DB to temp files and runs `_compute_match_score(combined_path, pending_path)` in [backend/app/routes/contribute_r2.py](../../backend/app/routes/contribute_r2.py).
4. **`_compute_match_score`** does the actual work:
   - Counts `pending_total = SELECT COUNT(*) FROM mappiece` on the pending DB.
   - `ATTACH DATABASE` the pending DB onto the combined connection and inner-joins on `position`. This streams overlapping rows in one query.
   - For each overlapping tile, samples **10 deterministic-pseudo-random pixels + the center pixel (index 528)** from both blobs using `mapdb._sample_n_pixels(blob, 10, seed=position)`. The seed-from-position guarantees the same tile picks the same pixels every run, which makes the score reproducible across recomputes.
   - A pixel is considered a match if its R/G/B channels are within `±6` (anti-aliasing tolerance). Pixels with `alpha=0` on either side are treated as no-data and dropped from the denominator.
   - A tile counts as "similar" iff at least 8 of 11 (or the proportional threshold for fewer non-zero-alpha samples) match.
5. **Result persistence.** On success the worker calls `set_match_score_ready(cid, result)` with the JSON payload `{tile_overlap_pct, pixel_similar_pct, overlap_count, pending_total, tiles_scanned, tiles_similar}`. On exception it calls `set_match_score_failed(cid, reason)`.
6. **Retry budget.** `MATCH_SCORE_MAX_ATTEMPTS = 3` in the DB layer caps automatic retries — each `set_match_score_pending` call increments `match_score_attempts`. A row that exceeds the cap is left in `failed` until an admin clicks the **Recompute** button on the pending card. That button hits `POST /contribute/{id}/recompute-match-score`, which resets `match_score_attempts = 0` and re-enqueues the job. Admin-only, also gated by the feature flag.
7. **Startup recovery.** `main.py` calls `match_score_task.kick_on_startup()` so any rows left `pending` from a previous process get drained on the next boot. Set `MATCH_SCORE_DISABLE_STARTUP_KICK=1` to opt out (used by tests).

### Frontend display

`GET /contribute/info` projects the per-pending result into a flat field:

```jsonc
{
  "match_score_enabled": true,
  "pending": [
    {
      "id": "...",
      "match_score": {
        "status": "ready",            // or "pending" | "failed"
        "tile_overlap_pct": 97.3,
        "pixel_similar_pct": 91.0,
        "overlap_count":  4_812,
        "pending_total":  4_945
      }
    }
  ]
}
```

[frontend/src/pages/ContributePage.tsx](../../frontend/src/pages/ContributePage.tsx) renders a `MatchScoreBadge` next to each pending row using these thresholds:

| `pixel_similar_pct` | Badge | Meaning |
|---|---|---|
| ≥ 80 | green "Looks like our map" | safe to skim and approve |
| < 20 | orange "May be wrong file" | likely wrong-world DB — open the preview |
| 20–80 | grey "Partial match" | mixed — review carefully |
| `status != 'ready'` | spinner / "Match score unknown" | not yet scored or job failed |

When at least one row has `status: 'pending'` the React Query `refetchInterval` is set to 5 s so the badge updates automatically while the worker grinds through its queue.

### Database columns

Added to `contributions` by `_MIGRATIONS_SQL`:

| Column | Type | Notes |
|---|---|---|
| `match_score_status` | `TEXT` | `'pending'` / `'ready'` / `'failed'` / `NULL` (legacy / flag was off at submit time) |
| `match_score_json` | `JSONB` | result payload on `ready`, `{reason}` on `failed`, `NULL` otherwise |
| `match_score_attempts` | `INT NOT NULL DEFAULT 0` | bumped each enqueue; capped at `MATCH_SCORE_MAX_ATTEMPTS = 3` |

Plus a partial index `idx_contributions_match_score_status` on rows where `status = 'pending'` so the worker's `claim_pending_match_score_job` query is O(1).

## Withdraw (owner-initiated)

`POST /contribute/{id}/withdraw` is the owner-only escape hatch. It:

1. Verifies the contribution is still `pending` (anything else returns 409).
2. Verifies `submitted_by_key == api_key`. Other users — even admins, via this endpoint — get 403.
3. Enforces the **per-ISO-week withdraw cap** (`WITHDRAW_LIMIT_PER_WEEK`, default 3). Non-admins over the limit get HTTP 429 with the next allowed timestamp (Monday 00:00 UTC of the next ISO week). Admins are exempt. The current week's count and `withdraw_next_allowed_at` are also surfaced on `/contribute/info` so the frontend can pre-emptively disable the Withdraw button.
4. Deletes the `.db` from R2 immediately — withdraw is privacy-driven, the raw map data never sticks around.
5. **If a preview was generated**, *moves* `pending/<id>.png` to `history/<id>.png` and stamps `preview_retained_until = now + HISTORY_RETENTION_DAYS` (Phase 3). The withdrawn entry then appears in the public history grid with a `[Withdrawn]` badge for the same window as approved contributions. This cuts down on the "user keeps re-uploading the same wrong thing" support load while still letting the user re-submit.
6. Marks the row `status = 'withdrawn'` and anonymises the contributor name in Supabase (`db.withdraw_contribution`).

The row stays visible in `withdrawn` so the dashboard makes it clear what happened, and so an admin can see "user withdrew before review" patterns. There is no "un-withdraw" — the user has to upload again, which then resets the cooldown the way any new submission does.

## Region-restricted updates (Phase 2)

The legacy contribution flow is **gap-fill only**: an upload can add new tiles to the combined map, but it can never overwrite an existing tile. Phase 2 adds an opt-in **region overwrite** mode where a contributor draws a rectangle on the map and approval replaces every in-region tile with the upload's version (in-region positions outside the upload are *not* deleted — they are simply left unchanged). Out-of-region tiles in the upload are dropped.

### Trust model

Region overwrite is dangerous (it can wipe out other contributors' work inside the box) so it is gated by **two independent checks plus a tile-area cap**:

1. **Feature flag** `region_overwrite` must be on. When off, all Phase-2 endpoints return **404** and the picker is hidden in the UI.
2. The caller must be **admin** *or* hold the per-key **`region_overwrite` permission** (toggled from the admin Users panel; the permission is in `auth.VALID_KEY_PERMISSIONS`). Non-eligible callers get **403**.
3. Non-admin callers cannot exceed `MAX_REGION_TILES_NON_ADMIN` tiles (default **65 536** == 256×256 tiles == 8192×8192 blocks). Admins are uncapped. Over-cap requests return **400** with the cap reported in `detail`.

The frontend mirrors this server check by reading `region_overwrite_enabled`, `can_use_region_overwrite`, and `region_tile_cap_non_admin` from `/contribute/info` and only renders the [`ContributionRegionPicker`](../../frontend/src/components/ContributionRegionPicker.tsx) when both flags are true.

### Wire-format

The four bounds are **inclusive world-block coordinates** sent on `/contribute/complete` as `update_region_min_x`, `update_region_max_x`, `update_region_min_z`, `update_region_max_z`. They are normalised (`min/max` swapped if reversed) and validated as all-or-none — a partial set returns 400. Bounds are persisted on the row in the four nullable columns of the same name (added by the migration in `core/database.py`).

### Pipeline

Region overwrite reuses the entire existing pending → approve → audit pipeline; the only behavioural changes are inside [`_merge_into_combined`](../../backend/app/routes/contribute_r2.py) and the surrounding region helpers:

1. **Upload-complete** — `_check_region_eligibility(api_key, region)` runs flag/permission/cap checks. If they pass, the bounds are persisted via `db.set_update_region(cid, region)`. The route then re-streams the pending file to count in-region tiles. **Empty in-region count = 400**, the contribution is rolled back (Supabase row dropped, R2 object deleted) so a misclick can't reserve the user's pending slot. The response includes `update_region` and `tiles_in_region` so the picker can show "0 of N tiles fall inside the region" before the user even tries to approve.
2. **Pending list** — `/contribute/info` always exposes `update_region_mode` (`"overwrite"` or `"gap_fill"`) on every pending row, but the actual `update_region` bounds are **redacted from non-admin/non-owner viewers** (so a malicious read-only key can't enumerate where contributors are working). The history rows are public domain so they always include the bounds.
3. **Region preview endpoints** (admin-or-owner only):
   - `POST /contribute/region-preview` — runs against an already-uploaded pending file. Returns `{tiles_in_region, tiles_total, region_tile_area, region_tile_cap}` so an admin can sanity-check "is the user trying to overwrite anything they actually mapped?" before approving.
   - `GET /contribute/preview-region/{id}?side=before|after` — returns a pair of cached PNGs cropped to the region. The "after" image tints **green** for newly added tiles and **orange** for tiles being overwritten. Both PNGs are R2-cached under `pending/<id>.before.png` / `pending/<id>.after.png` and rendered lazily on first request via `_render_region_before_after`. The frontend [`ContributionBeforeAfter`](../../frontend/src/components/ContributionBeforeAfter.tsx) component fetches both at once and shows them side-by-side under the existing pending preview when the row is in overwrite mode.
4. **Approve** — `/contribute/{id}/approve` reads back `db.get_update_region(cid)` and passes it to `_merge_into_combined(..., region=region, replaced_db_path=replaced_tmp_path)`. The merge then:
   - filters pending positions with `WHERE (position & POSITION_MASK) BETWEEN tx_min AND tx_max AND (position >> POSITION_BITS) BETWEEN tz_min AND tz_max` so out-of-region rows are silently dropped;
   - uses `INSERT OR REPLACE` (and bookkeeping `UPDATE`s) instead of `INSERT OR IGNORE` so existing tiles are clobbered;
   - captures every overwritten `(position, old_data)` pair into a temporary SQLite file which is then uploaded as `undo/<id>.replaced.db` so the contribution stays revertable (Phase 4b — see below).
   - emits `tiles_replaced` alongside `tiles_added` in the merge stats and the `contribution.approve` audit log.
5. **Match score** — `_compute_match_score_for_contribution` now passes the persisted region down so the score reflects "how well does the in-region subset match the existing combined map?" instead of being skewed by ignored out-of-region rows.
6. **Cleanup** — reject, withdraw, and approve all delete `pending/<id>.before.png` / `pending/<id>.after.png` from R2 so we never leave region previews dangling.

### Revert interaction (Phase 4b)

Region-overwrite contributions **are revertable**: the `undo/<id>.replaced.db` blob captured during approve is exactly what the existing Phase-4b revert flow needs. When a region revert runs, `db.list_later_region_overwrites(cid, affected_bounds)` is now able to find real conflicts (the four `update_region_*` columns finally exist), so a region revert that would step on a *later* region overwrite returns the standard cascading-conflict warning instead of silently reverting through the conflict.

A region overwrite is marked `revert_supported = false` only if `tiles_added + tiles_replaced > REVERT_ADDED_BIN_MAX_BYTES / 8` — same cap as the legacy gap-fill flow.

## Approve (merge)

`POST /contribute/{id}/approve` (admin only). This is the only path that mutates `globalservermap.db`. The flow:

1. Download `globalservermap.db` and `pending/<id>.db` to local temp files.
2. **Capture the affected world-block bounds** from the pending DB *before* merging — we need to know which TOPS-map cache chunks to invalidate, and that's a function of the *new* tiles. Falls back to `None` (full regen) if the bounds query fails.
3. **Merge** with `_merge_into_combined`:
   - For each `(position, data)` in the pending DB, insert into combined if not already present (`INSERT` on conflict skips). Existing tiles are *never* overwritten — first contribution to cover an area wins. This is intentional: avoid a late contribution silently degrading already-good data.
   - `blockidmapping` rows are merged with `INSERT OR IGNORE`. We keep them so future renderers can use them, but block-id collisions are ignored on the assumption that all VS clients agree on default block IDs.
4. Re-upload the merged combined DB to R2 (atomic from the viewer's perspective — the next presigned-URL fetch sees the new bytes).
5. Update Supabase: `mark_approved` flips `status` and writes the merge stats; `set_cached_tile_count` updates the dashboard total without reading the DB; `set_tops_map_stats` refreshes the cached stats blob the TOPS-map page reads.
6. **Enqueue background regeneration** of every configured resolution level via `start_map_generation_job(..., affected_bounds=...)`. The request is persisted to the `regen_queue` Postgres table and the worker is spawned if it isn't already alive. With bounds, only the chunks intersecting the contributed area re-render; existing chunks elsewhere are reused. With no bounds, every chunk is re-rendered. **Approvals that land while a worker is mid-pass are not lost** — the worker drains the queue again before exiting and runs a second pass that includes their bounds. See [TOPS Map > Background regeneration](./tops-map.md#background-regeneration).
7. **Archive** the original `.db`: `move_object` the R2 object from `pending/<id>.db` to the archive prefix. If the move fails, approval still succeeds and a warning is included in the response — losing the archive copy is not worth losing the merge.
8. **Promote the preview PNG** (Phase 3): `move_object` from `pending/<id>.png` to `history/<id>.png` and stamp `preview_retained_until = now + HISTORY_RETENTION_DAYS` (90 days for admin-uploaded contributions, 14 days otherwise). The contribution then appears in the public Recent Contributions grid until the cleanup sweeper drops it. Promotion is best-effort — if the move fails, the pending preview is deleted instead so we never leak it under the old key.
9. Audit the action via `accounts_db.audit_log("contribution.approve", target=id, metadata=stats)`.

The merge is **not transactional across R2 + Supabase**. If the R2 upload of the new combined DB fails after the local merge succeeds, the next approval will operate on the stale R2 copy. In practice this hasn't been a problem because the merge is idempotent — re-applying a contribution skips all already-present tiles.

## Reject

`POST /contribute/{id}/reject` (admin only):

1. Confirms the contribution is `pending`.
2. Deletes `pending/<id>.db` and `pending/<id>.preview.png` from R2.
3. Calls `db.delete_contribution` to hard-delete the metadata row.

Unlike withdraw, rejection is destructive. There's no "withdrawn" trace left for the user to see. We do this rather than a soft "rejected" status because the rejection reason isn't stored anywhere, so a "rejected" badge with no explanation would just confuse the user.

## Public contribution history (Phase 3)

Gated by the [`public_history` feature flag](#feature-flags). When enabled:

- Approved contributions stay visible to **all read keys** for `HISTORY_RETENTION_DAYS = 14`. Admin-uploaded contributions are kept for `ADMIN_HISTORY_RETENTION_DAYS = 90` so the team has a longer audit window. Both values are env-overridable.
- Withdrawn contributions whose preview was already generated also surface here with a `[Withdrawn]` badge. The contributor name is replaced with `[Withdrawn]` and the thumbnail is grayscale.
- Each row carries a fresh 3-day presigned URL pointing at `history/<id>.png` (regenerated on every `/contribute/info` request — the URL itself never has to live more than one page load).

`/contribute/info` returns:

```json
{
  "history": [
    { "id": "...", "status": "approved|withdrawn",
      "contributor": "...", "tile_count": ..., "tiles_new": ...,
      "approved_at": "...", "withdrawn_at": "...",
      "preview_signed_url": "https://...", "is_mine": true|false }
  ],
  "history_total":  <int>,
  "history_window_days": 14,
  "public_history_enabled": true,
  "withdraw_limit_per_week": 3,
  "withdrawals_used_this_week": <int>,
  "withdraw_next_allowed_at": "..." | null
}
```

Non-admins get the last `HISTORY_RETENTION_DAYS` worth (capped at 100). Admins see the full retained set, paginated via `?history_limit=&history_offset=` query args (default 50, max 200).

### Storage layout

| R2 prefix | Lifecycle |
|---|---|
| `pending/<id>.db` | deleted on approval (moved to `archived/`) or rejection / withdrawal |
| `pending/<id>.png` | moved to `history/<id>.png` on approval / withdraw-with-preview, deleted on rejection |
| `history/<id>.png` | retained until `preview_retained_until` elapses, then swept |
| `archived/<id>.db` | retained alongside the preview, swept together |

We deliberately **don't use an R2 lifecycle rule** — they're prefix-wide and would force a single TTL for everyone, which is incompatible with admin-vs-user retention and with the withdraw → preserved-preview behaviour. Cleanup is application-side only.

### Cleanup task

[`backend/app/tasks/cleanup_history.py`](../../backend/app/tasks/cleanup_history.py) runs on a daemon `threading.Timer` started from the FastAPI lifespan. It re-arms itself every `HISTORY_CLEANUP_INTERVAL_SECONDS` (default 24 h) and on each tick:

1. `db.list_expired_history_contributions(limit=500)` returns rows whose `preview_retained_until <= now()`.
2. Each row's `history/<id>.png` and `archived/<id>.db` are deleted from R2 (idempotent — missing keys are silently ignored).
3. `db.set_preview_retained_until(id, None)` clears the column so the next sweep skips the row.

`run_now()` exposes the same logic synchronously for tests and ad-hoc admin invocation.

## Backups & restore (Phase 4a)

The combined map .db is snapshotted to R2 on a weekly cadence so a bad merge or accidental data loss can be undone. Both the snapshot loop and the restore endpoint are gated by feature flags so they can be enabled or killed without redeploying.

### Storage layout

All snapshots live under the `backups/` prefix in the same R2 bucket:

| Pattern | Source | Naming |
|---|---|---|
| `backups/backup-YYYY-Www.db` | Scheduled (one per ISO calendar week) | ISO 8601 — week 01 contains the first Thursday of the year, weeks always start Monday |
| `backups/backup-YYYY-Www-manual-<unix>.db` | Admin-triggered (`POST /api/admin/backups/create`) | Same week prefix plus a Unix timestamp to disambiguate multiple snapshots in one week |

Cleanup is application-side only (no R2 lifecycle rule, because lifecycles are prefix-wide and would conflict with per-snapshot retention). The cleanup pass keeps `BACKUP_KEEP_SCHEDULED` newest scheduled snapshots and `BACKUP_KEEP_MANUAL` newest manual snapshots and deletes the rest. Defaults: 4 scheduled + 8 manual.

### Scheduler

[`backend/app/tasks/weekly_backup.py`](../../backend/app/tasks/weekly_backup.py) runs on a daemon `threading.Timer` started from the FastAPI lifespan. It re-arms every `BACKUP_CHECK_INTERVAL_SECONDS` (default 1 h) and on each tick:

1. If the `weekly_backups` flag is on and the current ISO week's scheduled key does not yet exist in R2, R2 server-side `copy_object` clones `globalservermap.db` into `backups/backup-YYYY-Www.db`. No download — atomic and free.
2. Run `cleanup_old_backups()` to trim each kind to its retention.

The scheduler ticks even when the flag is off; it just no-ops, so flipping the flag on takes effect within one tick.

### TOTP 2FA gate

Restore is destructive, so the endpoint requires a 6-digit RFC 6238 TOTP code from the calling admin's enrolled authenticator app (Google Authenticator / Authy / 1Password / Bitwarden, …).

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/totp/status` | Whether the current admin has enrolled |
| `POST /api/admin/totp/enroll` | Generate a fresh secret + `otpauth://` URI; held in memory until confirmed |
| `POST /api/admin/totp/confirm` | Persist the encrypted secret if the supplied 6-digit code matches |

Storage: `api_keys.totp_secret_encrypted` (Fernet-encrypted with `TOTP_ENCRYPTION_KEY`) + `totp_enrolled_at`. The plaintext secret only exists in RAM during enrolment and verification. Verification (`auth.verify_totp`) allows ±1 step (30 s on each side) for clock skew, caches successful `(key, code)` pairs for 90 s to block replay, and 429-throttles after 5 bad codes in 5 minutes.

If `TOTP_ENCRYPTION_KEY` is not set, enrolment and restore both return 503 `totp_not_configured`.

### Restore endpoint

`POST /api/admin/backups/restore` (admin only). Body: `{ key, confirm: true, totp_code }`. Flow:

1. `weekly_backups` flag must be on (else 404). `backup_restore` flag must be on (else 404).
2. The supplied `key` must exist under `backups/`.
3. `auth.require_totp(api_key, totp_code)` validates the code (401 `totp_required`, 401 `invalid_totp`, 429 `totp_throttled`).
4. `acquire_map_lock("restore")` so no approve/revert can race the restore (423 `MapLocked` if held).
5. R2 server-side `copy_object` from the chosen backup → `globalservermap.db`.
6. Re-download the new combined .db to a temp file, recompute `tile_count` and TOPS map stats, write both back into Supabase.
7. `db.mark_contributions_orphaned_by_restore(backup_taken_at)` flips every `approved` contribution whose `approved_at` is strictly later than the snapshot to `orphaned_by_restore`. The auditor can then see which contributions vanished. Reapplying them is out of scope for Phase 4a — manual admin work.
8. Audit `map.restore_backup` with `{ totp_verified, backup_taken_at, orphaned_contributions }`.
9. Persist a banner blob into `app_state` (`last_backup_restore`) so the admin panel can surface a 7-day "the map was restored" notice via `GET /api/admin/backups/last-restore`.
10. Enqueue a full TOPS regen (no bounds) — the restored map may differ everywhere.

The lock is released in a `finally` so a crashed restore self-clears via the 10-minute TTL.

## Per-contribution revert (Phase 4b)

Surgical undo of a single approved contribution, intended as the everyday recovery path before resorting to a backup restore. Gated by the `per_contribution_revert` feature flag and the env-var admin key.

### Capture during approval

Approval streams every newly-inserted `position` to a local temp file as little-endian `uint64` and uploads it to `undo/<id>.added.bin` once the merge completes:

| R2 object | Contents | When written |
|---|---|---|
| `undo/<id>.added.bin` | Raw 8-byte little-endian `position` integers, one per added tile | Always (unless the size cap was hit) |
| `undo/<id>.replaced.db` | A SQLite file carrying `(position, old_data)` for every tile this contribution overwrote | Phase 2 region/overwrite mode only — empty today |

The capture is bounded by `REVERT_ADDED_BIN_MAX_BYTES` (default 64 MiB == ~8M positions). Hitting the cap aborts the capture and stamps the row `revert_supported = false`; approval succeeds anyway and admins fall back to backup restore.

`_merge_into_combined(..., added_writer=...)` is the only behavioural change to the merge path — the writer is invoked with each freshly-inserted position and never raises. After the merge, `db.set_revert_metadata` persists `revert_supported`, `revert_added_count`, `revert_replaced_count`, and the world-block bounds so the revert endpoint doesn't have to recompute them.

### Endpoint

`POST /api/admin/contributions/{id}/revert` (admin only). Steps:

1. `per_contribution_revert` flag must be on (else 404).
2. Reject if the contribution is not `approved`, was approved more than `REVERT_WINDOW_DAYS` (default 14) days ago, or has `revert_supported = false`. 410 if the undo blob has been pruned from R2.
3. `acquire_map_lock("revert")` (423 if held).
4. Download `undo/<id>.added.bin` (and `undo/<id>.replaced.db` if present).
5. Build the **conflict set** = positions claimed by *later* approved region-overwrite contributions whose region overlaps this one (helper `db.list_later_region_overwrites`). Today the helper returns `[]` because Phase 2 has not shipped, but the cascading logic is wired so a later region-overwrite landing on top of an old gap-fill will be respected when the old gap-fill is reverted.
6. Step A — `DELETE FROM mappiece WHERE position IN (added \ conflict_set)`.
7. Step B — `INSERT OR REPLACE INTO mappiece` from the attached `undo/<id>.replaced.db`, skipping `conflict_set`. No-op for gap-fill-only contributions.
8. Re-upload the modified combined .db; refresh `tile_count` + TOPS stats.
9. `db.mark_reverted(id, api_key)` flips status to `reverted` and stamps the actor.
10. Audit `contribution.revert` with `{ deleted, restored, combined_total, affected_bounds }`.
11. Enqueue a partial TOPS regen using the bounds captured at approval time.

### UX honesty

The frontend confirmation reflects the actual outcome:

* Gap-fill contributions: *"Reverting will delete N tiles added by this contribution. The area returns to unmapped, not to a previous version."*
* Region/overwrite contributions: *"Reverting will restore N tiles to their pre-contribution state and remove M tiles added in the region."*

Reverted rows stay in the public history with a `[reverted]` badge, mirroring how withdrawn rows are surfaced — the audit trail is intentionally visible to all read keys.

### Cleanup

The `undo/` prefix is **not** swept on its own schedule. Once a contribution falls out of the revert window the blob becomes dead weight — a future cleanup pass should drop it, but for now the cost is negligible (~8 bytes per added tile).

## Cooldown semantics in detail

`_get_contribution_status(api_key)` is the source of truth:

| State | `can_contribute` | `cooldown_reason` | Notes |
|-------|------------------|-------------------|-------|
| Admin or empty key | `true` | `null` | Admins are always exempt |
| Has a pending contribution | `false` | `"pending"` | `pending_contribution_id` populated |
| Last approval < 7 days ago | `false` | `"cooldown"` | `next_allowed_at` populated |
| Otherwise | `true` | `null` | Free to upload |

The cooldown is per-`api_key`, **not** per-IP and **not** per-account. Re-keying a user (see [Accounts](../users/accounts.md#re-key)) bypasses it because the new key has no contribution history. That's a known and accepted trade-off — re-key is an admin action, so it's already trusted.

Withdrawing a pending contribution doesn't start a cooldown; only an *approved* contribution does. A user can withdraw and re-upload immediately.

## Audit trail

Every approval writes to:

- The contribution row itself (`status='approved'`, `approved_at`, `tiles_new`, `tiles_existing`, `combined_total`).
- The approved log used by the dashboard (last 20 are surfaced via `/contribute/info`).
- The R2 archive at `archived/<id>.db` (when the move succeeds).
- The shared `admin_audit_log` (`contribution.approve` / `contribution.reject` / `contribution.revert`) — see [Audit log](../users/audit-log.md).
