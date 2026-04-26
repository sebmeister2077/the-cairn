# Local Map Viewer

> Frontend route: `/multiplayer/map-viewer`
> Page: [frontend/src/pages/MapViewPage.tsx](../../frontend/src/pages/MapViewPage.tsx)
> Backend: [backend/app/routes/mapview.py](../../backend/app/routes/mapview.py)

## What it does

Lets a user upload a single Vintage Story `.db` (their personal map cache for any server) and get back:

1. **Stats**: tile count, bounds, decoded pixel size — useful to know whether the file is "interesting" before paying the rendering cost.
2. **A PNG render** of the world cached in that DB, displayed in the same `MapViewer` component the TOPS map uses (pan/zoom/click-coordinates).

The user can render in either fast-preview or full-detail mode and download the result.

## Why this exists separately from TOPS Map

The TOPS map is one server's *shared, curated, merged* map. Local Map Viewer is for **anything else**:

- Looking at a server's map without contributing it.
- Inspecting a single-player world.
- Comparing what *you* have locally to what's on the public TOPS map.
- Verifying a `.db` you found via [Identify Maps](./identify-maps.md) actually contains what you expect, before contributing.

It's the lowest-trust, lowest-state tool in the section: nothing is persisted, no cooldown applies, no admin sees it.

## Endpoints

Both endpoints take a multipart upload and require a valid `X-API-Key` (any key, no special permission). Both run `check_rate_limit` on the key.

### `POST /api/map-stats`

Streams the upload to a temp file with the global `MAX_UPLOAD_SIZE` cap. Calls `get_map_stats_from_path`, returns the JSON, deletes the temp file. Errors:

- `413` if the upload exceeds the size cap mid-stream.
- `400` for empty upload, missing `mappiece` table, or any other validation failure.

### `POST /api/map-render`

Same upload handling. Two extra form fields:

- `max_dimension` (default `4096`) — clamped to `[256, settings.MAP_RENDER_MAX_DIM]`. Anything outside that window gets silently clamped, not rejected.
- `fast_preview` (default `false`) — switches the renderer into the one-pixel-per-tile path described in [Map database format](./map-database-format.md#the-tile-blob-data).

Returns the PNG inline. The frontend wraps the response in `URL.createObjectURL` and feeds it into `<MapViewer>`.

## Why we stream uploads to disk

Two-step rationale:

1. SQLite needs a real path. Reading a multipart upload into memory just to write it to a temp path is double the RAM cost.
2. The upload size cap (`MAX_UPLOAD_SIZE`) is enforced **as bytes arrive**, not after. We accumulate `total_size` chunk-by-chunk and bail out the moment we exceed the cap. Otherwise FastAPI would happily buffer the entire body before we got a chance to reject it.

`_save_upload_to_temp` returns the temp path; the caller is responsible for `os.unlink`-ing it. We do that in a `finally` block so a failed render still cleans up.

## Frontend flow

The page does the two requests sequentially (stats first, then render) so the stats card can show *before* the heavy render finishes — important for very large maps where the render can take many seconds. There's also an "enhance" path that re-renders at a larger `max_dimension` after the user clicks through, used to pull more detail on demand.

The `fast preview` toggle defaults to **on**. Most users uploading a `.db` just want a quick look; full-detail rendering at 4096px on a fully-explored world DB is heavy enough that defaulting to slow mode would feel broken.

## What this page deliberately doesn't do

- It doesn't store anything. No DB row, no R2 object, no audit log entry — just a temp file deleted at the end of the request.
- It doesn't share results between users. Two users uploading the same `.db` get two independent renders.
- It doesn't merge anything into the TOPS map. That's exclusively [Contribute](./contribute.md).
- It doesn't accept any file other than a SQLite file with a `mappiece` table. There is no "free" PNG upload path here.
