# Temporal Stability Overlay — Frontend Integration Plan

Add a stacked (multi-Y) **temporal-stability** raster overlay to the webmap, modeled on the
existing **climate** overlay (the closest analog: georeferenced PNG + `world.json` + raw-decode).
A Y-slider selects which depth slice is displayed.

Assets are already present at
`frontend/src/assets/Stability/tempstab_20260827_140807/` — slices `y10`…`y130` (step 10, 13
slices), each with `.png`, `.raw.png`, `.world.json`, plus a summary
`tempstab_20260827_140807.json` (color anchors, per-slice stats, seaLevel 110, mapSizeY 256,
outputPx 8000, `rawDecodeFormula: "stability = (R*256 + G) / 10000"`, value range 0–1.5).

---

## How the existing overlay system works (verified)

- **Stack:** React 19 + TypeScript + Vite. Custom **canvas** map viewer
  (`WebCartographerMapViewer`); overlays are absolutely-positioned `<img>` in its `overlayAbove`
  slot. No Leaflet/MapLibre.
- **Georef → pixels:** `world.json` uses **absolute** world coords (origin `412000`, center
  `512000`). The overlay hook subtracts `CLIMATE_WORLD_CENTER_OFFSET = 512000` to convert to the
  viewer's centered coords, producing `overlayBounds { originX, originZ, extentX, extentZ }`. The
  layer component turns that into a pixel rect:
  `ppbX = imageWidth / stats.width_blocks; left = (originX - stats.start_x) * ppbX; ...`
  (see `components/tops-map/ClimateOverlayLayer.tsx`).
  > Our stability `world.json` also has `originBlockX = 412000`, so the same offset applies and the
  > overlay will line up with the climate/ocean overlays at the same center.
- **Asset loading:** loaders statically `import x from '...png?url'` (URL only — lazy-fetched by the
  browser, not inlined) + `world.json` + a root summary JSON, collected into a `BUNDLED` record
  keyed by "kind" (see `lib/climate/loader.ts`).
- **Raw hover:** the `.raw.png` is decoded via `lib/png.ts` `decodePng` (canvas-free, to survive
  anti-fingerprinting browsers) and sampled by `sampleAt(worldX, worldZ)`.
- **State:** `store/slices/mapView.ts`. Climate and rock-strata are **mutually exclusive** (enabling
  one flips the other off).

## Reference files (existing)

| Purpose | Path |
|---|---|
| Overlay layer (georef→pixel `<img>`) | `frontend/src/components/tops-map/ClimateOverlayLayer.tsx` |
| Loader (bundled PNG + world.json + summary) | `frontend/src/lib/climate/loader.ts` |
| Hook (bounds + sampleAt, coord offset) | `frontend/src/hooks/useClimateOverlay.ts` |
| Controls panel + gradient legend | `frontend/src/components/tops-map/ClimateControlsPanel.tsx` |
| Types | `frontend/src/lib/climate/types.ts` |
| Canvas-free PNG decode | `frontend/src/lib/png.ts` |
| Redux slice (toggles/opacity) | `frontend/src/store/slices/mapView.ts` |
| Panels container | `frontend/src/components/tops-map-viewer/AdvancedLayersSection.tsx` |
| Page orchestrator | `frontend/src/pages/multiplayer/TOPSMapViewPage.tsx` |

---

## KEY CONCERN — 8000×8000 rasters

- **Color PNGs** are lazy-fetched only for the active slice (fine).
- **Raw decode for hover** is ~64M pixels ≈ **~256 MB RGBA in memory per slice** — 16× heavier than
  climate's 2000px maps. Recommendation: ship **v1 without hover readout** (color overlay + Y-slider
  + legend), or lazy-decode only the active slice and cache exactly one.

---

## Implementation

### Phase 1 — Data layer (parallel-safe)

1. **`frontend/src/lib/stability/types.ts`**
   - `StabilityWorld` (originBlockX/Z, blocksPerPixelX/Z, widthPx/heightPx, y).
   - `StabilityYSlice` union (`10 | 20 | ... | 130`).
   - `StabilityRootMeta` (colorAnchors `{value,hex}[]`, per-slice `stats {min,avg,max}`,
     `rawDecodeFormula`, seaLevel, mapSizeY, stabilityRange).

2. **`frontend/src/lib/stability/loader.ts`**
   - Import all 13 slices (`?url` color png + raw png + world.json) and the summary json.
   - `BUNDLED` record keyed by Y: `{ pngUrl, rawPngUrl, world }`.
   - Centralize the timestamp/base name in one constant (like climate).
   - Export `getStabilityWorld(y)`, `getStabilityRootMeta()`, cached `loadStabilityColor(y)` /
     `loadStabilityRaw(y)`.
   - Decode: `stability = (R*256 + G) / 10000` (range 0–1.5) — **note the `/10000` differs from
     climate's `/65535`.**

### Phase 2 — Hook + render (depends on Phase 1)

3. **`frontend/src/hooks/useTemporalStabilityOverlay.ts`**
   - Params `{ enabled, ySlice, opacity }` (add `hover` later if desired).
   - Returns `{ status, error, overlayUrl, overlayBounds, sliceMeta, sampleAt? }`.
   - Apply the `512000` center offset when building `overlayBounds` (mirror `useClimateOverlay`).
   - **No altitude adjustment** — each slice is already baked at its own Y (simpler than climate).

4. **`frontend/src/components/tops-map/TemporalStabilityOverlayLayer.tsx`**
   - Clone `ClimateOverlayLayer` (same bounds→pixel-rect `<img>`, `imageRendering: pixelated`).

### Phase 3 — UI + wiring (depends on Phase 2)

5. **`frontend/src/components/tops-map/TemporalStabilityPanel.tsx`**
   - Switch toggle, **Y slider** (min 10, max 130, step 10 — snap to nearest available slice),
     opacity slider.
   - Gradient legend from `colorAnchors` (0 → `#B00000` … 1.0 → `#40C040` … 1.5 → `#00A0A0`).
   - Show active-slice `min/avg/max`; add a "deeper = less stable" hint.

6. **Modify `frontend/src/store/slices/mapView.ts`**
   - Add state: `stabilityEnabled` (default `false`), `stabilityYSlice` (default `110`),
     `stabilityOpacity` (default `0.7`).
   - Add reducers: `setStabilityEnabled`, `setStabilityYSlice`, `setStabilityOpacity`.
   - Mutual exclusivity: enabling stability sets `climateSubToggle = "off"` and
     `showRockStrata = false`; add a stability-off line to those overlays' enable reducers too.

7. **Modify `frontend/src/components/tops-map-viewer/AdvancedLayersSection.tsx`**
   - Mount `<TemporalStabilityPanel>` and thread its props.

8. **Modify `frontend/src/pages/multiplayer/TOPSMapViewPage.tsx`**
   - Call `useTemporalStabilityOverlay(...)`.
   - Render `<TemporalStabilityOverlayLayer>` in the `overlayAbove` slot beside the Climate/RockStrata
     layers (~line 2020).
   - Pass panel props into `AdvancedLayersSection` (~lines 1919 / 2211).

9. **(Optional) i18n** — add `topsMap.temporalStability*` strings to the locale JSON files.

---

## Y-slider details

- Available Ys: `[10, 20, …, 130]`. Slider `min 10, max 130, step 10`, snapped to the nearest
  available slice. Label e.g. `Y = <v> (depth slice)`.
- Deeper slices are less stable (depth penalty + variance) — the summary JSON's per-slice avg rises
  with Y, confirming the trend.

## Verification

1. `tsc` + vite build clean (no type errors).
2. Toggle on → raster aligns with climate/ocean overlays at the same center (check a landmark).
3. Drag Y slider 10 → 130: image swaps; deeper slices visibly redder (less stable).
4. Opacity slider works; enabling stability turns climate/rock-strata off (and vice versa).
5. (If hover added) readout shows a stability value in 0–1.5 matching the pixel color.

## Decisions to confirm before implementing

1. **Hover value readout:** (A) skip in v1 *(recommended — 8000px raw ≈ 256 MB)*, (B) lazy
   single-slice decode + cache, (C) re-export a low-res raw for sampling.
2. **Mutual exclusivity:** put stability in the same one-raster-at-a-time group as climate +
   rock-strata *(recommended)*, or allow it independently/stacked.
3. **Y control:** slider *(recommended)* vs dropdown.
4. **Default slice on first enable:** Y = 110 (sea level) *(recommended)* vs deepest.

## Notes for a future exporter re-run

- The overlay reads whatever timestamped folder the loader points at; to refresh data, re-export and
  update the base-name constant in `lib/stability/loader.ts`.
- If bundle/disk size from thirteen 8000px slices becomes a problem, consider a smaller `output-px`
  (e.g. 4000 = 50 blocks/px, still resolves the ~80-block noise) or fewer Y slices.
