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

## Permissions and rate limiting

Three permission tiers apply:

- **Read API key** (any valid key): can view the contribute info page (totals, pending list with friendly previews).
- **Read & Contribute API key** (`verify_contribute_permission`): can request upload URLs, complete uploads, and submit contributions. The frontend hides the form entirely if `getStoredCanContribute()` is false.
- **Admin API key** (`settings.ADMIN_API_KEY`, checked by `_verify_admin_key`): can approve/reject. Admins also bypass cooldown and per-user-pending limits.

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

## Withdraw (owner-initiated)

`POST /contribute/{id}/withdraw` is the owner-only escape hatch. It:

1. Verifies the contribution is still `pending` (anything else returns 409).
2. Verifies `submitted_by_key == api_key`. Other users — even admins, via this endpoint — get 403.
3. Deletes the `.db` and cached preview from R2.
4. Marks the row `status = 'withdrawn'` and anonymises the contributor name in Supabase (`db.withdraw_contribution`).

The row stays visible in `withdrawn` so the dashboard makes it clear what happened, and so an admin can see "user withdrew before review" patterns. There is no "un-withdraw" — the user has to upload again, which then resets the cooldown the way any new submission does.

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
8. Delete the cached preview PNG.

The merge is **not transactional across R2 + Supabase**. If the R2 upload of the new combined DB fails after the local merge succeeds, the next approval will operate on the stale R2 copy. In practice this hasn't been a problem because the merge is idempotent — re-applying a contribution skips all already-present tiles.

## Reject

`POST /contribute/{id}/reject` (admin only):

1. Confirms the contribution is `pending`.
2. Deletes `pending/<id>.db` and `pending/<id>.preview.png` from R2.
3. Calls `db.delete_contribution` to hard-delete the metadata row.

Unlike withdraw, rejection is destructive. There's no "withdrawn" trace left for the user to see. We do this rather than a soft "rejected" status because the rejection reason isn't stored anywhere, so a "rejected" badge with no explanation would just confuse the user.

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

There is **no** entry in the admin audit log (`admin_audit_log`) for contribute approvals — those go through Supabase's contribution tables instead. If you need a unified audit trail across user/account actions and contribute actions you'll have to join the two.
