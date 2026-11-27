# Rapids Exporter Integration: Elevation Overlay + Combined Rapids Plan

Integrate the two datasets from the **Rapids Exporter** mod (see
[`docs/multiplayer/rapids-exporter-format.md`](../docs/multiplayer/rapids-exporter-format.md)) into
the TOPS webmap:

1. **A new Elevation overlay**: a raster layer from the terrain height map.
2. **A combined Rapids overlay**: the existing recorded rapids merged with the ~33k generated
   (predicted) rapids. This follows the same pattern as the Traders layer, which merges the
   official, recorded and classified-claim sources behind one toggle.

Source export (untracked, **must not be committed as-is**):
`frontend/src/assets/RapidsAndElevation/efbc17b5-3362-45df-9c1c-a901a8a5615e/`

| File | Size | Use |
|---|---|---|
| `rapids_latest.json` (= `rapids_20261126_235310.json`) | 13.7 MB | Converted to a compact file (see A1). |
| `heightmap_20261127_005609/*.png` | 88 MB | Re-encoded to WebP (see B1). |
| `heightmap_20261127_005609/*.raw.png` | 29 MB | Downsampled (see B1). |
| `heightmap_20261127_005609/*.world.json` | 1 KB | Georef. |
| `job.json`, `rapids.jsonl` | | Internal resume state. **Ignore** (doc §4). |

---

## Findings from the actual data (verified 2026-11-27)

All numbers below were measured directly against the files.

### Recorded vs generated rapids

**Recorded vs generated rapids match block-exactly.** The format doc (§2.3) predicts a 2-8 block
offset with fuzzy matching. In practice the proxy records the **source** block, so the match is
exact.

| Measure | Value |
|---|---|
| Recorded rapids (`map-features.rapids.json`) | 323 |
| Recorded rapids inside the 45k scan square | 304 |
| Matched to a generated source at **dx = dy = dz = 0** | **291** |
| Matched at any other distance (1-16 blocks) | 0 |
| Recorded rapids inside the scan with no generated match | 13 |
| Recorded rapids outside the scan square | 19 |

- The 13 unmatched in-scan rapids are mostly `flow: d` / `still`, at y109 lakes, near spawn. They
  are the ~2 % the generator misses, or player-made.
- The 291 matches split into 241 `certain` and **50 uncertain** generated rapids. Those 50 are
  now *confirmed by observation*.
- Generated rapids contain no duplicates at the same X/Z.
- Recorded `rel` uses the same spawn (511997, 123, 512000) as generated `rel`. Both live in the
  same marker space.

So the merge key is the exact integer `(rel.x, abs.y, rel.z)`. No spatial-hash fuzzy match is
needed. Update doc §2.3 accordingly.

### Generated rapids payload sizes

| Format | Raw | Gzip |
|---|---|---|
| Pretty (as exported) | 13.7 MB | |
| Minified | 7.3 MB | 0.61 MB |
| **Compact rows** `[relX, absY, relZ, outflowIdx, likelihood‰]` | **0.83 MB** | **0.26 MB** |

### Height map

| Measure | Value |
|---|---|
| Raw size | 6000 × 6000 |
| Height range | 0..254 (`B` always 0), so it **fits in 8 bits** |
| Below sea level (Y < 110) | 13 % of columns |
| ≥ 133 (minimum rapid height) | 18.3 % |
| `world.json` origin | `412000` |
| Pixel size | 33.33 blocks/px |

The origin is the same as the climate and stability rasters, so the same `- 512000` offset
applies.

Re-encoding options:

| Asset | Size |
|---|---|
| Color PNG, as exported | 88 MB |
| Color, 6000 px WebP q80 | 14.9 MB |
| **Color, 4000 px WebP q80** | **6.3 MB** |
| Color, 3000 px WebP q82 | 3.7 MB |
| **Raw, 2000 px 8-bit gray PNG** | **2.7 MB** (16 MB RGBA decoded, same as climate) |
| Raw, 3000 px 8-bit gray PNG | 5.8 MB |
| Raw, 2000 px RGB16 PNG | 3.7 MB |

`lib/tops-map-view/png.ts` `decodePng` already supports colour type 0 (greyscale), so an 8-bit
raw needs no decoder changes.

### Claim derivation

There are 5 394 player-claim boxes. Today's `insideAnyClaim` is a linear scan per rapid. That is
fine for 323 rapids, but at ~33k rapids it becomes ~178M box tests on the main thread. **It needs
a grid index.**

---

## How the relevant existing pieces work

| Concern | Existing file | Notes |
|---|---|---|
| Recorded rapids load + claim derivation | `frontend/src/hooks/useRapidsOverlay.ts` | React Query. Marker `kind: "Rapids"`, `claimed`, `tooltip`. `RAPIDS_QUERY_KEY` is versioned. |
| Multi-source merge precedent | `frontend/src/lib/tops-map-view/landmark-points.ts` | Traders: official + recorded + claims, deduped, one toggle. Rapids: viewport-culled push. |
| R2 / bundle loader | `frontend/src/lib/tops-map-view/mapFeatures.ts` | `loadMapFeatures(category)`. |
| Marker drawing | `frontend/src/lib/tops-map-view/overlay-draw.ts` → `drawRapidsMarker` in `markerStyles.ts` | Bezier droplet per point, every redraw. |
| Hover tooltip | `WebCartographerMapViewer.tsx` (~L2263, ~L2711) and `MapViewer.tsx` (~L2323) | `{x, y, z, kind, claimed}`. Rapids show "claimed/unclaimed". |
| Raster overlay hook (closest analog) | `frontend/src/hooks/useTemporalStabilityOverlay.ts` + `lib/stability/loader.ts` | R2-hosted PNG, bundled `world.json`, `- 512000` offset. |
| Raster hover + threshold mask | `frontend/src/hooks/useClimateOverlay.ts`, `workers/climate-threshold.worker.ts`, `ClimateHoverReadout.tsx` | `sampleAt`, worker-built mask. |
| Raster layer `<img>` | `ClimateOverlayLayer.tsx` / `TemporalStabilityOverlayLayer.tsx` | Identical props. Reusable as-is. |
| One-raster-at-a-time group | `store/slices/mapView.ts` (`setShowRockStrata`, `setClimateSubToggle`, `setStabilityEnabled`) | Each enable turns the others off. |
| Toggles UI | `components/tops-map-viewer/AdvancedLayersSection.tsx`, `components/tops-map/FullScreenOverlay.tsx` | Both have a rapids switch + count. |
| Persistence / telemetry | `store/rootPersistence.ts`, `hooks/useMapLayerTelemetry.ts`, `lib/tops-map-view/mapLayerTelemetry.ts`, `components/usage/sections/UsageMapLayersSection.tsx` | |

---

## Part 0: Asset hygiene (do first)

1. **`frontend/.gitignore`**: add `src/assets/RapidsAndElevation/**` with a comment. The raw
   exports total ~150 MB. Commit only the derived artifacts below, under a new tracked folder:
   - **Rapids**: `src/assets/GeneratedRapids/<basename>/`.
   - **Elevation**: `src/assets/Elevation/<basename>/`, with `*.png` / `*.webp` ignored like
     Stability (only `world.json` + summary tracked).
2. **New script `scripts/prepare-rapids-export.py`** (Python, PIL + numpy; both already
   available). It takes the export folder path and:
   - Writes the compact rapids file (A1).
   - Writes the elevation color WebP, the 8-bit raw, and the downsampled raw's `world.json` (B1).
   - Prints the R2 upload targets.

   This makes a future re-run (after a game update) one command plus an upload.

---

## Part A: Combined Rapids overlay

### A1. Compact generated-rapids asset

`GeneratedRapids/rapids_<ts>/rapids.compact.json`:

```jsonc
{
  "v": 1,
  "generatedUtc": "...", "seed": 421943594,
  "worldSpawn": { "x": 511997, "y": 123, "z": 512000 },
  "scan": { "mode": "noise", "center": {...}, "radiusBlocks": 45000, "complete": true },
  "fields": ["relX", "absY", "relZ", "outflow", "likelihoodPermille"],
  "rows": [[-45016, 210, -5193, 2, 1000], ...]   // outflow: 0=n 1=e 2=s 3=w
}
```

- Size: 0.83 MB, 0.26 MB gzipped.
- Load it with a static dynamic `import()`, like the `BUNDLED` map in `mapFeatures.ts`, so Vite
  code-splits it and it only downloads when Rapids is on. Optionally host it on R2 too.
  `map-features.traderclaims.json` (26 MB) already ships this way, so a 0.8 MB chunk is fine.
- The timestamped folder name is the cache-buster.
- Drop the always-constant fields: `flow`, `height`, `code`, `claimed`, `owner`, `generated`.
- Reject at convert time if `seed` ≠ 421943594 or `scan.complete` is false (or warn and keep
  `complete: false` so the UI can say "partial").

### A2. Loader: `frontend/src/lib/rapids/generated.ts` (new)

- Exports `loadGeneratedRapids(): Promise<GeneratedRapidsFile>` (memoized) and
  `GENERATED_RAPIDS_META` (scan center/radius, `generatedUtc`, for the UI/legend).
- Decodes rows into
  `{ x: relX, y: absY, z: relZ, outflow: "n"|"e"|"s"|"w", likelihood: number }`.

### A3. Merge in `useRapidsOverlay.ts`

The traders-style merge happens **in the hook** rather than `landmark-points.ts`. Rapids have no
per-type filter, and merging once per load is cheaper than per viewport change.

1. Fetch all three sources in parallel:
   - recorded: `loadMapFeatures("rapids")`
   - player claims: `loadMapFeatures("playerclaims")`
   - generated: `loadGeneratedRapids()`
2. Build `Map<string, MergedRapid>` keyed by `` `${x}|${y}|${z}` `` (integers; recorded coords are
   floats like `502192.0`, so `Math.round`):
   - Insert generated rapids first, with `source: "generated"`.
   - For each recorded rapid:
     - On a hit, set `source: "both"` and `likelihood = 1` (observed, so it exists).
     - On a miss, insert with `source: "recorded"`, `likelihood: 1`, `outflow: undefined`.
3. Claim derivation through a **grid index**. Bucket the claim boxes into 256-block cells keyed by
   every cell each box overlaps, then test only the rapid's cell. Keep the existing rule:
   recorded `claimed: true` wins, otherwise use geometry.
4. Extend `RapidMarker`:

   ```ts
   source: "recorded" | "generated" | "both";
   likelihood: number;            // 0..1
   outflow?: "n" | "e" | "s" | "w";
   ```

5. Bump `RAPIDS_QUERY_KEY` to `["rapids", "v3-merged-generated"]`.
6. Return `{ markers, counts: { total, confirmed, recordedOnly, predicted, uncertain } }`, or keep
   the array and derive the counts in a `useMemo`. Both consumers (`TOPSMapViewPage`,
   `FullScreenOverlay`) read `.length` today, so update both.
7. If the merge measures > ~50 ms, move it to a worker. Expected cost is ~33k Map ops plus grid
   claim tests, which should be well under that.

### A4. Filters + state (`store/slices/mapView.ts`, `rootPersistence.ts`)

New persisted fields:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `rapidsShowPredicted` | boolean | `true` | Include generated-only rapids. Recorded and confirmed always show while Rapids is on. |
| `rapidsMinLikelihood` | number 0..1 | `0.5` | Hides predicted rapids below the threshold. A slider with stops 0 / 0.25 / 0.5 / 0.75 / 1, where 1 means "certain only". At 0.5, 4 235 low-likelihood predictions are hidden, leaving 28 608 visible. |
| `rapidsShowClaimed` | boolean | `true` | Optional. Hides claimed rapids, useful for finding free ones. |

Apply these filters in `buildLandmarkPoints` (rapids branch), next to the existing viewport cull,
so toggling them doesn't refetch.

### A5. Rendering

Colour stays **claim state**, as today: teal = unclaimed, orange = claimed + halo. Provenance and
certainty are layered on top:

- **Likelihood**: draw uncertain rapids with `globalAlpha = 0.35 + 0.65 * likelihood` and a dashed
  outline.
- **Confirmed (`both`)**: add a small white check/dot badge so "seen in-game" reads at a glance.
- **Recorded-only**: no badge needed. Optionally a thin white ring to tell it apart.

**Zoomed-out clustering for ~28k points** (decided). Today every rapid is a full bezier droplet on
every redraw, and hover hit-testing scans all projected points. Neighbouring rapids therefore
collapse into one sized cluster marker.

New module `frontend/src/lib/tops-map-view/rapids-clusters.ts`:

1. **Precompute the levels once per filter change**, not per frame. Use a fixed set of
   power-of-two grid cell sizes, e.g. `[256, 512, 1024, 2048, 4096, 8192]` blocks. For each level,
   fold the filtered rapids into `Map<cellKey, Cluster>`:

   ```ts
   interface RapidsCluster {
       x: number;
       z: number;              // centroid of members (not the cell centre)
       count: number;
       unclaimed: number;
       confirmed: number;
       uncertain: number;      // members with likelihood < 1
   }
   ```

   ~28k rapids × 6 levels is ~170k cheap ops (a few ms), rebuilt only when the data or the filters
   (`rapidsShowPredicted`, `rapidsMinLikelihood`, `rapidsShowClaimed`) change. That is negligible
   overhead, so dot mode is not needed as a fallback.
2. **Pick a level per viewport**, in `buildLandmarkPoints` (rapids branch), using the existing
   viewport bounds and `pixelsPerBlock` from `onViewportChange`:
   - Count the filtered rapids inside the culled viewport. **If < 100, show individual glyphs (no
     collapsing).**
   - Otherwise pick the smallest level whose cell is ≥ ~40 screen px (`cell × pixelsPerBlock ≥ 40`).
     These cell-size steps are the "few thresholds" that trigger more collapsing as you zoom out.
   - Within the chosen level, a cell with `count === 1` renders as the normal glyph. Cells with
     2+ members render as a cluster.
3. **Cluster marker**, new `drawRapidsCluster` in `markerStyles.ts`:
   - Disc radius `min(7 + 2.2 * log2(count), 16)` px. It grows gently and is capped, so it never
     gets huge.
   - Teal fill if any member is unclaimed, orange if all are claimed.
   - Count label inside, formatted `1.2k` for ≥ 1000. A thin white ring when `confirmed > 0`.
4. **Marker kind**: add `"RapidsCluster"` to `WorldPointMarker.kind`, carrying the cluster fields.
   Draw it in `overlay-draw.ts` and in `MapViewer.tsx` for the Cairn viewer.
   - Its tooltip reads `N rapids · U unclaimed · C confirmed`.
   - Clicking zooms in one level, centred on the cluster. Use the existing `focusPoint` mechanism.
5. Because at most a few hundred clusters are drawn, per-frame draw cost and the hover hit-test
   stay small at every zoom.
- **Optional, zoomed in**: draw a short tick in the `outflow` direction (n = −Z, e = +X, s = +Z,
  w = −X) when the zoom is high enough for it to read. It shows which mountain face the rapid
  exits.

### A6. Tooltip

Extend `hoveredPointTooltip` in **both** `WebCartographerMapViewer.tsx` and `MapViewer.tsx`. Add
an optional `detail?: string` to `WorldPointMarker.tooltip`, or rapids-specific fields. Example
lines:

- `Rapids · unclaimed · Confirmed (seen in-game)`
- `Rapids · unclaimed · Predicted 37 % · outflow S`
- `Rapids · claimed · Recorded (outside generated area)`

### A7. UI (`AdvancedLayersSection.tsx` + `FullScreenOverlay.tsx`)

- The existing Rapids switch stays the single toggle, as with Traders.
- Count: `Rapids: 32,843` with a muted breakdown `291 confirmed · 32 recorded-only · 8,687 possible`.
- When on, an expandable sub-panel holds:
  - the "Predicted rapids" switch,
  - the likelihood slider,
  - "hide claimed",
  - a one-line note: "Predicted from the world seed within ±45k blocks of spawn; destroyed rapids
    may still show".
- **MarkerStylePicker** swatches (`account.appearance.rapids*`): add a "Possible (faded)" swatch.
- i18n: new `topsMap.rapids*` keys in `en.ts`, `ru.ts`, `nl.ts`.

### A8. Docs

- `rapids-exporter-format.md` §2.3 "Matching": replace the 8-10 block fuzzy guidance with the
  verified exact-match finding.
- Update the comment header of `useRapidsOverlay.ts`.

---

## Part B: Elevation overlay

### B1. Assets (produced by the prepare script)

Under `Elevation/heightmap_20261127_005609/`, with **R2** paths
`elevation/heightmap_20261127_005609/...`, mirroring Stability:

| File | Content | Size | Hosting |
|---|---|---|---|
| `heightmap_<ts>.webp` | Color + hillshade, 4000 px (50 blocks/px), WebP q80 | ~6.3 MB | R2 (gitignored) |
| `heightmap_<ts>.h8.png` | Raw heights, 2000 px, 8-bit grey, `height = R` | ~2.7 MB | R2 (gitignored) |
| `heightmap_<ts>.world.json` | Original georef (color layer). Rewrite `widthPx/heightPx/blocksPerPixel` for the 4000 px output. | 1 KB | tracked |
| `heightmap_<ts>.h8.world.json` | Georef for the 2000 px raw: `blocksPerPixel` = 100 | 1 KB | tracked |

**Downsample the raw by point-sampling** (pick the centre sample of each 3×3 block) rather than
averaging, to stay true to the "point sample" semantics in doc §3.1.

### B2. `frontend/src/lib/elevation/` (new)

- **`types.ts`**:
  - `ElevationWorld` (same shape as `StabilityWorld` plus `seaLevel`, `mapSizeY`, `stats`).
  - `ElevationOverlayBounds` (same shape as climate/stability bounds).
  - `ELEVATION_LEGEND`: the land and water stops from doc §3.3, with their Y values.
- **`loader.ts`**, cloned from `lib/stability/loader.ts`:
  - `ELEVATION_BASE_NAME` constant.
  - `colorUrl()` / `rawUrl()` on R2 (`R2_REQUIRED` error when no bucket is configured).
  - Cached `loadElevationRaw()` through `decodePng`, with `decode = (r) => r`.
  - `getElevationWorld()` / `getElevationRawWorld()`.

### B3. `frontend/src/hooks/useElevationOverlay.ts` (new)

- Params: `{ enabled, mode, bandMin, bandMax }`.
- Returns: `{ status, error, overlayUrl, overlayBounds, sampleAt }`.
- `overlayBounds` uses `originBlockX/Z - 512000`, the same offset as stability (raster convention,
  doc §1).
- **mode `"relief"`**: `overlayUrl` = R2 WebP. No decode.
- **mode `"band"`**: lazily decode the 2000 px raw, then reuse `climate-threshold.worker.ts` with
  `op: { kind: "custom", lo, hi }`. This needs a new `ThresholdDecode` kind `"height"`:
  `(r, _g) => r` in the worker's `decodeFn`. Convert the result to a blob URL the same way
  `useClimateOverlay` does for its threshold modes.
  - Band presets:
    - "Rapid-capable (Y ≥ 133)", which pairs with the rapids layer,
    - "Above sea level (≥ 110)",
    - "Mountains (≥ 175)",
    - "Shallow sea (95-109)".
- **`sampleAt(x, z)`**: decoded lazily, **only once hover readout or band mode is active**.
  - Returns `{ y, aboveSea: y - 109, isWater: y < 109, depth: 109 - y }`.
  - Inputs are centered coords. Convert to absolute (`+ 512000`) and then to a pixel, using the
    formula in doc §3.1.

### B4. Rendering

- Reuse **`ClimateOverlayLayer`** for the `<img>`; its props are identical. Better, rename the
  climate/stability pair into a shared `RasterImageOverlayLayer`. That is optional and can be a
  follow-up refactor.
- Mount it in `TOPSMapViewPage.tsx` `overlayRenderAbove`, beside the climate and stability layers
  (~L2405).
- WebCartographer only, gated by `showAdvancedMapOptions` like the climate and stability layers.

### B5. State (`mapView.ts` + `rootPersistence.ts`)

```ts
elevationEnabled: boolean;              // default false
elevationMode: "relief" | "band";       // default "relief"
elevationBandMin: number;               // default 133
elevationBandMax: number;               // default 254
elevationOpacity: number;               // default 0.7
```

- **Mutual exclusivity**: add elevation to the one-raster group.
  - `setElevationEnabled(true)` turns off `climateSubToggle`, `showRockStrata` and
    `stabilityEnabled`.
  - Add `state.elevationEnabled = false` to those three reducers.
- Validate the persisted values in `rootPersistence.ts` (clamp the band to 0..254, opacity to
  0..1).

### B6. UI

- **`components/tops-map/ElevationPanel.tsx`** (new, modelled on `TemporalStabilityPanel`):
  - switch, relief/band segmented control, opacity slider,
  - band dual-slider + presets,
  - gradient legend with Y ticks (110 / 130 / 150 / 175 / 199 / 225 / 247) plus the water ramp,
  - footnote: "Base terrain from the world seed: no caves, lakes, structures or player changes".
- **`ElevationHoverReadout.tsx`**, like `ClimateHoverReadout`. Example output:
  `Y 172 (+63 above sea)` / `Water · depth 23` / `≈ ±100 blocks resolution`.
  - Reuse the existing `onHoverCoords` → `climateHoverCoords` state. Generalise its name to
    `rasterHoverCoords`.
- Mount it in `AdvancedLayersSection.tsx` (after stability) and in `FullScreenOverlay.tsx` (which
  also renders `TemporalStabilityPanel`).
- i18n keys `topsMap.elevation*` in en / ru / nl.

### B7. Telemetry

Add `"elevation"` to the `mapLayerTelemetry.ts` union and list, to the `useMapLayerTelemetry.ts`
payload (`settings: { mode }`), and to the `UsageMapLayersSection.tsx` label map. For rapids,
include `settings: { showPredicted, minLikelihood }`.

---

## Suggested order

1. **Part 0**: gitignore, prepare script, generated assets, R2 upload.
2. **A1-A3**: data + merge, verifiable with counts alone.
3. **A5 clustering**, before enabling ~28k points for users.
4. **A4, A6-A8**: filters, tooltip, UI, docs.
5. **B1-B5**: elevation relief mode.
6. **B6** hover readout + band mode, then **B7** telemetry.

Parts A and B are independent after Part 0 and can be done in parallel.

## Verification

- `tsc` + `vite build` clean. Run the frontend lint.
- **Rapids counts**:
  - total = 32 811 + 32 = **32 843**,
  - confirmed = **291**,
  - recorded-only = **32** (13 inside the scan + 19 outside),
  - uncertain predicted = 8 737 − 50 = **8 687**,
  - visible with the default filters (predicted on, likelihood ≥ 0.5) = **28 608**.
- Spot-check that the recorded rapid at abs (502192, 135, 524134) shows as "Confirmed".
- Spot-check that a rapid inside a known player claim is orange.
- **Merge timing**: log `performance.now()` around the merge (target < 50 ms).
- **Clustering**:
  - Zooming out collapses rapids in steps.
  - Zooming into an area with < 100 visible rapids shows individual glyphs.
  - Cluster sizes stay ≤ 16 px.
  - Cluster counts in the viewport sum to the visible total.
  - Pan/zoom FPS fully zoomed out is comparable to rapids off.
- **Elevation alignment**: coastlines in the relief line up with ocean/climate overlay edges and
  the WC tiles at the same spot (the offset is the same as stability).
- **Hover readout**: in game at a known location, compare Y with the readout. Expect within a few
  blocks on smooth terrain; the 100-block raw resolution limits accuracy on cliffs.
- **Band "Y ≥ 133"**: predicted rapids should overwhelmingly fall inside the tinted area. This is
  a nice cross-check of both datasets.
- **Exclusivity**: enabling elevation turns climate, rock strata and stability off, and vice
  versa.

## Decisions (confirmed 2026-11-27)

1. **Rapids merge location**: in `useRapidsOverlay`, once per load.
2. **Predicted rapids**: shown by default. The default likelihood threshold is **0.5**.
3. **Zoomed-out rendering**: **cluster** neighbouring rapids into one marker sized by member count
   (capped, not exaggerated), as described in A5:
   - Collapsing is triggered at a few cell-size thresholds.
   - Collapsing stops when fewer than 100 rapids are visible.
   - Fallback, only if clustering proves too costly: cheap dots below a zoom threshold.
4. **Generated rapids hosting**: bundled lazy chunk (dynamic `import()`).
5. **Elevation color resolution**: 4000 px WebP (~6.3 MB).
6. **Elevation hover/band raw**: 2000 px 8-bit (~2.7 MB).
7. **Band mode**: included in v1.
8. **Exclusivity**: elevation joins the one-raster-at-a-time group (climate, rock strata,
   stability).

---

## Implementation status (2026-11-27)

Done, apart from the R2 upload. Deviations from the plan above:

- **Clustering**: two coarser levels were added (`16384`, `32768`). Without them, cells drop below
  40 px when fully zoomed out (≈ 0.004 px/block) and clusters touch.
- **Cluster radius**: uses `min(7 + 3·log10(count), 16)` instead of the log2 curve. The log2 curve
  hit the 16 px cap at about 50 members, so every zoomed-out cluster looked the same size.
- **Rapid merge key**: integers are packed into one numeric key. String keys made the merge cost
  about 100 ms; numeric keys bring it to about 40-75 ms, once per session.
- **Elevation dev fallback**: `vite dev` serves the gitignored local rasters through a DEV-only
  lazy `import.meta.glob`. Production builds never bundle them (verified: no `.webp` / `.h8.png`
  in `dist/`).
- **i18n**: new strings were added to `en.ts` only. `ru` and `nl` fall back to English, as the
  existing `playerClaims*` keys do.
- **Cluster click-to-zoom**: implemented in the WebCartographer viewer. The Cairn `MapViewer`
  draws clusters and their tooltip but has no click-to-zoom.

**Verified**:

- **Counts in the browser**: 32 843 total, 291 confirmed, 32 recorded-only, 32 520 predicted,
  28 608 shown at the 0.5 threshold.
- **Confirmed probe**: the rapid at (-9805, 12134) shows as claimed + confirmed.
- **Hover readout**: matches the raw data exactly at three sample points.
- **Band mode**: rapids sit on the Y ≥ 133 areas.
- **Exclusivity**: works both ways.
- **Build and lint**: `tsc` and `vite build` are clean, and ESLint reports no new findings in
  changed files.

**Remaining (needs bucket credentials)**: upload
`frontend/src/assets/Elevation/heightmap_20261127_005609/heightmap_20261127_005609.{webp,h8.png}`
to R2 under `elevation/heightmap_20261127_005609/`.