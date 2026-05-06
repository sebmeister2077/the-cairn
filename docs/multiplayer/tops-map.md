# TOPS Map

> Frontend route: `/multiplayer/tops-map`
> Page: [frontend/src/pages/TOPSMapViewPage.tsx](../../frontend/src/pages/TOPSMapViewPage.tsx)
> Stitching: [frontend/src/lib/stitch-chunks.ts](../../frontend/src/lib/stitch-chunks.ts)
> Backend: [backend/app/routes/tops_map_r2.py](../../backend/app/routes/tops_map_r2.py)
> Cache job: [backend/app/tasks/generate_map_levels.py](../../backend/app/tasks/generate_map_levels.py)
> Status tracker: [backend/app/core/generation_tracker.py](../../backend/app/core/generation_tracker.py)

## What it is

The shared, public-facing map of the curated server. It's whatever the merged `globalservermap.db` contains, sliced into a multi-resolution chunked image grid that the browser stitches into a single zoomable map. Most non-admin users will only ever interact with this page.

## Why we don't just serve one big PNG

The original implementation did exactly that, and it broke as soon as the contributed map got large:

- A single 16384×16384 PNG is hundreds of MB. R2 egress for one is fine; rendering one in-process on Render's free tier can OOM.
- A user toggling between two zoom levels would re-fetch the whole thing.
- Partial regeneration after a small contribution required re-rendering the whole map.
- The browser had to load the entire PNG before showing anything.

The current design replaces the single image with a **grid of independently rendered, independently cached chunks**, pre-rendered at multiple resolution levels and stitched in the browser:

```
RESOLUTION_LEVELS = {1: 2048, 2: 4096, 3: 8192, 4: 16384, 5: 1048576}  # L5 = 1:1 / full resolution
CHUNK_GRID_SIZE = 16          # 16×16 = 256 chunks per level
DEFAULT_RESOLUTION_LEVEL = 2  # what new viewers load first
```

Level 2 (4096px max dim) is the default because it's the sweet spot for "fits the viewport with room to zoom" without paying the level-3/4 bandwidth cost up front. Users who actually zoom in get level 3 or 4 fetched on demand.

## Storage layout

For each level we store in R2:

- `tops_map/level_<N>/metadata.json` — geometry: image dimensions, chunk dimensions, scale, world-block bounds.
- `tops_map/level_<N>/chunk_<cx>_<cy>.png` for each `cx, cy` in `[0, 16)` — one PNG per grid cell.

The chunk dimensions are calculated so that the last column and last row absorb any remainder pixels. The frontend's tile set computes the actual width/height per tile as `min(chunk_w, image_w - px)` so boundary chunks line up exactly with the assembled image.

## Endpoints

### `GET /api/tops-map-stats`

Reads the cached stats blob from Supabase (`db.get_tops_map_stats`) — these are pre-computed by `pregenerate_tops_map_cache.py` or refreshed on every approval. If the cache is empty, returns 503 with a hint to run the script. The response also includes:

- `default_level` — the largest available level ≤ `DEFAULT_RESOLUTION_LEVEL`, or the lowest available, or null.
- `resolutions[]` — for each configured level: `level`, `max_dimension`, `status`, `generated_at`, `size_bytes`, `progress`. Used to render the admin generation panel.

### `GET /api/tops-map-level/{level}`

The main data feed. Returns the level metadata plus a list of `chunks` where each entry is `{cx, cy, url, expires_at}`. The `url` is a presigned R2 GET URL.

Behaviour:

- If the level metadata.json doesn't exist in R2, returns 404 with the current generation status (`status`, `progress`). The frontend uses this to show "Generation in progress, X% complete".
- Even if the level is partially generated, the endpoint returns whatever chunks exist. The browser stitches incrementally, so the user sees the map filling in chunk-by-chunk as generation proceeds.
- The presigned URLs are cached in Supabase via `db.get_cached_chunk_urls` / `db.upsert_chunk_urls`. On every call we keep URLs that still have ≥30 minutes until expiry and regenerate the rest.
- An opportunistic cleanup of expired URL rows runs at most once per hour across the whole process.

### `GET /api/tops-map-render` (legacy)

Renders the entire combined DB to a single PNG on demand. Kept for CLI users; **the TOPS map page does not call it**. The clamp is `[256, 16384]` so even legacy clients can request high-detail output, but the cost falls on the caller.

## Presigned URL lifecycle

Constants:

```python
_CHUNK_URL_EXPIRY_SECONDS = 24 * 60 * 60     # 24 h validity
_CHUNK_URL_REFRESH_BUFFER_SECONDS = 30 * 60  # rotate when within 30 min of expiry
```

The 24-hour TTL is long enough to survive a normal browsing session including coffee breaks, intermediate caches, and tab restores, while still being short enough that a leaked URL stops working within a day.

The frontend adapts its query stale time to the URL expiry: it re-fetches the level info **2 minutes before** the earliest URL expires (`levelInfoStaleTimeMs`), so it never tries to draw a chunk with a just-expired URL. If a level info is loaded that is *already* past expiry (e.g. tab restored from a stale cache), `isLevelInfoExpired` triggers an immediate refetch.

The metadata.json is in-process-cached (`_metadata_cache`) because it's immutable for the lifetime of a generated level. `invalidate_level_metadata_cache(level)` is called whenever a level is regenerated.

## Background regeneration

Triggered automatically after every contribute approval (with affected bounds), and manually by admins via the resolution panel.

### The regen queue

Regeneration requests are persisted in the Postgres table `regen_queue` before any worker touches them. A request row carries:

- An optional world-block bounding box (`min_x, max_x, min_z, max_z`), or
- A `full_regen` flag if no bbox was provided, plus
- An optional JSON list of resolution levels (NULL means "all configured levels").

`start_job(levels, affected_bounds)` always inserts a row first, then starts the in-process worker thread if one isn't already alive. It never rejects a request just because work is in progress — that was the source of the original "second approval silently dropped" bug.

### The worker loop

A single in-process worker thread runs at a time, gated by `_job_lock` + `_active_thread`. Inside `_worker_loop`:

1. **Drain** every row from `regen_queue` in one atomic `DELETE ... RETURNING *` (so two workers cannot race for the same rows even if a future deployment fans out).
2. **Coalesce** the rows into a per-level work plan via `_coalesce_queue_entries`:
   - For each level any row targets, take the union of all bounding boxes that mention it.
   - If any row demands a full regen of that level, the level is marked full and bbox unioning is short-circuited.
3. **Run one pass**: download the combined DB to a temp file once, then iterate the planned levels.
4. **Drain again** at the end of the pass:
   - If new rows arrived during rendering, run another pass.
   - If the drain returns empty *while holding `_job_lock`*, clear `_active_thread` and exit. Holding the lock here is what makes the exit safe: a producer trying to enqueue cannot slip past the drain and find the worker gone.
5. On startup, `resume_pending_work()` checks `regen_queue` and spawns the worker if rows exist — covers the "process restarted mid-pass" case.

For each level being generated (one pass = one call to `_generate_level`):

1. `compute_level_geometry` reads the bounds from the local combined DB.
2. The level's metadata.json is written to R2.
3. **If `affected_bounds` was provided**, only chunks whose grid cells intersect those world-block bounds (computed via `world_block_bounds_to_chunk_indices`) are re-rendered. Everything else stays as-is.
4. **Otherwise** all 256 chunks are rendered.
5. Per chunk: render → upload to R2 (or `delete_object` + `delete_chunk_url` if the chunk is fully transparent), then `tracker.update_progress(level, completed, current_chunk)` writes progress to Supabase.
6. The cached presigned URL row in `tops_map_chunk_urls` is dropped per chunk so the next viewer request signs a fresh URL pointing at the new bytes.
7. When a level finishes, the in-process metadata cache for that level is invalidated and the legacy assembled-PNG R2 key is best-effort deleted.

Memory-wise, the bound is "one chunk's RGBA buffer at a time" — a 1024×1024 RGBA buffer is ~4 MB, easily inside Render's free-tier RAM. The old single-PNG path peaked at hundreds of MB on the combined map.

The status JSON shape is documented at the top of [generation_tracker.py](../../backend/app/core/generation_tracker.py); the relevant fields are `status` (one of `not_generated`, `generating`, `complete`, `failed`), `progress` (0..100), `current_chunk` (`"<cx>-<cy>"`), `completed_chunks`, `total_chunks`, `size_bytes`, `error`.

### Geometry-change guard (partial regen safety)

`_generate_level` re-reads the previous `metadata.json` from R2 before honouring an `affected_bounds` partial regen. If any of `scale`, `chunk_w`, `chunk_h`, `start_x`, `start_z`, `chunk_grid`, `image_w`, or `image_h` differ from the freshly-computed geometry, it logs a warning and promotes the request to a full regen.

Why: chunks left untouched by a partial regen still live at keys `chunk-<cx>-<cy>.png`, but those `(cx, cy)` coordinates encode a different world region under the new metadata. Reusing them would silently misalign the stitched map. This commonly happens when an approval expands the world bounds (e.g. tens of thousands of blocks northward) — `min_z` shifts, `scale` typically grows, `start_z` changes, and every reused chunk would be drawn at the wrong pixel offset.

First-ever generation (no prior `metadata.json`) is treated as "no prior state", so partial regens proceed normally — there's nothing to misalign against.

### Parallel regen path (`TOPS_MAP_PARALLEL_REGEN`)

Opt-in performance path implemented in [`_render_level_parallel`](../../backend/app/tasks/generate_map_levels.py) and [`render_level_streaming`](../../backend/app/core/mapdb.py). Disabled by default; toggled with environment variables on the worker process:

| Variable | Default | Effect |
|---|---|---|
| `TOPS_MAP_PARALLEL_REGEN` | `0` (off) | When `1` / `true` / `yes` / `on`, every level inside a regen pass uses the parallel pipeline below. When off, the original serial loop runs and behaviour is unchanged. |
| `TOPS_MAP_PARALLEL_REGEN_WORKERS` | `min(8, cpu_count())`, clamped to `[1, 16]` | Size of the per-level `ThreadPoolExecutor` that handles PNG encode + R2 upload. |

What changes when the flag is on (per level):

1. **One read-only / immutable SQLite connection per level** instead of one per chunk. `_open_mapdb_readonly` opens the cached combined DB via the URI `file:/...?mode=ro&immutable=1`, which lets SQLite skip locking, journal recovery, and file-change detection. Page cache is bumped to 32 MB and 256 MB of mmap is allowed. Roughly eliminates the ~1280 connection open/close pairs (256 chunks × 5 levels) the serial path does on a full regen.
2. **One SELECT per chunk-row instead of one per chunk.** `render_level_streaming` walks the grid row-by-row (`cy = 0..grid-1`), issues a single `SELECT position, data FROM mappiece WHERE position BETWEEN ? AND ?` covering the whole row's z-range, decodes each tile blob exactly once, and distributes its pixels to every chunk in the row whose pixel rect the tile overlaps. Cuts query overhead by ~`grid`× — significant on level 5 (64×64 grid → 64 queries instead of 4096) and level 4 (32×32 → 32 queries instead of 1024).
3. **PNG encode + R2 upload run in a thread pool.** As each chunk's RGBA buffer comes off the streaming generator, it is submitted to a `ThreadPoolExecutor` running `_encode_and_upload_chunk`. Both Pillow's PNG compressor (zlib in C) and boto3's HTTPS upload release the GIL for the bulk of their work, so a thread pool gives near-linear speedup up to the point where outbound bandwidth saturates.
4. **Bounded in-flight queue.** At most `2 × TOPS_MAP_PARALLEL_REGEN_WORKERS` futures are pending at once. If R2 stalls, the streaming generator blocks before allocating more RGBA buffers, capping memory at roughly `(workers × chunk_w × chunk_h × 4) + (one row of buffers)`.
5. **Stop signal** is checked between submissions; the executor's context manager waits for currently-running encode/upload tasks to finish before propagating the stop, so R2 never sees a half-uploaded PNG.

What does **not** change:

- The progress tracker keys (`completed_chunks`, `current_chunk`) and Supabase writes — `_render_level_parallel` updates them under a lock as each future resolves.
- Empty-chunk handling (delete the R2 object + presigned URL row).
- The geometry-change guard, orphan-chunk cleanup pass on full regen, and metadata.json upload at level end.
- The regen-queue / coalesce / worker-loop scheduling above this layer.
- R2 object keys, frontend stitching, presigned URL caching.

Rollback: unset `TOPS_MAP_PARALLEL_REGEN` (or set it to `0`) and redeploy. No DB or R2 schema changes are involved, so flipping back and forth between passes is safe.

When to enable: any time the worker process has ≥ 2 CPUs and reasonable outbound bandwidth to R2. On a single-CPU instance the gains are smaller but still real (the row-stripe SELECT alone is a win) and memory cost is modest.

### What burst approvals look like

Five approvals landing inside a 5 s window now produce, in order:

1. Approval #1 enqueues, worker starts, drains row 1, begins rendering its bounds.
2. Approvals #2–#5 each enqueue a row while the worker is busy; nothing else happens immediately.
3. Worker finishes pass 1, drains rows 2–5, coalesces them into one bbox-union per level, runs pass 2.
4. Drain after pass 2 is empty under the lock → worker exits.

Net effect: every contribution's tiles appear in the chunk grid after at most one extra rendering pass, no manual intervention required.

## Frontend stitching

`stitch-chunks.ts` does:

1. Create an offscreen `<canvas>` of size `(image_w, image_h)`.
2. For each chunk: fetch the URL → blob → `<img>` → `drawImage(img, cx*chunk_w, cy*chunk_h)`.
3. Bounded concurrency (`DEFAULT_CONCURRENCY = 6`) so we don't open 256 simultaneous fetches and starve the connection pool.
4. After every chunk, fire `onProgress(... canvas)` so the page can rebuild the viewer image incrementally. Users see the map fill in instead of a blank canvas until the last chunk arrives.

The level identity used by the viewer is just the level number, not the URL set. URL rotations (24h presigned refresh) keep the same identity, which is critical because we don't want pan/zoom state to reset every time the URLs refresh.

## Overlays (translocators, landmarks, local-radius filter)

Two static GeoJSON datasets shipped with the frontend:

- [frontend/src/assets/translocators.geojson](../../frontend/src/assets/translocators.geojson) — pairs of world coordinates connected by a line segment, with `depth1`/`depth2` (Y values at each endpoint) and optional `label` and `tag`.
- [frontend/src/assets/landmarks.geojson](../../frontend/src/assets/landmarks.geojson) — point features with a `label`, `type` (e.g. "Base"), and `z` (Y coordinate).

These are **not** computed from the map data; they're hand-curated server-specific assets. They're loaded lazily on overlay toggle (with a single in-flight promise per dataset to dedupe), cached for the page session, and rendered as overlays by `MapViewer`.

The "show local radius only" filter (`TL_FILTER_CENTER = (2250, 12500)`, `TL_FILTER_RADIUS = 500`) is a hardcoded center/radius for the curated server's spawn region. It's a UX shortcut so a user looking at "the area near spawn" doesn't have to scroll past hundreds of out-of-region translocators.

The selected landmark/translocator and search input also drive `MapViewer`'s focus point, which pans the canvas to the selected feature.

### Favorite TL groupings (local-only)

A user-facing way to deal with the "too many TLs cluttering the map" problem without having to ship server-side preferences. Users build named **groupings** of translocators and either filter the map down to only those TLs or highlight them while still rendering the rest.

> Lib: [frontend/src/lib/tl-groupings.ts](../../frontend/src/lib/tl-groupings.ts)
> Drawer: [frontend/src/components/tops-map/TLGroupingsDrawer.tsx](../../frontend/src/components/tops-map/TLGroupingsDrawer.tsx)
> Sheet primitive: [frontend/src/components/ui/sheet.tsx](../../frontend/src/components/ui/sheet.tsx)
> Multi-highlight in viewer: [frontend/src/components/MapViewer.tsx](../../frontend/src/components/MapViewer.tsx) (`highlightedSegments` prop)

**TL identity.** Each segment is keyed by its coordinate tuple `${x1},${z1},${x2},${z2}` (after the same z-negation transform applied at geojson-load time). Stable against ordering changes; only fragile if the underlying TL itself is edited or removed. The drawer surfaces a `(N missing)` badge per grouping rather than auto-pruning so the user can decide.

**Storage.** Local-only. Three localStorage keys, all per-browser:

| Key | Shape | Purpose |
|-----|-------|---------|
| `tops-map-tl-groupings` | `{ version: 1, groupings: TLGrouping[] }` | The groupings themselves |
| `tops-map-tl-groupings-view-mode` | `"all" \| "filter" \| "highlight"` | Active view mode |
| `tops-map-tl-groupings-active` | `string[]` (grouping ids) | Which groupings are toggled on |

`useTLGroupings()` exposes the CRUD API (`createGrouping`, `renameGrouping`, `deleteGrouping`, `addTLs`, `removeTLs`, `toggleTL`, `setColor`) plus `importJSON(json, mode)` and `exportJSON()`. Cross-tab sync is handled by listening to the standard `storage` event so a change in one tab updates the other without polling.

**View modes.** `all` is unchanged behavior. `filter` renders only the union of TLs in the active groupings (translocator count flips to "N / total shown"). `highlight` renders everything but emphasises the union via the same hover/highlight style used for a pinned TL — implemented by `MapViewer`'s new `highlightedSegments` prop, which builds a `Set` of indices and combines additively with the existing single-segment `highlightedSegment`.

**Edit mode.** A grouping can be put into edit mode from the drawer; this overrides the click handler so left-clicking any TL toggles its membership in that grouping. Right-click pinning is suppressed while editing. Edit mode forces the translocator overlay on (otherwise there'd be nothing to click) and renders all current members as highlighted so the user always sees the running selection. A banner above the viewer shows the current count and a "Done" button.

**Import / export.** Export downloads the same versioned envelope as the storage payload as `tops-tl-groupings-YYYY-MM-DD.json`. Import opens a confirmation dialog with **Replace** (overwrite the stored list) or **Merge** (re-id every imported grouping and append). Malformed JSON shows an inline error and changes nothing.

**Deliberate non-goals.** No server sync, no URL-based sharing, no per-grouping color on the map (the drawer stores `color` on the type but the viewer currently uses the same highlight style for everything — adding per-grouping colors would extend `MapViewer` to accept a colored-segments map). No search/filter inside the drawer itself.

## Admin resolution panel

Admins (`getStoredIsAdmin()`) see an extra dialog from the Settings icon. It surfaces:

- The status of every level (`status`, `progress`, `generated_at`, `size_bytes`).
- Buttons to regenerate any level on demand (full regen, no `affected_bounds`).
- Live progress while a job runs.

The panel polls `tops-map-stats` (which embeds `resolutions[]`) so progress updates show up without a page reload.

## Why the legacy `tops_map.py` still exists

The disk-backed `tops_map.py` and `contribute.py` remain in the repo as the original implementation. They're not imported by `main.py` — `from .routes import contribute_r2 as contribute` and `from .routes import tops_map_r2 as tops_map` rebind the names. They're kept for reference and as a fallback we could swap back to in dev if R2 is misconfigured. Don't add features to them.
