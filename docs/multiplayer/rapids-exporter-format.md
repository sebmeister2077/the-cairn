# Rapids Exporter output formats (generated rapids + height map)

Reference for the files written by the **Rapids Exporter** Vintage Story mod
(repo `vintagestory-rapids-exporter`, author vintagecreeper, mod version ≥ 0.3.0), so they can be
integrated into the TOPS webmap. Two independent datasets are produced, both computed from the
TOPS world seed in a local copy of the world:

| Dataset | Produced by | Files |
|---|---|---|
| **Generated rapids**: every worldgen rapid source in an area, with a likelihood | `/rapids scan <radius> noise` (or `exact` / `fast`) | `rapids_<timestamp>.json`, `rapids_latest.json`, optional `rapids_<timestamp>_min<L>.json` |
| **Terrain height map** | `/rapids heightmap <half-size> <px>` | `heightmap_<timestamp>/heightmap_<timestamp>.png`, `.raw.png`, `.world.json` |

Both datasets are written to
`%APPDATA%\VintagestoryData\ModData\rapidsexporter\<savegame-id>\` on the machine that ran the
scan.

Numbers in this document come from the first real TOPS run: seed `421943594`, rapids scan radius
45 000, height map half-size 100 000 at 6000 px.

---

## 1. Coordinate conventions

All coordinates are **block** coordinates. Y is always absolute: sea level is 110 and the world
height is 256.

| Name | Meaning | TOPS values |
|---|---|---|
| `abs` | Absolute world block position. | Around 512 000 near spawn. |
| `rel` | `abs − worldSpawn`, on all three axes. This is the same convention as the recorded `map-features.*.json` files. | `worldSpawn = { x: 511997, y: 123, z: 512000 }` |
| `originBlockX/Z` | Absolute block position of the height map's top-left corner. | `412000, 412000` |
| `originRel` | `originBlock − worldSpawn` (X/Z). | `{ x: -99997, z: -100000 }` |

The webmap uses two slightly different conventions today:

- **Recorded point overlays** (rapids, broken TLs, trader claims; see `hooks/useRapidsOverlay.ts`)
  position markers at `rel.x` / `rel.z`, with z kept as-is.
  - Generated rapids carry the same `rel` with the same spawn, so they plug into the same code path
    unchanged.
- **Raster overlays** (climate, ocean, temporal stability) use `abs − 512000`
  (`CLIMATE_WORLD_CENTER_OFFSET`) on both axes.
  - The height map `world.json` has the same `originBlockX = 412000` as the climate map, so the
    same offset makes it line up with the climate/ocean overlays.

The two conventions differ by **3 blocks in X** (511997 vs 512000), because the TOPS spawn isn't
exactly at 512000. That is invisible at height-map resolution (33 blocks/px), but it matters if
rapids and raster overlays are ever compared block-exactly. Pick one convention per layer:

- For markers, use `rel`.
- For rasters, use `originBlockX − 512000`, or equivalently `originRel.x + 3`.

`worldSpawn` comes from the mod config (`SpawnX/Y/Z` in `ModConfig/rapidsexporter.json`), so it
matches TOPS rather than the local copy of the world. The **scan center** in `scan.center`, and
the height map center, default to the local world's spawn (`512000, 512000`).

---

## 2. Generated rapids: `rapids_*.json`

A single UTF-8 JSON object, pretty-printed. `rapids_latest.json` is a copy of the most recent
`rapids_<timestamp>.json`. The 45k run is 13.6 MB with 32 811 features; minify it, or convert it,
before shipping it to the browser.

### 2.1 Envelope

```jsonc
{
  "generatedUtc": "2026-11-26T21:53:10.3877337+00:00",
  "category": "rapids",
  "count": 32811,
  "features": [ /* see 2.2 */ ],
  "upstream": "tops.vintagestory.at",
  "worldSpawn": { "x": 511997, "y": 123, "z": 512000 },
  "seed": 421943594,
  "scan": {
    "mode": "noise",
    "center": { "x": 512000, "z": 512000 },
    "radiusBlocks": 45000,
    "deleteScannedChunks": false,
    "columnsScanned": 7918596,
    "totalColumns": 7918596,
    "complete": true,
    "failedColumns": 0,
    "minLikelihood": 0.0,
    "replay": {
      "Matched": 0, "Unexplained": 0, "CertainMissing": 0, "PossibleNotGenerated": 0,
      "Predicted": 32811, "PeekFallbacks": 23, "Skipped": 1032306,
      "Verified": 46793, "VerifyRejected": 15461, "VerifyAdded": 71
    },
    "note": "Positions are worldgen rapid SOURCE blocks. ..."
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `generatedUtc` | ISO-8601 string with offset | When the file was written. |
| `category` | `"rapids"` | Same as the recorded `map-features.rapids.json`. |
| `count` | int | `features.length`. |
| `features` | array | See 2.2. Sorted by `abs.x`, then `abs.z`, then `abs.y`. |
| `upstream` | string | From the mod config. |
| `worldSpawn` | `{x,y,z}` int | Used to compute `rel`. |
| `seed` | int (64-bit) | World seed of the scanned copy. It must equal the TOPS seed. |
| `scan.mode` | `"noise"` \| `"fast"` \| `"exact"` | How the data was produced (see 2.4). |
| `scan.center`, `scan.radiusBlocks` | | The scanned area is the square `center ± radius` (absolute blocks), rounded out to whole chunks (32 blocks). |
| `scan.complete` | bool | `false` means a partial export (`/rapids export` during a scan). The covered area then grows outward from the center region by region. |
| `scan.columnsScanned` / `totalColumns` | int | Progress in chunk columns of 32×32 blocks. |
| `scan.failedColumns` | int | Chunk columns that couldn't be analysed, so rapids may be missing there. 0 in the real run. |
| `scan.minLikelihood` | float | `0` for the full export. For filtered exports, the threshold used. |
| `scan.replay` | object | Diagnostic counters (see 2.5). Not needed for display. |

The envelope's `category` / `features[]` / `upstream` / `worldSpawn` shape matches the recorded
`map-features.rapids.json`. `loadMapFeatures` only reads `features[]`.

### 2.2 Feature

```json
{
  "abs": { "x": 466981, "y": 210, "z": 506807 },
  "rel": { "x": -45016, "y": 87, "z": -5193 },
  "flow": "still",
  "height": 7,
  "code": "rapidwater-still-7",
  "claimed": false,
  "owner": null,
  "outflow": "s",
  "likelihood": 1.0,
  "certain": true,
  "generated": false
}
```

| Field | Type | Meaning |
|---|---|---|
| `abs` | `{x,y,z}` **int** | Absolute position of the rapid **source** block. |
| `rel` | `{x,y,z}` int | `abs − worldSpawn`. Use `rel.x` / `rel.z` for markers, like the recorded rapids. |
| `flow` | string | Variant of the source block. Always `"still"` for generated rapids (see 2.3). |
| `height` | int | Liquid level of the source block. Always `7`. |
| `code` | string | Block code. Always `"rapidwater-still-7"`. |
| `claimed` | bool | Whether a land claim covers the position **in the world that was scanned**. For TOPS data that is a fresh local copy with no claims, so it is always `false`. **Derive claims geometrically** from the player-claim boxes, as `useRapidsOverlay` already does. |
| `owner` | string \| null | Claim owner in the scanned world. Always `null` for TOPS data. |
| `outflow` | `"n"` \| `"e"` \| `"s"` \| `"w"` | Direction of the 2-4 block tunnel the generator carved from the source to the open mountain face. The visible rapid starts at the end of that tunnel and runs downhill. `n` = −Z, `e` = +X, `s` = +Z, `w` = −X. |
| `likelihood` | float 0..1, 3 decimals | Probability that this rapid exists in **any** world generated from this seed and config (see 2.4). `1` = certain. |
| `certain` | bool | `likelihood == 1`. Convenience flag. |
| `generated` | bool | `true` = the block physically exists in the scanned world (exact mode only). `false` = predicted by replaying the world generator. Always `false` for noise/fast exports. |

The real 45k run had:

- 32 811 features: 24 074 certain and 8 737 with likelihood below 1.
- `abs.y` between 131 and 252.
- Outflow counts n 9 912, e 8 312, s 7 924, w 6 663.

Suggested TypeScript type:

```ts
interface GeneratedRapid {
    abs: { x: number; y: number; z: number };
    rel: { x: number; y: number; z: number };
    flow: "still";
    height: number;
    code: string;              // "rapidwater-still-7"
    claimed: boolean;          // scanned-world claims only; derive for TOPS
    owner: string | null;
    outflow: "n" | "e" | "s" | "w";
    likelihood: number;        // 0..1
    certain: boolean;
    generated: boolean;
}
```

### 2.3 Differences from the recorded `map-features.rapids.json`

| | Recorded (VSProxy `--map-export`) | Generated (this mod) |
|---|---|---|
| What a feature is | A **flowing** rapid-water block a player saw, e.g. `rapidwater-w-7`, `flow: "w"`. A few are `still`. | The worldgen **source** block (`rapidwater-still-7`), plus the outlet direction. |
| Coordinates | Floats (`502192.0`). | Ints. |
| Extra fields | `firstSeenUtc` | `outflow`, `likelihood`, `certain`, `generated` |
| Coverage | Only where players went. | Every rapid in the scanned square. |
| Truth | Observed in the live world, so it reflects player changes. | Predicted from the seed: rapids players destroyed are still listed, and terrain generated by older game versions can differ. |

**Matching the two datasets (verified against the TOPS data):**

- The VSProxy recorder stores the rapid's **source** block, even when its `code` names a flowing
  variant (`rapidwater-w-7`). That is exactly the block the generator predicts.
- In the first real run, all 291 recorded rapids that lie inside the scan square and have a
  generated counterpart matched it at **dx = dy = dz = 0**. None matched at any other distance up
  to 16 blocks.
- De-duplicate with an exact key on the integer `(rel.x, abs.y, rel.z)`. Recorded coordinates are
  floats such as `502192.0`, so round them first. No fuzzy matching is needed.
- Recorded rapids without a generated match are either outside the scan square (19 in the first
  run) or ones the generator misses (13, mostly `still` / `d` variants at lakes near spawn). Keep
  them as recorded-only.
- A generated rapid with `likelihood < 1` that also appears in the recorded set is confirmed to
  exist, so treat it as certain.

The webmap implements this in `frontend/src/lib/rapids/merge.ts`.

### 2.4 How `likelihood` arises

Rapids are generated per chunk from a random-number stream seeded by the world seed and the chunk
position, so the same seed and config give the same rapids. The one exception is the **last** rapid
attempt in each chunk: whether it happens depends on the order the server generated chunks in, so
it can differ between two worlds with the same seed. Such rapids get
`likelihood = frac(attempt count)` (for example 0.37), and `certain: false`. All others get
`likelihood: 1`.

Suggested display:

- Show certain rapids solidly.
- Show uncertain ones faded, or behind a "show possible rapids (likelihood ≥ X)" control.
- `/rapids export 0.5` writes a pre-filtered file with an `_min0.5` suffix, in the same format.

**Accuracy by mode**, validated on a 4 096 × 4 096 test area against a fully generated world:

| `scan.mode` | Method | Speed | Accuracy |
|---|---|---|---|
| `exact` | Full chunk generation, real blocks. | ~16 columns/s | Reference |
| `fast` | Terrain-pass generation in memory, plus generator replay. | ~40 columns/s | ~98 % of real rapids found, ~13 % extra (later worldgen such as trees or structures would block them) |
| `noise` | Terrain computed from the seed with no chunks; candidate chunks verified with an in-memory terrain-pass peek. | ~1 000 columns/s | Same results as `fast` (~0.2 % fewer) |

The TOPS data is `noise` mode.

### 2.5 `scan.replay` counters (diagnostics)

| Counter | Meaning |
|---|---|
| `Predicted` | Rapids in the file. |
| `Skipped` | Chunk columns ruled out cheaply: too cold, or terrain can't reach the minimum rapid height y 133. |
| `Verified` | Candidate chunks re-checked against real (in-memory) terrain. |
| `VerifyRejected` | Predictions ruled out by the real blocks: caves, soil, and especially tall grass blocking the outlet. |
| `VerifyAdded` | Rapids the real blocks had that the noise terrain missed. |
| `PeekFallbacks` | Verification peeks the server never answered, where the unverified prediction was kept. 23 in the real run. |
| `Matched`, `Unexplained`, `CertainMissing`, `PossibleNotGenerated` | Exact mode only, otherwise 0. |

---

## 3. Terrain height map: `heightmap_<timestamp>/`

A folder with three files sharing the base name:

| File | Content | Real run (6000 px) |
|---|---|---|
| `heightmap_<ts>.png` | Color visualisation, 8-bit RGBA, opaque. | 88 MB |
| `heightmap_<ts>.raw.png` | Exact height values packed into RGB. | 29 MB |
| `heightmap_<ts>.world.json` | Georeference and metadata. | 1 KB |

### 3.1 `world.json`

```json
{
  "originBlockX": 412000,
  "originBlockZ": 412000,
  "originRel": { "x": -99997, "z": -100000 },
  "blocksPerPixelX": 33.333333333333336,
  "blocksPerPixelZ": 33.333333333333336,
  "widthPx": 6000,
  "heightPx": 6000,
  "imagePngRelative": "heightmap_20261127_005609.png",
  "imageRawPngRelative": "heightmap_20261127_005609.raw.png",
  "rawDecodeFormula": "height = R*256 + G  (Y of the highest solid terrain block)",
  "seaLevel": 110,
  "mapSizeY": 256,
  "seed": 421943594,
  "worldSpawn": { "x": 511997, "y": 123, "z": 512000 },
  "stats": { "min": 0, "max": 254 },
  "generatedUtc": "2026-11-26T22:56:28.2712958+00:00",
  "note": "Terrain shape as produced by the base terrain generator (GenTerra), ..."
}
```

| Field | Meaning |
|---|---|
| `originBlockX/Z` | Absolute block coordinate of the **top-left corner** of pixel (0,0). +X is to the right, +Z is down (south), as in the climate maps. |
| `originRel` | Same corner, spawn-relative. |
| `blocksPerPixelX/Z` | Pixel size in blocks; a float. |
| `widthPx`, `heightPx` | Image size. The covered area is `widthPx * blocksPerPixelX` blocks. |
| `imagePngRelative`, `imageRawPngRelative` | File names in the same folder. |
| `rawDecodeFormula` | See 3.2. |
| `seaLevel`, `mapSizeY` | 110 / 256 on TOPS. |
| `stats.min/max` | Height range in the image. |

The field names and the origin match the existing climate and temporal-stability `world.json`
files, so the climate overlay's bounds code (`ClimateOverlayLayer.tsx`, `useClimateOverlay.ts`)
can be reused as is.

**Pixel ↔ world:**

```
pixel (px, py) covers absolute blocks
    X ∈ [originBlockX + px*bpp, originBlockX + (px+1)*bpp)
    Z ∈ [originBlockZ + py*bpp, originBlockZ + (py+1)*bpp)
and its value is the height of the single column
    X = floor(originBlockX + (px + 0.5) * bpp),  Z = floor(originBlockZ + (py + 0.5) * bpp)

world → pixel:  px = floor((absX - originBlockX) / bpp),  py = floor((absZ - originBlockZ) / bpp)
```

Each pixel is a **point sample**, not an average. For webmap centered coordinates, use
`absX − 512000` (raster convention) or `absX − worldSpawn.x` (marker convention); see section 1.

### 3.2 Raw PNG decoding

Each pixel stores one 16-bit height:

```
height = R * 256 + G      // B = 0, A = 255
```

- `height` is the Y of the **highest solid terrain block** in that column, from 0 to `mapSizeY − 2`.
- Water is not stored. Below `seaLevel`, the surface is water: the water surface is at
  `seaLevel − 1` = 109, and the depth is `109 − height`.
- `lib/png.ts` `decodePng` works as is. It is the same packing as the temporal-stability raw PNGs,
  without the divisor.

**Memory:** decoding the 6000 × 6000 raw PNG to RGBA takes about 144 MB. For hover readout, either:

- downsample it offline (for example to 2000 px, about 16 MB), or
- decode it lazily only when the readout is enabled.

### 3.3 Color PNG legend

| Height | Color |
|---|---|
| below `seaLevel − 1` | Water: `#6BA7D8` (shallow) to `#0B2E59` (60+ blocks deep) |
| land, t = (h − seaLevel) / (mapSizeY − 2 − seaLevel) | Stops: 0.00 `#3E7D3A` · 0.14 `#6E9B3E` · 0.28 `#B8B65A` · 0.45 `#A37E4A` · 0.62 `#7E6A5A` · 0.80 `#A8A8A8` · 0.95+ `#F5F5F5` |

For TOPS (sea level 110, top 254), the land stops correspond to Y values of:

| t | 0.00 | 0.14 | 0.28 | 0.45 | 0.62 | 0.80 | 0.95 |
|---|---|---|---|---|---|---|---|
| Y | 110 | 130 | 150 | 175 | 199 | 225 | 247 |

Land is multiplied by a north-west hillshade, with a factor between 0.35 and 1.25 and vertical
exaggeration ×3. The color image is therefore not a clean lookup of the legend. Use the raw PNG
for values.

The 88 MB color PNG is too large to load directly. Consider:

- tiling it (for example 512 px tiles per zoom level), or
- re-encoding it as WebP/AVIF, or
- regenerating at lower `output-px`.

### 3.4 What the height map does and does not show

It is the output of the base terrain generator (GenTerra) computed from the seed. It matched really
generated chunks exactly in 99.1 % of columns.

Not included:

- Caves breaking through the surface.
- Shore raising: dry areas get below-sea-level ground raised up to about 20 blocks, so some shallow
  "water" patches are dry land in game.
- Lakes.
- Structures.
- Trees and plants, since it is terrain only.
- Player changes.

---

## 4. Internal files (not for consumers)

These live in the same folder and exist so long scans can resume:

| File | Content |
|---|---|
| `job.json` | Scan state: center, radius, mode, progress watermark, failed columns, counters. |
| `rapids.jsonl` | One raw result per line: `{"X","Y","Z","Code","Outflow","Likelihood","Certain","Generated"}`. The exported JSON is built from it. |

Don't parse these from the webmap. Their shape can change between mod versions, so always use
`rapids_*.json`.

---

## 5. Regenerating

In a local world with the TOPS seed and world settings (see the mod's README):

```
/rapids verifynoise                 # optional sanity check after game updates
/rapids scan 45000 noise            # ~2 h on 10 threads (real run: 1 h 53 min), resumable (/rapids stop | resume)
/rapids export 0.5                  # optional filtered copy
/rapids heightmap 100000 6000       # ~20-30 min
```

A new game version that changes world generation means re-running both. Compare `seed` and
`generatedUtc` in the files to know what you have.

### Publishing to the webmap

1. Copy the mod's `<savegame-id>/` output folder anywhere. The frontend ignores
   `frontend/src/assets/RapidsAndElevation/`, so it can live there too.
2. Run:

   ```
   python tools/prepare-rapids-export/prepare_rapids_export.py <export-folder>
   ```

   It writes three things:

   - `frontend/src/assets/GeneratedRapids/<rapids_ts>/rapids.compact.json`. This is committed and
     bundled as a lazy chunk.
   - `frontend/src/assets/Elevation/<heightmap_ts>/`:
     - a 4000 px colour WebP and a 2000 px 8-bit raw PNG. These are gitignored.
     - their `*.world.json` georef files. These are committed.
3. Upload the `.webp` and `.h8.png` files to the public R2 bucket under
   `elevation/<heightmap_ts>/`. `vite dev` serves the local copies, so the overlay works before
   the upload. Production builds only read from R2.
4. If the timestamps changed, update the import paths and base names in
   `frontend/src/lib/rapids/generated.ts` and `frontend/src/lib/elevation/loader.ts`.
