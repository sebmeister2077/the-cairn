# Plan: TOPS Map Contribution — QA, History, Revert & Trust

Rewrite of [plans/contribution-improvement-plan.md](plans/contribution-improvement-plan.md). Adds five capabilities to the contribution pipeline:

1. Pre-approval **match-percentage scoring** so admins can sanity-check uploads without downloading them.
2. **Region-restricted updates** (overwrite within a bounding box) — initially **admin-only**, gated by a feature flag, with a granular permission to extend to trusted contributors later.
3. A **2-week public contribution history** with retained previews.
4. A **backup + revert** system covering both per-contribution and weekly-snapshot restores.
5. A **feature-flag panel** in the admin UI to roll out / kill any of the above without redeploys.

The current pipeline is documented in [docs/multiplayer/contribute.md](docs/multiplayer/contribute.md) and implemented in [backend/app/routes/contribute_r2.py](backend/app/routes/contribute_r2.py). The merge today is gap-fill only (`INSERT OR IGNORE`). All new features must preserve the existing presigned-upload path, the idempotent gap-fill merge, and partial TOPS-map regen.

---

## Phase 0 — Foundations (must land before anything else)

These primitives are reused by every later phase. Implement and merge first.

### 0a. Concurrency lock for combined DB

Today there is no global mutex around read → merge → write of `globalservermap.db`. Adding revert and restore makes the race a real data-loss risk.

**Steps**
1. New Supabase table `map_lock`:
   ```sql
   id            TEXT PRIMARY KEY  -- always 'globalservermap'
   holder_token  TEXT NOT NULL     -- random per acquisition
   holder_action TEXT NOT NULL     -- 'approve' | 'revert' | 'restore'
   acquired_at   TIMESTAMPTZ NOT NULL
   expires_at    TIMESTAMPTZ NOT NULL  -- acquired_at + 10 min
   ```
2. Helper `with_map_lock(action: str)` in [backend/app/core/database.py](backend/app/core/database.py): conditional INSERT (`WHERE NOT EXISTS OR expires_at < now()`); on success returns token; on failure raises `MapLocked` (HTTP 423). Lock is released on context exit (`DELETE WHERE holder_token = ?`).
3. Wrap every mutation path: approve, revert, restore. Existing approve flow (`POST /contribute/{id}/approve`) becomes the first caller.
4. Stale-lock recovery: 10-minute TTL means a crashed worker self-clears. Admin "Force release lock" button on the feature-flag panel for the rare manual case.

**Verification**
- Two concurrent approve calls → one returns 423 immediately, other completes.
- Crash an approve mid-merge (kill `-9`) → wait 10 min → next approve succeeds.

### 0b. Feature-flag system

**Steps**
1. New Supabase table `feature_flags(key TEXT PRIMARY KEY, enabled BOOLEAN, updated_at, updated_by_key)`. Seed rows: `match_score`, `region_overwrite`, `public_history`, `weekly_backups`, `per_contribution_revert`, `backup_restore`.
2. Backend helper `is_feature_enabled(key) -> bool` in [backend/app/core/config_reader.py](backend/app/core/config_reader.py) with a 30 s in-process cache to avoid hammering Supabase.
3. Admin endpoints: `GET /api/admin/feature-flags`, `PATCH /api/admin/feature-flags/{key}`. Audit every toggle.
4. Frontend: new `AdminFeatureFlagsPanel.tsx` rendered inside the existing admin section on [frontend/src/pages/ContributePage.tsx](frontend/src/pages/ContributePage.tsx) (per the unification note in **Cross-cutting** below). Each flag shows current state, last-changed timestamp, and a toggle.
5. Every later phase wraps its user-facing entry points in `is_feature_enabled(...)`. If disabled the endpoint returns 404 (not 403) so the feature is invisible to non-admins.

### 0c. Granular permissions on API keys

Today the key tiers are read / contribute / admin. Region-overwrite needs a finer grain so we can extend it past admins later without giving full admin rights.

**Steps**
1. Add JSONB column `api_keys.permissions` (default `{}`). Recognised keys at first: `region_overwrite: bool`. Future-proof for more.
2. Helper `verify_permission(api_key, perm_name)` in [backend/app/auth.py](backend/app/auth.py).
3. Admin UI on the existing user-management page (`AdminUsersPage.tsx`): per-row permission toggles.
4. Effective permission = `is_admin OR permissions[perm_name] == true`.

### 0d. Audit-log unification

Closes the existing gap noted in [docs/users/audit-log.md](docs/users/audit-log.md).

**Steps**
1. Extend `admin_audit_log` action vocabulary to include: `contribution.approve`, `contribution.reject`, `contribution.revert`, `map.restore_backup`, `map.create_backup`, `feature_flag.toggle`, `permission.grant`, `permission.revoke`, `lock.force_release`.
2. Refactor existing approve / reject paths in [backend/app/routes/contribute_r2.py](backend/app/routes/contribute_r2.py) to also write the audit row (in addition to existing `contribution_log`).

---

## Phase 1 — Match-percentage scoring (admin QA)

**Goal**: When an admin opens a pending contribution, show "X% of tiles overlap existing map (Y of Z), Z% pixel-similar on overlapping tiles". Lets admin reject obviously-wrong files (other world, swapped DB) without downloading.

**Match score is informational — it never gates approval.** The badge is a hint, not a verdict.

**Steps**
1. Add `_compute_match_score(combined_path, pending_path, region=None)` in [backend/app/routes/contribute_r2.py](backend/app/routes/contribute_r2.py) using a temporary `ATTACH DATABASE` join to count overlapping `position` keys → `overlap_count / pending_total`. When `region` is set, restrict both sides to in-region positions.
2. **Multi-pixel sampling** for pixel similarity: per overlapping tile, sample **10 deterministic-pseudo-random pixels + the center pixel** (seed = `position`, so the same tile picks the same pixels every run → reproducible). A tile counts as "similar" if ≥ 8 of 11 pixels match (treat alpha=0 as no-data → not counted toward the denominator). Reuse decode helpers in [backend/app/core/mapdb.py](backend/app/core/mapdb.py); add `_sample_n_pixels(blob, n, seed) -> list[(r,g,b,a)]`.
3. **Async computation** (mandatory — `/complete` already runs under request timeout and a 500 MB upload can blow it):
   - On `/complete`, persist `contributions.match_score_status = 'pending'` and enqueue a `compute_match_score` job.
   - New worker in [backend/app/tasks/](backend/app/tasks/) processes the queue, downloads combined + pending DBs to temp, runs the scorer, writes `match_score_status = 'ready'` + `match_score_json`.
   - On worker failure, set `match_score_status = 'failed'` with reason; admin sees an "Unknown — recompute" button that re-enqueues.
4. Extend `/contribute/info` payload with per-pending row: `match_score: { status, tile_overlap_pct, pixel_similar_pct, overlap_count, pending_total }`.
5. Display on the pending card in [frontend/src/pages/ContributePage.tsx](frontend/src/pages/ContributePage.tsx) with a colored badge: `pixel_similar_pct >= 80` → green "looks like our map", `< 20` → orange "may be wrong file", in between → grey, `status != 'ready'` → spinner.
6. Wrap behind `is_feature_enabled('match_score')`.

**Verification**
- Upload a `.db` equal to combined → 100% / 100%.
- Upload a known-good past contribution (from R2 archive) → ~100% overlap, ~100% pixel-similar.
- Upload an unrelated VS world DB → < 5% overlap.
- Backend unit test on `_compute_match_score` with two synthetic 10-tile DBs.
- Pull network mid-job → `match_score_status = 'failed'`, recompute button appears.

---

## Phase 2 — Region-restricted updates (overwrite within bounds, admin-only at first)

**Goal**: A trusted contributor selects a rectangular region on the TOPS map; on approval, every tile inside the region — including ones already in combined — is replaced with the upload's version. Outside the region: untouched. Default mode (no region selected) keeps today's gap-fill behavior.

**Trust model**

| Permission | Max region size | Upload allowed? |
|---|---|---|
| Admin (`is_admin`) | unlimited | yes |
| `region_overwrite = true` on key | configurable, default **256 × 256 tiles** (8192 × 8192 blocks) | yes |
| Any other contribute key | n/a | region UI hidden, endpoint rejects with 403 |

The feature flag `region_overwrite` controls the whole feature visibility. Until I flip it on, the endpoint returns 404 for everyone.

**Steps**
1. **Schema**: add nullable `update_region_min_x INT, min_z INT, max_x INT, max_z INT` (world-block coords) to `contributions`. NULL ⇒ legacy gap-fill mode.
2. **Frontend region picker**: new `ContributionRegionPicker.tsx` reusing the TOPS map viewer canvas (chunk-stitched from [backend/app/routes/tops_map_r2.py](backend/app/routes/tops_map_r2.py) — must reuse, not re-render). Drag a single rectangle; output world-block bounds.
3. **Pre-submit feedback**: as the user adjusts the rectangle, the picker calls `POST /contribute/region-preview` (multipart-free; just sends region bounds + the contribution_id of the already-uploaded pending file). Backend returns `{ tiles_in_region, tiles_total }`. UI shows "1 234 of 56 789 tiles in your file fall inside this region" so users don't accidentally pick an empty area.
4. **Region size cap**: enforced server-side in `/contribute/complete` and `/contribute/region-preview`:
   - `(max_x - min_x) * (max_z - min_z)` in tiles, compared against `MAX_REGION_TILES_NON_ADMIN` (default 256 × 256 = 65 536).
   - Admins exempt. Non-admins without `region_overwrite` permission rejected with 403 regardless of size.
5. **Validation** on `/complete`: if zero upload tiles fall inside the region → HTTP 400 "Empty region".
6. **Match score** (Phase 1): when region is set, restrict the score to in-region tiles.
7. **Merge changes** in `_merge_into_combined` (under map lock from Phase 0a):
   - If `update_region_*` is NULL → existing `INSERT OR IGNORE` path (unchanged).
   - Else → filter pending tiles to in-region positions; for each, **first read the existing tile bytes and append `(position, old_data)` to the per-contribution undo stream** (Phase 4b's storage); then `INSERT OR REPLACE`.
8. **Affected bounds for regen**: when region is set, use those bounds directly.
9. **Preview = side-by-side "before / after"** instead of multi-tint:
   - Render two PNGs at `max_dimension = 2048`: `before/<id>.png` (combined cropped to region) and `after/<id>.png` (combined merged with upload, in-memory only, cropped to region).
   - Tiles newly added (gap-fill within region) tint green on the after image; overwritten tiles tint orange. The before/after framing handles the third (out-of-region) state by simply cropping it out, so we drop the dimming.
   - Frontend admin card shows the two PNGs side-by-side with a slider toggle.
10. **Region bounds privacy** in `/contribute/info`:
    - **Pending** rows: omit `update_region_*` for non-admins (would leak where someone is exploring). Admins see them.
    - **Approved** rows: include for everyone — by then it's part of the public map.
11. **All endpoint paths gated** by `is_feature_enabled('region_overwrite')` (404 if off) AND `verify_permission(key, 'region_overwrite')` (403 if on but key lacks perm).

**Verification**
- Submit with region covering only spawn → confirm only spawn-area tiles change in combined; before/after PNGs render correctly.
- Submit without region → confirm legacy gap-fill behavior unchanged (regression test).
- Submit with region containing zero of the upload's tiles → HTTP 400.
- Non-admin without `region_overwrite` perm → endpoint 403 with feature flag on; 404 with feature flag off.
- Non-admin with `region_overwrite` perm submitting 300 × 300 tile region → 400 "region too large".
- TOPS map viewer regenerates only the chunks inside the bounds (check `regen_queue` row).
- Pending row fetched by non-admin key omits region bounds.

---

## Phase 3 — Public contribution history (2 weeks)

**Goal**: Approved contributions stay visible to anyone with a read key for 14 days, with the preview PNG. Admins see them indefinitely.

**Steps**
1. **Retention-aware preview persistence**: in approval flow, **stop deleting** `pending/<id>.preview.png`; instead `move_object` it to `history/<id>.preview.png`. The archived `.db` already lives at `archived/<id>.db`.
2. **Drop the proposed R2 lifecycle rule.** Lifecycle is prefix-wide and would force a single TTL for everyone — incompatible with the per-contribution retention we want for admin-uploaded contributions. Use the application-side cleanup task only (step 5).
3. **Schema**: add `preview_retained_until TIMESTAMPTZ` to `contributions`. Set to `approved_at + 14 days` on approval. Admin-uploaded contributions get `approved_at + ADMIN_HISTORY_RETENTION_DAYS` (default 90).
4. **`/contribute/info` payload**: replace "last 20 approved" with "approved within last 14 days" for non-admins; admins keep full history (paginated, default last 50).
5. **Each approved row** returns `preview_signed_url` (3-day presigned URL, regenerated per `/contribute/info` request) pointing to `history/<id>.preview.png`, plus `contributor`, `tiles_new`, `tiles_existing`, `combined_total`, `approved_at`, and `region_bounds` (per privacy rule above — always included on approved rows).
6. **Cleanup task**: `cleanup_expired_history` in [backend/app/tasks/](backend/app/tasks/) runs daily — deletes `history/<id>.preview.png` and `archived/<id>.db` whose `preview_retained_until < now()`. Idempotent; logs counts.
7. **Frontend**: new "Recent contributions" section on [frontend/src/pages/ContributePage.tsx](frontend/src/pages/ContributePage.tsx) — thumbnail grid, click-to-enlarge. Visible to all read-key holders.
8. Wrap behind `is_feature_enabled('public_history')`.

**Verification**
- Approve a contribution → preview accessible at `history/...` via signed URL for 14 days.
- Manually backdate `preview_retained_until` to past → run cleanup task → objects deleted.
- Non-admin sees only last-14-days approvals; admin sees all (test with two API keys).

### Withdrawal handling (touches Phase 3 storage, applies project-wide)

Today, withdrawal soft-deletes the row, deletes the pending `.db` and the cached preview. New behavior:

- **Withdraw still deletes `pending/<id>.db` immediately** (don't keep the raw upload — privacy and storage).
- **If a preview was generated**, move it to `history/<id>.preview.png` with the same 14-day retention as approved contributions. The admin and the contributor can both still see what was uploaded; reduces the "user keeps re-uploading the same wrong thing" support load.
- Withdrawal continues to anonymise the contributor name in Supabase.
- **Withdraw rate-limit**: max **3 withdrawals per ISO calendar week per API key**. On the 4th withdrawal attempt within the same week, the upload form is locked with `cooldown_reason: "withdraw_limit"` and `next_allowed_at = start of next ISO week (Monday 00:00 UTC)`. Admins exempt. This prevents the previously-noted "withdraw → re-upload → withdraw" loop being used to keep R2 blobs perpetually pinned, and prevents resubmission-spam to flood admins with previews.
- Track in new column `api_keys.withdraw_count_week` (resets via the same daily cleanup task by checking ISO week change), or compute on the fly from `contributions WHERE submitted_by_key = ? AND status = 'withdrawn' AND withdrawn_at >= start_of_week`. Compute-on-the-fly is simpler — use that.

---

## Phase 4 — Backup & revert system

**Goal**: two independent revert paths: (a) per-contribution revert for the last 14 days (clean undo), (b) weekly backup restore for catastrophic recovery.

### 4a. Weekly backups

**Steps**
1. **Storage**: new R2 prefix `backups/`. Naming uses **ISO 8601 week** (week 01 contains the first Thursday of the year, weeks always start Monday — Python `datetime.isocalendar()`): `backups/backup-YYYY-Www.db`. Document the choice as a comment in the task file. Manual snapshots use `backups/backup-YYYY-Www-manual-<unix_timestamp>.db`.
2. **Lifecycle**: cleanup is application-side (matches Phase 3 decision). Cleanup task keeps the 4 most-recent **scheduled** backups (rolling) plus the 8 most-recent **manual** backups. Configurable via env.
3. **Scheduled snapshot**: `weekly_backup_task` in [backend/app/tasks/](backend/app/tasks/), runs Mondays 00:00 UTC. Uses R2 server-side `copy_object` from `globalservermap.db` → `backups/backup-YYYY-Www.db` (no download — atomic and free). Idempotent (re-running same week overwrites).
4. **On-demand snapshot**: `POST /api/admin/backups/create` writing the `*-manual-*` variant.
5. **List/restore endpoints**: `GET /api/admin/backups` (lists objects + size + created_at + scheduled/manual flag). `POST /api/admin/backups/restore` requires `{ key, confirm: true, totp_code: "123456" }`.
6. **TOTP 2FA gate for restore** (replaces the earlier two-admin idea): every admin enrols a TOTP secret (RFC 6238, 30 s window, 6 digits — compatible with Google Authenticator / Authy / 1Password / Bitwarden) the first time they hit the admin panel.
   - New Supabase columns on `api_keys`: `totp_secret_encrypted TEXT` (encrypted at rest with `TOTP_ENCRYPTION_KEY` env var), `totp_enrolled_at TIMESTAMPTZ`.
   - Enrolment endpoint: `POST /api/admin/totp/enroll` returns `{ secret, otpauth_uri }`; frontend renders the QR code via a client-side library (no secret leaves the wire as a QR image). `POST /api/admin/totp/confirm` with the first valid 6-digit code persists the secret. Until confirmed, restore is unavailable for that admin.
   - Verification helper `verify_totp(api_key, code)` in [backend/app/auth.py](backend/app/auth.py): allows the previous, current, and next 30-second window (±1) to absorb clock skew. Replay protection: cache the last accepted `(key, code)` pair for 90 s in-process and reject re-use.
   - Restore endpoint rejects with 401 `"totp_required"` if not enrolled, 401 `"invalid_totp"` on bad code, 429 `"totp_throttled"` after 5 bad codes in 5 min (per key).
   - Same TOTP gate applies to `lock.force_release` (Phase 0a) and any future destructive admin action — keep the helper generic so we can reuse it.
7. **Restore execution**: under map lock (Phase 0a). R2 `copy_object` backup → `globalservermap.db`; refresh tile-count cache; enqueue full TOPS regen. Audit (`map.restore_backup`, includes `totp_verified: true`).
8. **Don't delete post-backup contribution rows** during restore. Mark each contribution with `approved_at > backup_created_at` as `status = 'orphaned_by_restore'` so they're auditable. (Reapplying them is out of scope — manual admin work for now.)
9. **Notify all admins on every restore**: send a webhook / email blast (use existing notification infra if any; otherwise log and surface a banner on the admin panel for 7 days).
10. Wrap behind `is_feature_enabled('weekly_backups')` for snapshots and `is_feature_enabled('backup_restore')` for restore.

### 4b. Per-contribution revert

**Storage decision (locked)**: undo data lives in **R2 only**, never Supabase BLOBs.

For every approved contribution we write up to two R2 objects:

| Object | Contents | When written |
|---|---|---|
| `undo/<id>.added.bin` | Raw 8-byte little-endian `position` integers, one per added tile | Always (gap-fill or region mode) |
| `undo/<id>.replaced.db` | A SQLite file containing only the `(position, old_data)` rows that were overwritten | Only if region/overwrite mode replaced ≥ 1 tile |

Cap on `added.bin` size: **64 MB** (~8M positions). Beyond that, set `revert_supported = false` and skip writing. Cap is well above any realistic single contribution.

**Steps**
1. **Capture during merge** (under map lock):
   - Gap-fill path: collect positions `INSERT` actually added (rows where `changes() == 1`). Stream-write to a local temp file as little-endian uint64; upload to `undo/<id>.added.bin`.
   - Region/overwrite path: for each in-region pending position, `SELECT data FROM combined.mappiece WHERE position = ?` before the `INSERT OR REPLACE`. If a row existed, write `(position, old_data)` to a local temp SQLite that is then uploaded as `undo/<id>.replaced.db`. New positions in region mode also append to `added.bin`.
2. **Schema additions** to `contributions`: `revert_supported BOOL`, `reverted_at TIMESTAMPTZ`, `reverted_by_key TEXT`, `revert_added_count INT`, `revert_replaced_count INT`.
3. **Revert endpoint**: `POST /api/admin/contributions/{id}/revert` (admin only, under map lock):
   - Reject if `approved_at < now() - 14 days`, or `revert_supported = false`, or `status != 'approved'`.
   - Download combined → temp file.
   - **Step A — undo additions**: read `added.bin`, build set; **subtract positions touched by any later region-overwrite contribution** (see corrected cascading logic below). `DELETE FROM mappiece WHERE position IN (remaining_set)`.
   - **Step B — restore overwrites** (region contributions only): attach `undo/<id>.replaced.db` and `INSERT OR REPLACE INTO mappiece SELECT * FROM replaced.mappiece WHERE position NOT IN (positions_owned_by_later_region_contributions)`.
   - Reupload combined to R2; refresh tile count cache.
   - Mark contribution `status = 'reverted'`; enqueue partial TOPS regen with the contribution's affected bounds.
   - Audit (`contribution.revert`).
4. **Cascading-revert logic, corrected**:
   - The original plan was wrong: gap-fill uses `INSERT OR IGNORE`, so a *later* gap-fill contribution targeting an already-filled position was silently ignored — its `added.bin` does **not** include that position. So later gap-fill contributions can never own a position the current contribution added.
   - The **only** later mutation that can collide is a later **region-overwrite** contribution touching the same positions. Build the conflict set as: `UNION of positions in undo/<later_id>.replaced.db (the set of positions they overwrote) for every later contribution where update_region overlaps this contribution's affected bounds AND approved_at > this.approved_at AND status = 'approved'`. Subtract that set from both Step A and Step B above.
5. **UX honesty about gap-fill revert**: revert of a gap-fill contribution leaves those tiles **unmapped** (no data), not "previous version" — the area was a gap before. Frontend revert dialog must say: "Reverting will delete N tiles added by this contribution. The area returns to unmapped, not to a previous version." For region/overwrite contributions, dialog instead says "Reverting will restore N tiles to their pre-contribution state and remove M tiles added in the region."
6. **Region/overwrite contributions ARE revertable** (changed from earlier draft): the `replaced.db` makes surgical revert possible. We only fall back to "use weekly backup" if `revert_supported = false` (size cap exceeded) or > 14 days old.
7. **Admin UI**: extend the existing pending list on [frontend/src/pages/ContributePage.tsx](frontend/src/pages/ContributePage.tsx) with a **"History" tab** (don't create `AdminContributionsPage.tsx` — single source of truth for all contribution UX). Tabs: "Pending" (default), "Recent (14d)", "All (admin only, paginated)". The "All" tab carries filters (status, date, contributor) and the per-row Revert button + details modal.
8. Wrap behind `is_feature_enabled('per_contribution_revert')`.

**Verification**
- Approve gap-fill contribution → revert → only those tiles gone, neighboring contributions intact.
- Approve gap-fill A on tile T → approve region-overwrite B that overwrites T → revert A → T is preserved (excluded by cascading logic) and B's data remains.
- Approve region-overwrite contribution → revert → in-region tiles restored to old bytes; tiles A also added (gap-fill in region) are deleted.
- Trigger weekly backup task manually → `backup-YYYY-Www.db` exists in R2.
- Restore from backup with valid TOTP code → `globalservermap.db` size matches backup, full regen runs, audit log populated, post-backup contributions marked `orphaned_by_restore`.
- Restore attempt without TOTP enrolment → 401 `totp_required`.
- Restore attempt with wrong code → 401 `invalid_totp`; 6th wrong code in 5 min → 429 `totp_throttled`.
- TOTP code re-use within 90 s → rejected.
- Concurrency: kick off a contribution mid-restore → second caller hits map lock → returns 423.

---

## Cross-cutting

**Files touched**

- [backend/app/routes/contribute_r2.py](backend/app/routes/contribute_r2.py) — match score (async dispatch only), region merge with undo capture, region-preview endpoint, revert endpoint, before/after preview, withdrawal updates, region bounds redaction, history routes
- [backend/app/core/mapdb.py](backend/app/core/mapdb.py) — `_sample_n_pixels`, region-filter helper
- [backend/app/core/database.py](backend/app/core/database.py) — schema migrations, `with_map_lock` helper, feature-flag CRUD, permission CRUD, withdraw-count query
- [backend/app/core/r2_storage.py](backend/app/core/r2_storage.py) — `copy_object`, helpers for `history/`, `backups/`, `undo/`
- [backend/app/core/config_reader.py](backend/app/core/config_reader.py) — `is_feature_enabled` with cache
- [backend/app/auth.py](backend/app/auth.py) — `verify_permission`, `verify_totp`, TOTP enrolment helpers
- [backend/app/tasks/](backend/app/tasks/) — `compute_match_score`, `weekly_backup_task`, `cleanup_expired_history` (covers backups + history + stale locks)
- [backend/app/routes/](backend/app/routes/) — new `admin_backups.py`, `admin_feature_flags.py`; expose in [backend/app/main.py](backend/app/main.py)
- [frontend/src/pages/ContributePage.tsx](frontend/src/pages/ContributePage.tsx) — match-score badges, region picker entry point, public history grid, History tab with Revert UI, withdraw cooldown messaging
- [frontend/src/components/](frontend/src/components/) — `ContributionRegionPicker.tsx`, `AdminBackupsPanel.tsx`, `AdminFeatureFlagsPanel.tsx`, `ContributionBeforeAfter.tsx`
- [frontend/src/pages/AdminUsersPage.tsx](frontend/src/pages/AdminUsersPage.tsx) — per-key permission toggles
- [docs/multiplayer/contribute.md](docs/multiplayer/contribute.md) — document all features
- [docs/users/audit-log.md](docs/users/audit-log.md) — extended action vocabulary

**Decisions locked from clarification**

- Phase 0 (lock + flags + permissions + audit unification) ships before any user-visible phase.
- Match score is **informational only**; multi-pixel sampling = 10 random + center, ≥ 8/11 match → "similar". Computed **async**, frontend polls.
- Region overwrite is **admin-only at launch**; gated by feature flag AND new `region_overwrite` API-key permission for future broader rollout. Non-admin cap: 256 × 256 tiles. Region bounds **redacted** for non-admin viewers of pending rows.
- Region preview = **side-by-side before/after PNGs**, not multi-colour overlay.
- Withdrawn contributions: `.db` removed immediately; preview (if generated) retained 14 days. Withdraw limit: **3 per ISO week per API key**, hard-locks uploads until next Monday 00:00 UTC.
- Backups use **ISO 8601 weeks**. Cleanup is application-side (no R2 lifecycle rule), keeps 4 scheduled + 8 manual.
- Backup restore requires **TOTP 2FA** (mobile authenticator app, RFC 6238) from the initiating admin and notifies all admins. Same TOTP helper reused for `lock.force_release` and other future destructive actions.
- Per-contribution revert supported for **gap-fill (added.bin) AND region/overwrite (replaced.db)**; falls back to backup restore only if size cap exceeded or > 14 days old. Cascading logic correctly handles "later region-overwrite touched same position".
- Undo data stored in **R2 only**, never Supabase BLOBs. `added.bin` cap: 64 MB.
- Concurrency: single Supabase `map_lock` row, 10 min TTL, holds for approve/revert/restore.
- Admin contribution UI lives as **a History tab on the existing ContributePage**, not a separate page.
- Audit-log unification ships with Phase 0.

**Out of scope**

- Auto-approval / quality-gating beyond the informational match score.
- Polygon or multi-rectangle region selection.
- Replay-based revert (reapply all approved contributions onto an old backup).
- Reapplying `orphaned_by_restore` contributions automatically.
- Per-IP cooldown changes.
- Restoring single tiles from arbitrary historical snapshots (covered indirectly via per-contribution revert).

**Phase order**

1. **Phase 0** (lock, flags, permissions, audit unification) — blocking for everything else.
2. **Phase 1** (match score) and **Phase 3** (public history) — parallel, both independent.
3. **Phase 4a** (weekly backups) — parallel with 1/3.
4. **Phase 4b** (per-contribution revert) — must precede Phase 2 launch (so region-overwrite always has surgical revert).
5. **Phase 2** (region overwrite) — last; admin-only behind a feature flag at launch.

**Further considerations**

1. **Backup storage cost** — 4 scheduled + 8 manual snapshots × current combined DB size. Acceptable today; reconsider if combined DB exceeds ~5 GB.
2. **Region picker performance on a 16384px map** — must reuse the existing chunk-stitching canvas, not re-render. Spike before committing UI estimates.
3. **Lock contention under load** — at current contribution volume the 10-min TTL is extremely conservative. If approvals start timing out we tighten to 2 min and add explicit release on success path.
4. **`region_overwrite` permission rollout** — keep the permission undocumented to non-admins until we're confident in the trust model. First grants should go to a hand-picked list of long-term contributors.
