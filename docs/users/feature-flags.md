# Feature flags

> **Not the same thing as user flags.** This document is about *feature flags* —
> runtime kill switches and feature toggles consulted by the API and the UI.
> For per-user *report flags* (the red badge on the Users page), see
> [flags.md](./flags.md).

Feature flags live in the Supabase `feature_flags` table. They are
admin-toggleable from the **Manage → Feature Flags** page in the UI, and the
backend reads them through a small in-process cache so flips take effect
within `CACHE_TTL_SECONDS` (30 s by default).

## Schema

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | Stable identifier referenced from code |
| `enabled` | BOOLEAN | Current state |
| `value_int` | INTEGER, nullable | Optional integer payload for quota-style flags (see [Quotas & rate limits](#quotas--rate-limits)). `NULL` means "use the built-in default". |
| `updated_at` | TIMESTAMPTZ | Last toggle |
| `updated_by_key` | TEXT, nullable | Admin api_key that flipped it (audited via `audit_log`) |

The seed in [backend/app/core/database.py](../../backend/app/core/database.py)
inserts every well-known flag with `ON CONFLICT DO NOTHING`, so existing rows
are never overwritten on schema bootstrap.

## Cache + DB-failure semantics

`is_feature_enabled(key)` and `is_feature_enabled_default(key, default)` in
[backend/app/core/feature_flags.py](../../backend/app/core/feature_flags.py)
share an in-process cache:

- Reads are cached for 30 s; flips invalidate the cache for that key only.
- If the DB read raises, the cache returns the **last known value**. If there
  is no last known value, `is_feature_enabled` returns `False` (safe-off) and
  `is_feature_enabled_default` returns the explicit default the caller asked
  for.
- This means a Supabase outage never silently disables an
  `..._enabled`-style operational flag — it stays in its last good state.

## Operational kill switches

The three flags the on-call admin will reach for during an incident.

### `maintenance_mode`

- **Default:** `FALSE` (off).
- **Effect when ON:** middleware in
  [backend/app/main.py](../../backend/app/main.py) returns HTTP `503` with
  `{"detail": "maintenance_mode"}` for any non-`GET`/`HEAD`/`OPTIONS` request,
  with a `Retry-After: 300` header.
- **Always allowed even when ON:**
  - All `GET`/`HEAD`/`OPTIONS` (the public site stays browsable).
  - Anything under `/api/admin/*` and `/api/admin-webauthn/*`.
  - Any request whose `X-API-Key` matches the env-var `ADMIN_API_KEY`.
- **Use when:** running a DB migration, swapping R2 buckets, doing incident
  triage, or any scenario where you want writes to stop globally without
  redeploying.
- **Don't use for:** product-feature kill switches — those should be their
  own flag so partial functionality keeps working.

### `uploads_enabled`

- **Default:** `TRUE` (on). The flag is treated as ON when its row is missing
  or the DB read fails.
- **Effect when OFF:** `POST /api/contribute`, `/api/contribute/upload-url`,
  and `/api/contribute/complete` return `503` with body
  `{"detail": {"code": "uploads_disabled", "message": "..."}}` for non-admin
  callers. Admins (env-var `ADMIN_API_KEY`) bypass.
- **Unaffected when OFF:**
  - Existing pending contributions can still be approved, rejected,
    withdrawn, or reverted.
  - Region-preview, contribution history, and read endpoints continue.
  - The match-score worker and weekly backups continue.
- **Use when:** a contribution-driven incident is in progress (spam,
  malformed uploads, R2 quota concern) and you want to stop new submissions
  while continuing to drain the queue.

### `registration_enabled`

- **Default:** `TRUE` (on).
- **Effect when OFF:** `POST /api/account/register` returns `503` with body
  `{"detail": {"code": "registration_disabled", "message": "..."}}`. Static
  / env-var admin keys are excluded from registration in any case.
- **Unaffected when OFF:**
  - Existing accounts can still log in, edit their profile, contribute, etc.
  - Invite tokens can still be claimed (they issue an API key); the user
    just cannot create a `users` row until you re-enable.
- **Use when:** triaging a sibling-account / shared-IP wave, or freezing the
  user base before a Terms version bump.

### `heavy_compute_enabled`

- **Default:** `TRUE` (on).
- **Effect when OFF (admins always bypass):**
  - `GET /api/contribute/preview/{id}` and
    `GET /api/contribute/preview-region/{id}` return `503` with body
    `{"detail": {"code": "heavy_compute_disabled", "message": "..."}}` and
    `Retry-After: 600` for non-admin callers. Cached preview PNGs are still
    served (the gate runs *after* the cache hit check).
  - `POST /api/contribute/complete` still creates the contribution row
    (and still uploads to R2), but does **not** spawn the
    `validate_uploads` worker or the `match_score` worker. Rows accumulate
    in `validation_status='pending'` / `match_score_status='pending'`
    until an admin presses the bulk-run button.
  - `kick_on_startup` for both workers also no-ops while the flag is OFF
    (the workers' `start_job(force=False)` early-returns).
  - The frontend `Preview` button on the Contribute page is disabled with
    a tooltip for non-admin viewers.
- **Unaffected when OFF:**
  - Already-running validate/match-score worker threads continue draining
    whatever they were processing — only *new spawns* are blocked.
  - Approval / merge / revert / restore (admin-only paths) are not gated.
  - Map browsing, contribution lists, and every read endpoint continue.
- **Bulk drain:** **Manage → Feature Flags → Run heavy compute now** calls
  `POST /api/admin/heavy-compute/run-now` which sequentially:
  1. revives any zombie validation rows + spawns the validate_uploads
     worker with `force=True`;
  2. spawns the match_score worker with `force=True` (only if the
     `match_score` product flag is also ON);
  3. for each currently-pending contribution that has no cached preview
     PNG in R2, downloads the pending DB and renders it.

  Progress is surfaced via `GET /api/admin/heavy-compute/status` which the
  flag page polls every 2 s while a run is active.
- **Use when:** the production server is too small to handle per-request
  multi-GB downloads (Render Starter, Fly shared-cpu, etc.). Flip OFF in
  prod, then trigger the bulk drain manually from a beefier machine that
  can connect to the prod API with the admin key.

### `compress_artefacts`

- **Default:** OFF.
- **When ON:** all NEW writes to long-lived R2 artefacts are stored as
  `.zst` (zstd-compressed). The asymmetric storage rule is:

  | Artefact | Flag OFF | Flag ON |
  | --- | --- | --- |
  | `globalservermap.db` (combined) | raw only | raw + `.zst` sibling (background, latest-wins) |
  | `archived/<id>.db` | raw only | `.zst` only |
  | `undo/<id>.replaced.db` | raw only | `.zst` only |
  | `backups/scheduled/...` | raw only | `.zst` only |
  | `backups/manual/...` | raw only | `.zst` only |

  Cache-miss reads of the combined DB prefer the `.zst` sibling **only**
  when its `x-amz-meta-source-etag` matches the live raw ETag (so we
  never serve stale data while the background compressor is catching
  up). Revert + restore code paths transparently support both forms via
  `r2_storage.head_artefact_with_format()`.

  Flipping ON for the first time also kicks an **eager migration** that
  walks every contribution with `preview_retained_until > now()` and
  converts its archived `.db` (and undo `replaced.db` if any) to `.zst`.
  Migration honours `heavy_compute_enabled` — when the kill switch is
  flipped OFF the migration pauses and resumes on the next startup or
  next OFF→ON of `heavy_compute_enabled`.
- **When OFF:** all writes use raw `.db`/`.bin` (current behaviour).
  Existing `.zst` artefacts remain readable forever — flipping OFF does
  **not** rehydrate them.
- **Tunable knobs** (visible only when the flag is ON): admin can set
  the zstd level (1..22) and thread budget (`single` / `half` / `all`)
  via the panel under the flag. Settings are stored in the
  `app_settings` Postgres table and cached in-process for 30 s.
- **Use when:** R2 storage cost is a concern. Ratios for our SQLite map
  artefacts typically range 30–60 % of the source size at the
  `Balanced` preset (level 10).

## Product flags

These gate features rather than acting as kill switches. Each is OFF by
default; flipping ON exposes the feature to the relevant audience.

| Key | Enables |
|---|---|
| `match_score` | Match-percentage scoring shown to admins on pending uploads. |
| `region_overwrite` | Region-restricted contribution uploads (also requires per-key permission). |
| `public_history` | All-time Recent Contributions grid for non-admins. Admins always see it (regardless of this flag) since previews are kept forever. |
| `weekly_backups` | Weekly snapshot of `globalservermap.db`. The scheduler thread always runs; the flag controls whether snapshots are actually written. |
| `per_contribution_revert` | Admin "Revert" button on approved contributions, within `REVERT_WINDOW_DAYS`. |
| `backup_restore` | Admin restore-from-backup endpoint (additionally TOTP-gated). |
| `landmark_additions_enabled` | **Default ON.** Non-admin `POST /api/landmarks` (add new landmark). When OFF, non-admin callers get HTTP `503` with `{"detail": {"code": "feature_disabled", ...}}`. Rename / edit-request flow is unaffected. Admins always bypass. |
| `translocator_contributions` | Chat-log `POST /api/contribute-tls` flow. Non-admin callers are additionally rate-limited to **3 submissions per 24 h** (admins bypass). |
| `translocator_screenshot_contributions` | Screenshot-based translocator contribution path (`POST /api/contribute-tls/screenshots/*`). |

## Quotas & rate limits

Feature-flag rows can also carry an optional integer (`value_int`) used to
tune per-user contribution caps and dedupe radii without code changes. Each
row has both `enabled` and `value_int` — for these quota rows `enabled` is
expected to stay `TRUE` and `value_int` carries the cap. If `value_int` is
`NULL`, the backend falls back to the built-in default shown below. Admins
always bypass these caps.

Read in code via `feature_flags.get_int(key, default)`. Changes propagate
within ~30 s (the same in-process cache as boolean flags).

| Key | Default | Hard max | Unit | What it caps |
|---|---|---|---|---|
| `traders_chatlog_daily_cap` | 1 | 50 | per 24 h | Approved trader chat-log submissions per user, sliding 24 h window. |
| `traders_manual_daily_cap` | 15 | 500 | per 24 h | Approved manual-form trader submissions per user, sliding 24 h window. |
| `traders_max_batch` | 200 | 2000 | items | Max trader waypoints accepted in one `POST /api/contribute-traders[/manual]`. |
| `traders_dedupe_radius` | 60 | 1000 | blocks | Distance below which two trader waypoints are treated as duplicates. |
| `translocators_chatlog_daily_cap` | 3 | 100 | per 24 h | Translocator chat-log submissions per API key, sliding 24 h window (in-memory; resets on restart). |
| `translocators_max_batch` | 200 | 2000 | items | Max translocator segments accepted in one `POST /api/contribute-tls`. |
| `translocators_dedupe_radius` | 200 | 2000 | blocks | Distance below which two translocator endpoints are treated as overlapping. |
| `translocator_screenshots_max_pending` | 90 | 1000 | pending | Per-user max pending translocator screenshot requests awaiting review. |
| `map_contribution_cooldown_days` | 7 | 365 | days | Cooldown after an approved map contribution before the same user can submit another. |

### Setting via the API

```
PATCH /api/admin/feature-flags/{key}
Body: {"value_int": 25}        # set the cap
Body: {"value_int": null}      # reset to the built-in default
Body: {"enabled": false}       # disable the flag (boolean caps only)
```

Both fields can be combined in one request. Validation enforces
`0 <= value_int <= hard_max` per the table above.

## Toggling a flag

### From the UI

**Manage → Feature Flags** → the appropriate switch. Operational kill switches
prompt for confirmation when toggled into their alarm state. Every flip is
recorded in the [audit log](./audit-log.md) as `feature_flag.toggle` with
`{enabled: bool}` metadata.

### From the API

```
PATCH /api/admin/feature-flags/{key}
Headers:
    X-API-Key: <admin>
    X-Admin-Session: <webauthn-session>     # if WebAuthn is enforced
Body:
    {"enabled": true}
```

Returns the new row. The cache is invalidated for that key.

### Listing

```
GET /api/admin/feature-flags
```

Returns `{"flags": [{key, enabled, value_int, updated_at, updated_by_key}, ...]}`.

## Adding a new flag

1. Add a row to the seed in
   [backend/app/core/database.py](../../backend/app/core/database.py) inside
   the `INSERT INTO feature_flags` block. Pick `TRUE` or `FALSE` to match
   the safe default for your feature.
2. Read it from code with `is_feature_enabled("my_flag")` for default-OFF
   product flags, or `is_feature_enabled_default("my_flag", True)` for
   default-ON kill switches.
3. Surface it in the UI:
   - Operational kill switches → add an entry to `OPERATIONAL_FLAGS` in
     [frontend/src/pages/AdminFeatureFlagsPage.tsx](../../frontend/src/pages/AdminFeatureFlagsPage.tsx).
   - Product flags → add an entry to `PRODUCT_FLAG_LABELS` in the same file.
4. Document the flag in this file under the appropriate section.

## Auditing

Every successful `PATCH /api/admin/feature-flags/{key}` writes an
`audit_log` row of action `feature_flag.toggle`, `target = <key>`,
`metadata = {"enabled": <new_value>}`, and `actor = <admin api_key>`. Use
the audit log to reconstruct what state the flags were in at any point in
time.

## Cheat sheet

| Symptom | Flip |
|---|---|
| Need to stop all writes briefly | `maintenance_mode` → ON |
| Map upload spam wave | `uploads_enabled` → OFF |
| New-account abuse / shared-IP wave | `registration_enabled` → OFF |
| Server OOM during preview / validation | `heavy_compute_enabled` → OFF (then bulk-drain manually) |
| Need to pause weekly snapshots | `weekly_backups` → OFF |
| Need to disable revert / restore | `per_contribution_revert` / `backup_restore` → OFF |
