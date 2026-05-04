# Plan: TOPS Map Resources Overlay (admin-only)

Adds an admin-gated **Resources Overlay** layer to the TOPS map viewer that shows worldgen-derived data (ore deposits + biome / climate / rock-type tint) reconstructed from the world's seed, worldconfig, and exact Vintage Story version.

Because deterministic worldgen lives in the Vintage Story C# code, reconstruction happens **offline** via a headless VS dedicated server + a small exporter mod (run by the admin). The exported artefacts (deposits SQLite + climate raster tiles + manifest) are uploaded to R2 via a new admin endpoint and served back to the frontend, where a new overlay layer in [frontend/src/components/MapViewer.tsx](../frontend/src/components/MapViewer.tsx) and a `ResourcesDrawer.tsx` control panel render dots/heatmaps with filtering and click-to-inspect popups.

This is a standalone feature; it does **not** depend on the game-version overlay plan or the contribution flow.

---

## Decisions locked from clarification

- **Reconstruction method**: headless VS server + custom server-side mod that hooks into worldgen, force-generates the mapped area, and exports SQLite + raster files. No Python re-implementation of worldgen. The whole pipeline runs offline by the admin.
- **World identity**: a single canonical world, configured via env vars (`CANONICAL_WORLD_SEED`, `CANONICAL_WORLD_VS_VERSION`). No per-contribution seeds, no `savegame.vcdbs` upload.
- **Coverage**: only chunks that already appear in the merged tops map (bounding box derived from `globalservermap.db`).
- **Layers in v1**:
  - Ore deposits (surface + underground) rendered as colored points, type-filterable.
  - Biome / climate / rock-type as **heatmap raster tiles**: rock-type, temperature, rainfall, forest density.
- **No structures, traders, trees in v1.**
- **Visibility**: admin-only end-to-end. Frontend hides the UI behind `getStoredIsAdmin()`; backend gates every endpoint with `require_admin` from [backend/app/auth.py](../backend/app/auth.py).
- **Storage key**: R2 keyed by `<seed>-<version>` so swapping worlds/versions is a re-upload + env-var bump, not a migration.
- **Feature flag**: `resources_overlay` (default OFF). All endpoints 404 when off.

---

## Phase R1 — Offline exporter (out-of-repo tooling)

This phase is owned by the admin operator. The repo only ships:
- `backend/export_resources_bundle.py` — helper that derives the bounding box from `globalservermap.db`, packages exporter-mod outputs, renders climate raster PNGs at the same chunk-grid resolution levels as TOPS tiles (reuse constants from [backend/app/tasks/generate_map_levels.py](../backend/app/tasks/generate_map_levels.py)), writes `manifest.json`, and zips everything into one bundle.
- `docs/multiplayer/resources-overlay.md` — operator runbook.

### Bundle layout (zip)

```
manifest.json
deposits.sqlite              -- table deposits(chunk_x, chunk_z, type, x, y, z, qty, richness)
tiles/<layer>/level_<N>/chunk_<cx>_<cy>.png      -- one PNG per (layer, level, chunk)
```

### Manifest schema

```json
{
  "schema_version": 1,
  "seed": "...",
  "vs_version": "1.22.3",
  "generated_at": "2026-05-04T12:00:00Z",
  "world_bounds": { "min_x": -50000, "max_x": 50000, "min_z": -50000, "max_z": 50000 },
  "layers": [
    {
      "id": "rock",
      "kind": "heatmap",
      "legend": { "values": [{ "id": "granite", "label": "Granite", "color": "#9c9183" }, ...] },
      "levels": [2, 3, 4, 5]
    },
    { "id": "temperature", "kind": "heatmap", "scale": { "min": -20, "max": 35, "unit": "°C" }, "levels": [2, 3, 4, 5] },
    { "id": "rainfall",    "kind": "heatmap", "scale": { "min": 0,   "max": 1.0, "unit": "" },  "levels": [2, 3, 4, 5] },
    { "id": "forest",      "kind": "heatmap", "scale": { "min": 0,   "max": 1.0, "unit": "" },  "levels": [2, 3, 4, 5] }
  ],
  "deposit_types": [
    { "id": "copper",   "label": "Native copper",   "color": "#c87533" },
    { "id": "tinbronze", "label": "Cassiterite",    "color": "#5d6d7e" },
    ...
  ]
}
```

Server validates `manifest.seed == settings.CANONICAL_WORLD_SEED` and `manifest.vs_version == settings.CANONICAL_WORLD_VS_VERSION` before unpacking. Mismatch → 400.

---

## Phase R2 — Backend (FastAPI)

### Steps

1. **Config** — add to [backend/app/config.py](../backend/app/config.py):
   - `CANONICAL_WORLD_SEED: str` (default `""`)
   - `CANONICAL_WORLD_VS_VERSION: str` (default `""`)
   - `RESOURCES_BUNDLE_MAX_BYTES: int` (default 1 GiB)
   - `RESOURCES_DEPOSITS_PAGE_LIMIT: int` (default 5000)
2. **Feature flag** — register `resources_overlay` (default OFF). 404 from every route when off.
3. **R2 layout** — under `resources/<seed>-<version>/`:
   - `manifest.json`
   - `deposits.sqlite`
   - `tiles/<layer>/level_<N>/chunk_<cx>_<cy>.png`
   - Plus pointer key `resources/CURRENT` containing `<seed>-<version>` so the read path can find the active bundle without env vars matching.
4. **R2 helpers** (add to [backend/app/core/r2_storage.py](../backend/app/core/r2_storage.py) where natural):
   - `resources_prefix(seed, version) -> str`
   - `resources_manifest_key(seed, version) -> str`
   - `resources_deposits_key(seed, version) -> str`
   - `resources_tile_key(seed, version, layer, level, cx, cy) -> str`
   - `resources_pointer_key() -> str` (returns `"resources/CURRENT"`)
5. **New router** [backend/app/routes/resources.py](../backend/app/routes/resources.py), all gated by `require_admin`:
   - `POST /admin/resources/upload` — streams a `.zip` to a temp file (mirror the upload pattern in `contribute_r2.py` `contribute_upload`), enforces `RESOURCES_BUNDLE_MAX_BYTES`, validates manifest seed + version against env vars, unpacks into a staging prefix `resources/<seed>-<version>.staging/`, then atomically swaps the pointer key.
   - `GET /admin/resources/status` — returns `{ active_bundle: { seed, version, generated_at, size_bytes, uploaded_at } | null, canonical: { seed, version } }`.
   - `GET /admin/resources/manifest` — returns the active bundle's manifest JSON augmented with presigned tile URLs (reuse presign helpers from [backend/app/routes/tops_map_r2.py](../backend/app/routes/tops_map_r2.py); 7-day TTL with refresh buffer).
   - `GET /admin/resources/deposits?min_x=&max_x=&min_z=&max_z=&types=&cursor=` — bounds-filtered, type-filtered, paginated up to `RESOURCES_DEPOSITS_PAGE_LIMIT` per page; backed by an LRU on-disk cache of `deposits.sqlite` (download once per server lifetime / per active bundle).
6. **Wire into [backend/app/main.py](../backend/app/main.py)** alongside the other admin routers.

### Verification

- Upload rejects bundles whose `manifest.seed` / `vs_version` don't match canonical env vars (400).
- Upload rejects malformed zips and oversize uploads (400 / 413).
- `/admin/resources/deposits`: bounds + type filter honored, page limit enforced, returns 503 when no bundle is uploaded.
- All endpoints 404 when `resources_overlay` flag is off.
- Non-admin keys get 403 from every endpoint.

---

## Phase R3 — Admin upload page

### Steps

1. **API helpers** — add to [frontend/src/lib/api.ts](../frontend/src/lib/api.ts):
   - `getResourcesStatus()`, `uploadResourcesBundle(file, onProgress)`, `getResourcesManifest()`, `getResourcesDeposits(query)`.
2. **Page** — new [frontend/src/pages/admin/AdminResourcesPage.tsx](../frontend/src/pages/admin/AdminResourcesPage.tsx):
   - Status card (active bundle seed/version/size/uploaded-at + canonical seed/version with mismatch warning).
   - Drag-and-drop `.zip` upload form with progress bar and toast feedback.
3. **Route + nav** — wire into [frontend/src/components/AppContent.tsx](../frontend/src/components/AppContent.tsx) alongside the other `/manage/*` admin routes.

### Verification

- Page only reachable while admin. Direct `/manage/resources` URL while non-admin yields the standard "not authorised" treatment that the other admin pages use.
- Upload progress reports 0 → 100%, success toast on completion, error toast on backend rejection (with the backend `detail` shown).
- Re-uploading a different bundle replaces the previous one.

---

## Phase R4 — Viewer overlay

### Steps

1. **Hook** — new [frontend/src/hooks/useResourcesOverlay.ts](../frontend/src/hooks/useResourcesOverlay.ts):
   - Loads manifest once (admin only), tracks presigned-URL staleness mirroring `TOPSMapViewPage.tsx`.
   - Debounced viewport-bound deposit fetch on `MapViewer`'s `onViewportChange`; tile-bucketed cache; cancels in-flight requests on viewport change.
2. **Generic overlay support in MapViewer** — extend [frontend/src/components/MapViewer.tsx](../frontend/src/components/MapViewer.tsx) with an `overlays?: OverlayDescriptor[]` prop. Each descriptor declares `{ id, kind: 'tiles' | 'points', opacity, draw(ctx, viewport) }`. Heatmap layers reuse [frontend/src/lib/stitch-chunks.ts](../frontend/src/lib/stitch-chunks.ts) on a separate offscreen canvas composited at the configured opacity. Deposits drawn as colored dots with simple grid-bucket clustering when `pixelsPerBlock` is below a threshold.
3. **Drawer** — new [frontend/src/components/tops-map/ResourcesDrawer.tsx](../frontend/src/components/tops-map/ResourcesDrawer.tsx) mirroring [frontend/src/components/tops-map/TLGroupingsDrawer.tsx](../frontend/src/components/tops-map/TLGroupingsDrawer.tsx):
   - Heatmap-layer toggles + opacity sliders + legend.
   - Deposit-type filter list with color swatches and per-type visibility.
   - Reset button.
   - LocalStorage keys: `tops-map-resources-active-layers`, `tops-map-resources-deposit-filters`, `tops-map-resources-opacity`.
4. **Popup** — click handler on a deposit dot opens a small floating card with `{type, qty, richness, depth, world coords}`.
5. **Wire into [frontend/src/pages/TOPSMapViewPage.tsx](../frontend/src/pages/TOPSMapViewPage.tsx)** behind `getStoredIsAdmin()`, same pattern as `AdminResolutionPanel`.

### Verification

- Non-admin sessions never see the drawer button.
- With a fixture bundle uploaded, each heatmap toggles independently with the opacity slider; each deposit type can be hidden/shown.
- Spot-check a known in-game deposit (e.g. a copper outcrop verifiable in-game) against rendered overlay coordinates.
- Presigned-URL refresh behaves like the base TOPS tiles (reload after >7 days or mock TTL).

---

## Further considerations (decide later)

1. **Bundle retention** — overwrite vs. keep last N? Recommend keeping the last 2 for cheap rollback (cost is trivial).
2. **Deposit query strategy** — server-side SQL per request (Phase R2 default) vs. ship the whole `deposits.sqlite` to the admin browser once (zero per-pan latency). Recommend the client-side option iff final size stays under ~20 MB gzipped; otherwise keep the paginated server-side query.
3. **Future public release** — endpoints are namespaced under `/admin/resources/`; promoting to public is a one-line swap of `require_admin` for a feature-flag check, no rearchitecting.
