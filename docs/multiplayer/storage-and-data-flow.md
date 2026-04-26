# Storage & data flow

The multiplayer pipeline touches three storage systems plus the user's machine. Knowing what lives where prevents most "how do I clean this up" / "why is this stale" confusion.

## The four locations

### 1. The user's local game directory

`%AppData%\VintagestoryData\` on Windows. The source of every `.db` and every log file. We never touch this directly — the user picks files from it via the browser file pickers.

### 2. The browser

For [Identify Maps](./identify-maps.md): logs, settings, and `.db` filenames are read entirely client-side. Nothing is sent. For other pages: `.db` contents are uploaded only when the user explicitly hits Render or Submit.

For [TOPS Map](./tops-map.md): chunks are fetched directly from R2 via presigned URLs and stitched onto an offscreen canvas. The backend never proxies the chunk bytes.

### 3. Cloudflare R2

R2 holds anything large or binary:

| Key | What it is | Lifecycle |
|-----|------------|-----------|
| `globalservermap.db` (`COMBINED_DB_KEY`) | The merged community map, source of truth for all rendering | Overwritten on every approval |
| `pending/<id>.db` | A user's contribution awaiting review | Created on upload, deleted on approve/reject/withdraw |
| `pending/<id>.preview.png` | Cached green-tinted preview render | Created on first preview, deleted on approve/reject/withdraw |
| `archived/<id>.db` | Approved contributions, kept for forensics | Created at approval (move from pending) |
| `tops_map/level_<N>/metadata.json` | Geometry of one resolution level | Rewritten on level (re)generation |
| `tops_map/level_<N>/chunk_<cx>_<cy>.png` | One stitched cell | Rewritten when its area is regenerated |

Why R2: huge files are cheap there, egress is free for our use, and presigned URLs let the browser fetch directly without going through FastAPI.

### 4. Supabase Postgres

Supabase holds metadata, state, and small caches:

| Concept | Notes |
|---------|-------|
| `contributions` | One row per submission. `status` is `pending`/`approved`/`withdrawn`. `submitted_by_key` is the only link from contribution to user, used by withdraw |
| `app_state` (`tops_map_generation_status` key) | Live JSON of generation progress per level, written by the background job |
| `tops_map_stats` cache | Pre-computed stats blob served by `/api/tops-map-stats` — refreshed on approval |
| `tile_count` cache | Total tile count for the dashboard (avoid scanning the combined DB on every info call) |
| Chunk URL cache | Presigned URLs for each `(level, cx, cy)` with `expires_at`. Reused across requests to avoid re-signing 256 URLs every page load |
| Generation tracker | Same `app_state` blob, structured as `levels[<level>][progress, status, current_chunk, ...]` |
| `regen_queue` | Pending TOPS-map regen requests. Producers (approvals, admin button) append rows; the worker drains atomically with `DELETE ... RETURNING *` and coalesces them into one pass. Survives process restarts; `resume_pending_work()` at startup spawns the worker if rows exist |

We never store IPs, raw user files, or PII in Supabase. Everything personally identifiable about a contributor is just the optional `contributor` display name plus the API key reference.

## Why this split

The two natural questions:

**"Why not just put `globalservermap.db` in Supabase Postgres?"**
Postgres isn't built for hundreds of MB of binary blobs that get rewritten in full every approval. Even if it worked, the cost would be terrible and the read path (download for SQLite operations) would be the same.

**"Why not put metadata in R2 too?"**
R2 has no transactions, no atomic increments, no joins. The contribute permission, cooldown, and approval ordering need real database semantics. Putting that in R2 would require either an external lock service or accepting race conditions that, for example, allow two simultaneous approvals to corrupt the merged DB.

The split is "blobs in R2, state in Postgres" — the same pattern most modern apps end up with.

## Lifecycle of a single contribution

```
t=0   User uploads .db
        ↓ (browser → R2 directly via presigned PUT)
        R2: pending/<id>.db
t=1   /contribute/complete
        ↓
        R2 read for validation
        Supabase: contributions row INSERT (status=pending)
t=2   Admin opens contribute page
        ↓
        Supabase: list_pending_contributions
        R2: presigned GET for each pending preview (or generates one)
t=3   Admin clicks Preview
        ↓
        R2: pending/<id>.preview.png served (cache hit), or
        R2 read combined + pending → render → R2 write preview → serve
t=4a  Admin Approves
        ↓
        R2 read combined + pending → merge in temp → R2 write combined
        R2 move: pending/<id>.db → archived/<id>.db
        R2 delete: pending/<id>.preview.png
        Supabase: contributions UPDATE (status=approved, stats)
        Supabase: tile_count + tops_map_stats cache UPDATE
        Background: generate_map_levels job for affected_bounds
          for each level: render affected chunks → R2 write
                          Supabase: progress UPDATEs as each chunk completes
                          Supabase: status complete + invalidate metadata cache
t=4b  Admin Rejects (alternative)
        ↓
        R2 delete: pending/<id>.db, pending/<id>.preview.png
        Supabase: contributions DELETE
t=4c  Owner Withdraws (alternative)
        ↓
        R2 delete: pending/<id>.db, pending/<id>.preview.png
        Supabase: contributions UPDATE (status=withdrawn, contributor anonymised)
```

Total round-trips per approval: a handful of Supabase calls, three R2 reads (combined, pending, optional metadata of all levels) plus one R2 write of the combined DB, plus 1+ R2 writes per re-rendered chunk during the background job. The hot path is the chunk regeneration.

## What the operator can clean up

If you ever need to reclaim space or reset state:

| Goal | What to do |
|------|------------|
| Free old archives | `archived/<id>.db` is safe to delete; nothing reads from it on the hot path |
| Reset the chunk cache | Delete `tops_map/level_<N>/...` for the level(s) you want, then click regenerate. The metadata cache is in-process; restarting the backend clears it too |
| Reset cached chunk URLs | Delete from the chunk URL table — they'll be re-signed on the next request, no functional impact |
| Clear pending list | Don't do this manually — go through `/contribute/<id>/reject` so R2 and Supabase stay consistent |
| Force-recount tiles | Delete the `tile_count` cache row in Supabase; next info call refreshes it |
| Throw out the whole combined map | Delete `globalservermap.db` from R2, delete tops_map_stats and tile_count rows, restart. The next approval seeds an empty combined DB and rebuilds the cache. **All previously merged tiles are lost** unless you keep the archive |

## Failure modes worth knowing

- **R2 write of new combined DB fails after local merge succeeds.** The local temp file is still good but isn't restored to R2. Effect: next approval re-merges the same contribution against the *previous* combined DB, which is harmless because merges are idempotent (existing tiles are skipped). The user-visible damage is just one missed approval.
- **Archive move fails after merge succeeds.** Approval still returns success with `archive_warning`. The pending object stays in R2 — you can manually move or delete it. The merge itself is final.
- **Background regen crashes mid-job.** `_active_thread.is_alive()` returns false, but the level may be left in `status=generating` with stale progress. Click regenerate again to restart. The job is idempotent — chunks that already wrote successfully are simply overwritten.
- **Supabase outage during info polling.** The frontend gets a network error and shows it; nothing in R2 is affected. Once Supabase is back, all state is recovered from there.
