# Per-contribution Revert

> Frontend trigger: the **Revert** button on a card in the *Recent Contributions* grid (admin only).
> Frontend page: [frontend/src/pages/ContributePage.tsx](../../frontend/src/pages/ContributePage.tsx) (`handleRevertHistory`, `RecentContributionsGrid`).
> Frontend API helper: [frontend/src/lib/api.ts](../../frontend/src/lib/api.ts) (`revertContribution`).
> Backend endpoint: [backend/app/routes/admin_contributions.py](../../backend/app/routes/admin_contributions.py) (`POST /api/admin/contributions/{id}/revert`).
> Backend worker: [backend/app/tasks/revert_contribution.py](../../backend/app/tasks/revert_contribution.py).
> DB helpers: [backend/app/core/database.py](../../backend/app/core/database.py) (`enqueue_revert`, `claim_pending_revert_job`, `mark_reverted`, `set_revert_failed`, `clear_revert_state`, `reset_running_reverts`).

This is the surgical "undo a single approved contribution" path. It is **asynchronous**: clicking *Revert* only enqueues a job and returns 202; the actual mutation of `globalservermap.db` happens in a background worker thread inside the FastAPI process.

This document is the operational reference for what actually happens between the click and the `[reverted]` badge showing up.

## TL;DR — the state machine

```
status=approved                 click "Revert"
revert_status=NULL      ─────────────────────────►   status=approved
                                                     revert_status=queued
                                                          │
                                            worker thread claims the row
                                            (FOR UPDATE SKIP LOCKED)
                                                          ▼
                                                     status=approved
                                                     revert_status=running
                                                     revert_attempts +=1
                                                          │
                  ┌───────────────────────────────────────┼───────────────────────────────────┐
                  │ success                               │ retryable failure                 │ fatal failure
                  ▼                                       ▼                                   ▼
            status=reverted                       revert_status=queued                  revert_status=failed
            reverted_at=now                       (re-enqueued)                         revert_error=<reason>
            reverted_by_key=<admin key>           up to REVERT_MAX_ATTEMPTS=3
            revert_status=NULL
            (contribution_log row deleted)
```

`status='approved' AND revert_status='queued'` is the visible "I clicked Revert and nothing has happened yet" state. Both card grids on the contribute page show the contribution with a "queued" / "reverting…" badge; the *Reverted Contributions* card stays empty until `mark_reverted` runs.

## Step 1 — Frontend click

`RecentContributionsGrid` renders a small *Revert* button on entries whose backend payload includes `can_revert: true` (computed in `contribute_r2.py` from feature flag, status, `revert_supported`, age vs `REVERT_WINDOW_DAYS`, and the absence of an in-flight `revert_status`).

Clicking the button stages the entry into a themed `ConfirmDialog`. Confirm calls `revertContribution(id)` → `POST /api/admin/contributions/{id}/revert` with the admin's API key.

After a successful 202, `handleRevertHistory` invalidates the `contribute-info` query, which immediately refetches and re-renders the grid — the row now shows the **queued** badge.

> ⚠️ **Polling caveat.** Today the React-Query refetch interval in `ContributePage.tsx` only polls while there is an in-flight *approval* or *validation* job. It does **not** poll on `revert_status in ('queued','running')`. Once the page is sitting on a queued revert, the badge will not transition to `reverting…` or `[reverted]` until the operator manually refreshes or another query invalidation happens. If you're watching a revert and "nothing seems to happen", refresh the page.

## Step 2 — Endpoint validation (`POST /api/admin/contributions/{id}/revert`)

The endpoint is the authoritative gate. It runs the following checks before enqueuing:

1. `per_contribution_revert` feature flag must be on (else 404 — feature is invisible).
2. Caller must be admin (env-var admin key) — `_require_admin_key`.
3. Contribution row must exist and have `status='approved'`.
4. `revert_supported` must be true (it is set to `false` if approval hit `REVERT_ADDED_BIN_MAX_BYTES`).
5. `approved_at` must be within `REVERT_WINDOW_DAYS` (default 14).
6. `undo/<id>.added.bin` must still exist in R2 (the cleanup task may have pruned it).
7. `revert_status` must not already be `queued` or `running` (returns 423 otherwise).

If all checks pass, `db.enqueue_revert(cid, requested_by_key=admin_key)` runs:

```sql
UPDATE contributions
   SET revert_status   = 'queued',
       revert_attempts = 0,
       revert_error    = NULL,
       revert_requested_by_key = <admin key>
 WHERE id = <cid>
   AND status = 'approved'
   AND (revert_status IS NULL OR revert_status = 'failed');
```

Then it audits `contribution.revert.queued`, calls `revert_contribution.start_job(cid)` to make sure the worker thread is alive, and returns `{ "queued": cid, "revert_status": "queued" }` with HTTP 202.

The endpoint **never** touches the combined DB itself.

## Step 3 — Worker spawn (`tasks/revert_contribution.start_job`)

`start_job` is fire-and-forget:

* Honours the `heavy_compute_enabled` feature flag (and the `HEAVY_COMPUTE_LOCAL_OVERRIDE` env var). If heavy compute is OFF, the worker is **not** spawned — the row sits at `revert_status='queued'` indefinitely. **This is the most common reason a revert appears stuck in production.** Re-enabling the flag does not auto-spawn the worker; the next request that calls `start_job` (any approve/revert) does, and the startup hook does on the next backend restart.
* If a worker thread is already alive, returns False (the existing thread will drain the queue).
* Otherwise spawns a single daemon thread `revert-contribution-worker`.

The worker thread loops calling `db.claim_pending_revert_job()`, which does `UPDATE … FOR UPDATE SKIP LOCKED` so multiple processes (or a future scaled deployment) can race safely — exactly one process picks up each row. The claim flips the row to `revert_status='running'` and bumps `revert_attempts`.

When the queue is empty, the loop exits and the thread dies. There is no idle worker.

### Crash recovery

`backend/app/main.py` calls `revert_contribution.kick_on_startup()` on startup, which:

1. Resets every `revert_status='running'` row back to `revert_status='queued'` via `db.reset_running_reverts()`. The merge holds `map_lock` for its full duration and the SQLite mutations are batched per-row, so resuming after a crash is safe — at worst we re-do work already done before the crash, at best we pick up exactly where we left off.
2. Calls `start_job()` to drain the resulting queue.

## Step 4 — The actual merge (`run_revert_merge`)

This is where `globalservermap.db` is finally mutated. It runs entirely inside the worker thread. The function holds the global `map_lock` for its whole duration (`acquire_map_lock("revert")`), so any concurrent approve/restore returns 423 instead of racing.

Steps:

1. Re-validate everything the endpoint validated (status, revert window, undo blob present). A failed re-check raises `RevertFatal` and the row is marked `revert_status='failed'` with no retry.
2. **Download the undo blobs.** `undo/<id>.added.bin` (always) and `undo/<id>.replaced.db` if `revert_replaced_count > 0`.
3. **Build the conflict set** = positions claimed by *later* approved region-overwrite contributions whose region overlaps this one (helper `db.list_later_region_overwrites`). Today the helper returns `[]` because Phase 2 region-overwrite has not shipped, but the cascading logic is in place.
4. **Download the combined DB** from `r2_storage.COMBINED_DB_KEY` to a local temp file. (This is a multi-GB download; on Render it routinely takes longer than the 100-second edge HTTP timeout — which is exactly why the endpoint is async.) `FileNotFoundError` here raises `RevertFatal`.
5. **Step A — undo additions.** `DELETE FROM mappiece WHERE position IN (added \ conflict_set)`, batched at `_DELETE_BATCH` per execute.
6. **Step B — restore overwrites.** ATTACH the `replaced.db`, `INSERT OR REPLACE` each `(position, data)` row whose position is not in the conflict set. No-op for gap-fill contributions (`replaced.db` is absent).
7. **VACUUM** the combined SQLite file. SQLite never shrinks a database on its own — the `DELETE` above turns rows into free pages but leaves the physical file size untouched. Without this step, a revert that drops a 9.8 GB contribution would re-upload a 10 GB file (with ~98 % empty pages) and the `.zst` sibling would be derived from the same bloat. VACUUM is run inside the map lock so no other writer can race.
8. **Re-upload the modified combined DB.** `r2_storage.upload_file(combined_tmp, COMBINED_DB_KEY)`. **This is the atomic commit point.** If the worker crashes before this upload, R2 is untouched and the queued row is re-claimed on the next worker spawn. After upload:
   * `invalidate_combined_db_cache()` so the next read goes to R2.
   * `schedule_combined_compress(...)` enqueues the async compress worker so a fresh `globalservermap.db.zst` sibling is produced (best-effort).
   * `set_tops_map_stats` and `set_cached_tile_count` refresh the Postgres-cached counters so the home/admin pages display the new totals immediately.
9. **`db.mark_reverted(cid, admin_key)`.** Inside one transaction:
   * `UPDATE contributions SET status='reverted', reverted_at=now(), reverted_by_key=<admin key> WHERE id=<cid> AND status='approved'`.
   * `DELETE FROM contribution_log WHERE id=<cid>` — drops the row from the public *Approved Contributions* feed (`get_approved_log`).
10. **`db.clear_revert_state(cid)`.** Wipes `revert_status` / `revert_attempts` / `revert_error` so the historical row reads cleanly.
11. **Release the map lock.**
12. **Audit `contribution.revert`** with `{ deleted, restored, combined_total, affected_bounds }`.
13. **Enqueue partial TOPS regen** for the contribution's bounds (`start_map_generation_job`) — but only if `auto_regen_after_approval` is on. With it off, the combined DB is updated but the TOPS tile cache continues to serve the pre-revert imagery until an admin manually regenerates.

## Failure modes

| Exception inside `run_revert_merge` | Worker behaviour |
|---|---|
| `RevertRetryable` (e.g. `MapLocked`, R2 download blip) | Persist `revert_status='queued'` again via `enqueue_revert`. Stops at `REVERT_MAX_ATTEMPTS=3`, then `set_revert_failed`. |
| `RevertFatal` (status not approved, blob missing, outside window) | `set_revert_failed(reason)` immediately. No retry. |
| Any other `Exception` | Logged, retried up to `REVERT_MAX_ATTEMPTS`, then `set_revert_failed`. |

Failed rows surface in the admin payload as `revert_status='failed'` with `revert_error` populated; the frontend renders a red **revert failed** badge in the grid. The contribution stays `status='approved'`, so an admin can click *Revert* again to retry.

## Storage objects touched

| R2 key | Read | Written | Notes |
|---|---|---|---|
| `undo/<id>.added.bin` | ✓ | | Required. Existence is checked twice (endpoint and worker). |
| `undo/<id>.replaced.db` (or `.zst`) | ✓ (if `revert_replaced_count > 0`) | | Optional today (Phase 2 only). |
| `globalservermap.db` (`COMBINED_DB_KEY`) | ✓ | ✓ | Atomic commit point. |
| `globalservermap.db.zst` | | ✓ (best-effort) | Re-compressed by `compress_workers` after the merge. |

The local `globalservermap.db` file you may see on disk during development is **not** rewritten by the revert path. The revert downloads R2 → mutates a temp file → uploads back to R2; nothing else has its file on disk touched. If your *local development* setup mirrors `globalservermap.db` on disk, you must re-pull from R2 to see the new contents.

## Database columns involved

`contributions` carries the full revert state per row:

| Column | Meaning |
|---|---|
| `status` | `approved` → `reverted` on success. |
| `revert_supported` | `true` only if approval captured `undo/<id>.added.bin` under the size cap. Set by `db.set_revert_metadata` at approval time. |
| `revert_added_count`, `revert_replaced_count` | Counts captured at approval. Power the confirmation dialog ("delete N tiles, restore M tiles"). |
| `revert_status` | `NULL` / `queued` / `running` / `failed`. Cleared back to `NULL` after `mark_reverted`. |
| `revert_attempts` | Bumped by `claim_pending_revert_job`. Capped at `REVERT_MAX_ATTEMPTS=3`. |
| `revert_error` | Last failure reason (truncated to 500 chars). Surfaced in the admin UI on the failed badge tooltip. |
| `revert_requested_by_key` | Admin API key that pressed the button. Read by the worker so audit lines have the right actor. |
| `reverted_at`, `reverted_by_key` | Stamped by `mark_reverted`. |

## Operational debugging guide

If an admin reports *"I clicked Revert and nothing happened"*, work through this list in order:

1. **Check `revert_status` for the row** in Postgres. If it's `queued`, the worker hasn't picked the job up yet.
2. **Is `heavy_compute_enabled` ON?** This is the most common cause of a stuck `queued` row. The endpoint succeeds (202) and `enqueue_revert` runs, but `start_job` no-ops. Toggle the flag on, then either restart the backend or trigger any approve/revert to spawn the worker.
3. **Look for `revert-contribution-worker` thread / log lines.** The worker logs `revert_contribution: processing <id> (attempt N)` on claim and `revert_contribution: <id> reverted (deleted=… restored=… combined_total=…)` on success.
4. **`revert_status='running'` for an unreasonable time** (multi-GB DB downloads can legitimately take several minutes on Render). Worst case the process restarts; `kick_on_startup` will re-queue it.
5. **`revert_status='failed'`** — `revert_error` says why. Common cases:
   * "Undo data is missing in object storage" — the `undo/<id>.added.bin` blob has been pruned. Beyond automated recovery; restore from a weekly backup instead.
   * "Contribution is older than the N-day revert window" — same recourse.
   * "Combined map .db not found in storage" — R2 outage or wrong bucket; check `r2_storage` config.
6. **Admin UI says it's reverted but the local `globalservermap.db` looks unchanged.** Expected — the revert only mutates the R2 object. Re-pull from R2.
7. **Admin UI says it's reverted but the R2 `globalservermap.db` is still ~10 GB.** This was a real bug fixed alongside this doc: the revert deleted the rows but never `VACUUM`-ed the SQLite file, so the physical size stayed at the pre-revert value (free pages take the same disk space). The `.zst` sibling produced by `schedule_combined_compress` was therefore also derived from the bloated file. Reverts performed *after* the fix VACUUM as part of step 7. To repair an already-bloated R2 object without re-running a revert: download `globalservermap.db`, run `sqlite3 globalservermap.db 'VACUUM;'` locally, re-upload via the admin restore tooling (the file is byte-equivalent in row content). The compress worker can then be re-kicked to rebuild the `.zst`.
7. **Admin UI says it's reverted but the R2 `globalservermap.db` is still ~10 GB.** This was a real bug fixed alongside this doc: the revert deleted the rows but never `VACUUM`-ed the SQLite file, so the physical size stayed at the pre-revert value (free pages take the same disk space). The `.zst` sibling produced by `schedule_combined_compress` was therefore also derived from the bloated file. Reverts performed *after* the fix VACUUM as part of step 7. To repair an already-bloated R2 object without re-running a revert: download `globalservermap.db`, run `sqlite3 globalservermap.db 'VACUUM;'` locally, re-upload via the admin restore tooling (the file is byte-equivalent in row content). The compress worker can then be re-kicked to rebuild the `.zst`.
8. **Admin UI says it's reverted but the contribution doesn't show in *Reverted Contributions* card.** That card filters `info.history` by `status === 'reverted' || status === 'orphaned_by_restore'`. The history feed is paginated (default 50–100 entries). If the contribution is older than the visible window, it won't appear there — paging through the grid (`history_offset`) eventually surfaces it. The `[reverted]` badge in the *Recent Contributions* grid is the more reliable visual confirmation.
9. **TOPS map still shows the old tiles after a successful revert.** That's the `auto_regen_after_approval` flag — turn it on, or trigger a manual regen from the TOPS map admin panel for the contribution's bounds.

## Related docs

* [Contribute pipeline](contribute.md) — approval and undo capture.
* [Storage and data flow](storage-and-data-flow.md) — R2 keys.
* [Audit log](../users/audit-log.md) — `contribution.revert.queued` and `contribution.revert` entries.
