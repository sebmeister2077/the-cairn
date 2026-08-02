# Chiseled blocks: de-collapse + 3D render — implementation plan

## Goal
Chiseled / microblocks currently collapse into a single market item (block id 648
`chiseledblock` → one page), which is useless because their prices vary enormously
by design. We want to:

1. **Stop collapsing** all chiseled blocks into one item.
2. **Show the block name** when it has one (e.g. `l-dungeon`).
3. **Collapse only same-named designs together** — specifically all `l-dungeon`
   blocks (a creative block left in survival) become one item.
4. **Render the block in 3D** on the item page, like the in-game auction house shows.

---

## Investigation findings

### 1. The data we need is already in `auction-events.jsonl` (via `RawHex`)
The C# proxy (`vintagestory-midm`) writes each auction's item stack as
`Item.RawHex` — the **full** serialized `ItemStack` bytes (class/id/stacksize + the
complete `TreeAttribute`). See
[AuctionExporter.SerializeEntry](../../vintagestory-midm/src/Auction/AuctionExporter.cs)
and [AuctionPacketParser.ParseItemStack](../../vintagestory-midm/src/Auction/AuctionPacketParser.cs)
(`RawHex = Convert.ToHexString(b)`).

So **we do not need the `/captures` folder** — everything (`cuboids`, `materials`,
`blockName`, `rotation`) is present in `RawHex`. A standalone validation script (below)
can prove this against a live `auction-events.jsonl`.

### 2. Why the chiseled data looks "missing" today (the real gap)
Both decoders stop at the first **array** attribute:

- C# `AuctionPacketParser.TryDecodeTreeShallow` only extracts top-level scalars and
  bails on arrays/trees (this only affects the convenience `Item.Attributes` field).
- Python `process_auction_data._read_tree`
  ([process_auction_data.py](../backend/process_auction_data.py)) decodes scalars +
  nested trees but hits the `else` branch on any array type, sets `_partial` and
  **stops**.

A chiseled block's attribute order is roughly
`blockCode, materials[], decorRot, rotation, cuboids[], … blockName, …`. Because
`materials` is an `IntArray` early in the tree, the Python decoder currently stops
right after `blockCode` — so `blockName`, `cuboids`, etc. are never seen even though
they're in `RawHex`.

**Fix = extend the Python tree decoder to parse array attribute types** and keep going.

### 3. Vintage Story serialization reference (verified against VS source)
`TreeAttribute` id → type mapping (from `vsapi/Datastructures/AttributeTree/TreeAttribute.cs`):

| id | type              | current Python | serialization (`.NET BinaryWriter`) |
|----|-------------------|----------------|--------------------------------------|
| 1  | IntAttribute      | ✅ | `int32` |
| 2  | LongAttribute     | ✅ | `int64` |
| 3  | DoubleAttribute   | ✅ | `float64` |
| 4  | FloatAttribute    | ✅ | `float32` |
| 5  | StringAttribute   | ✅ | 7-bit-len string |
| 6  | TreeAttribute     | ✅ | recursive, `0x00` terminated |
| 7  | ItemstackAttribute| ❌ | nested stack (skip / stop) |
| 8  | **ByteArray**     | ❌ | **`uint16` len** + raw bytes ⚠️ |
| 9  | BoolAttribute     | ✅ | 1 byte |
| 10 | **StringArray**   | ❌ | `int32` len + N×(7-bit string) |
| 11 | **IntArray**      | ❌ | `int32` len + N×`int32` |
| 12 | FloatArray        | ❌ | `int32` len + N×`float32` |
| 13 | DoubleArray       | ❌ | `int32` len + N×`float64` |
| 14 | TreeArray         | ❌ | `int32` len + N×tree |
| 15 | LongArray         | ❌ | `int32` len + N×`int64` |
| 16 | BoolArray         | ❌ | `int32` len + N×byte |

⚠️ **Gotcha:** `ByteArrayAttribute` writes a **2-byte (`ushort`) length**, not 4.
`emitSideAo`/`sideSolid`/`sideAlmostSolid` are byte arrays (`SetBytes`), so getting
their length prefix wrong desyncs the whole walk. All other arrays use a 4-byte length.

### 4. Chiseled block attributes (what each field means)
From `vssurvivalmod` `BlockEntityMicroBlock.ToTreeAttributes` / `FromUint`:

- `materials` (IntArray): block **ids** whose textures skin each voxel. These are the
  server's runtime block ids — resolvable to codes via
  [registry-tops.vintagestory.at.json](../frontend/src/assets/Auction/registry-tops.vintagestory.at.json)
  (e.g. block `648` = `chiseledblock`).
- `cuboids` (IntArray of packed `uint32`): the geometry. Each value packs one box at
  16-voxels-per-block resolution:

  ```
  x0       = (v      ) & 0xF
  y0       = (v >>  4) & 0xF
  z0       = (v >>  8) & 0xF
  x1       = ((v >> 12) & 0xF) + 1
  y1       = ((v >> 16) & 0xF) + 1
  z1       = ((v >> 20) & 0xF) + 1
  material = (v >> 24) & 0xFF      // index into `materials`
  ```

  Verified on the attachment's example: `cuboids:[16773120]` (0xFFF000) →
  box (0,0,0)–(16,16,16), material 0 → a solid full cube skinned with `materials[0]`
  (263). That matches `l-dungeon` being a solid block.
- `rotation` (int): stored as `(rotationY + 360) << 10` → `rotationY = (rotation >> 10) - 360`.
  Example `368640 >> 10 = 360` → `0°`.
- `blockName` (string): the custom name (`l-dungeon`). Present only when named.
- `decorRot`, `emitSideAo`, `sideSolid`, `sideAlmostSolid`, `meshId`,
  `availMaterialQuantities` are not needed for a basic render.

### 5. Current market grouping
`chiseledblock` (648), `chiseledblock-snow` (647), `microblock` (650),
`microblock-snow` (649) each namespace to one block item id
(`20_000_000 + id`) and collapse every design into a single page. This is the collapse
we're removing.

---

## Implementation plan

### A. Backend — `backend/process_auction_data.py`

**A1. Decode array attribute types.**
Extend `_Reader` with `uint16()` and add array branches to `_read_tree`:

- `ATTR_BYTES = 8` → read `uint16` length, then that many bytes (store as `list[int]`
  or hex; we mainly need to *advance* correctly).
- `ATTR_STRING_ARRAY = 10` → `int32` len + N strings.
- `ATTR_INT_ARRAY = 11` → `int32` len + N int32 (this is `cuboids`, `materials`,
  `availMaterialQuantities`).
- `ATTR_FLOAT_ARRAY = 12`, `ATTR_DOUBLE_ARRAY = 13`, `ATTR_LONG_ARRAY = 15`,
  `ATTR_BOOL_ARRAY = 16` → same shape, correct element width.
- `ATTR_TREE_ARRAY = 14` → `int32` len + N recursive `_read_tree`.
- `ATTR_ITEMSTACK = 7` → keep the current "stop" behavior (nested stacks are rare in
  auctioned items and complex to decode); it no longer blocks chiseled blocks because
  they contain no itemstack attribute.

This single change also improves fidelity for **every** item that carries array
attributes, not just chiseled blocks.

**A2. Split chiseled/microblocks into per-design items.**
Add a `chisel_variant(item, attrs)` helper mirroring `type_variant`
(clutter/tapestry). Trigger when `item["code"]` is one of
`chiseledblock[-snow]`, `microblock[-snow]`:

- **Named** (`attrs.blockName` set) → group key `chisel:<blockName>` →
  display name = the block name (`l-dungeon`). All `l-dungeon` listings aggregate into
  one item. ✅ satisfies requirement 3.
- **Unnamed** → group by a **design signature** = stable hash of
  `(tuple(materials), tuple(cuboids))` → key `chisel:#<sig>`, display name like
  `Chiseled design #<short-sig>`. Identical designs aggregate; different designs stay
  separate. ✅ satisfies requirement 1 (no mega-collapse).

Reuse the existing synthetic-id machinery (`_variant_synth_id`, `VARIANT_ID_BASE =
90_000_000`) so each design gets a stable, collision-free `itemId`, exactly like
clutter/tapestry. Add `"chisel"` to the set of split categories used by
`extract_trader_wares.py` / catalog consumers if needed (chiseled blocks are almost
never trader wares, so likely a no-op).

**A3. Emit a compact render payload per listing + per catalog entry.**
Decode once in `build_records` and attach:

```jsonc
"chisel": {
  "blockName": "l-dungeon" | null,
  "rotationY": 0,
  "materials": ["chiseledblock", ...],   // resolved via registry (id -> code)
  "boxes": [ { "x0":0,"y0":0,"z0":0,"x1":16,"y1":16,"z1":16,"mat":0 }, ... ]
}
```

- Resolve `materials` ids → codes with the registry already loaded in `load_registry`.
- Put `boxes` (decoded cuboids) here so the frontend needs no bit-twiddling.
- Keep it only on chiseled/microblock listings to avoid bloating the dataset. Store the
  design once on the catalog entry (all listings of a design share geometry) and, for
  named groups where designs can differ, keep the per-listing `chisel` too so the
  listings table can show each variant.

### B. Frontend

**B1. Types** — `frontend/src/models/auction.d.ts`:
add optional `chisel?: ChiselDesign | null` to `AuctionListing` and the catalog entry,
with a `ChiselDesign` interface (`blockName`, `rotationY`, `materials: string[]`,
`boxes: ChiselBox[]`).

**B2. Rendering component** — `frontend/src/pages/market/ChiseledBlockViewer.tsx`:
render the boxes as a true 3D model. Recommended stack: **three.js + @react-three/fiber
+ @react-three/drei** (OrbitControls). Each `box` becomes a `BoxGeometry` scaled to
`(x1-x0, y1-y0, z1-z0)/16` positioned at its center/16, colored by `materials[box.mat]`.
Apply `rotationY` about the Y axis. Provide a static fallback (no WebGL) that renders an
isometric CSS/SVG projection of the boxes.

- Lighter-weight alternative if we want to avoid the three.js bundle: render an
  orthographic/isometric projection to a `<canvas>` ourselves (boxes are axis-aligned,
  so painter's-algorithm sorting by depth is trivial). Good enough for a thumbnail and
  zero new deps. Recommend starting here, upgrading to three.js only if interactivity
  is wanted.

**B3. Material colors** — `frontend/src/pages/market/chiselColors.ts`:
map block code → representative hex color (curated palette, same spirit as
`tapestryImages.ts`), with a deterministic fallback (hash code → HSL) so unknown
materials still render distinctly. We do **not** have the game's texture atlas, so
solid per-material colors are the pragmatic fidelity target; note this as a tradeoff.

**B4. Item page** — `MarketItemPage.tsx`:
- When `category` is chiseled/microblock, render `<ChiseledBlockViewer>` near the header
  (reuse the `tapestryImage` slot pattern) plus the `blockName` as a badge/subtitle.
- Add a "Design" column to the listings table (via the existing `columns` mechanism,
  like the tapestry `hostRock`/`variant` columns) showing a small thumbnail render per
  listing when a named group mixes multiple designs.
- Keep all existing price/volume logic unchanged — de-collapsing happens purely through
  the backend's new synthetic ids.

**B5. Listings/screener** — optional follow-up: show a tiny thumbnail next to chiseled
rows so users can eyeball designs in the table/insights views.

### C. Validation / tooling

**C1.** Add `backend/decode_chisel.py` (standalone, no deps): read
`auction-events.jsonl`, decode each `Item.RawHex`, and for chiseled/microblocks print
`blockName`, decoded `boxes`, and resolved material codes. This both **proves the data
is in the jsonl** (answering the "check the captures folder" ask) and doubles as a unit
fixture. Assert the known example decodes to a full cube.

**C2.** If a live `auction-events.jsonl` isn't handy locally, point the script at the
proxy's export dir; the `/captures` `.bin` files are the pre-parse raw TCP frames and
are **not** needed since `RawHex` already carries the decoded stack bytes.

---

## Requirement → change traceability
| Requirement | Where |
|-------------|-------|
| Don't collapse chiseled blocks | A2 (per-design synthetic ids) |
| Show 3D render | A1+A3 (decode) → B2/B3 (viewer + colors) |
| Show block name if present | A1/A3 (`blockName`) → B4 |
| Collapse `l-dungeon` together | A2 (group named designs by `blockName`) |

## Tradeoffs / open questions
- **Texture fidelity:** solid per-material colors, not real block textures (atlas
  unavailable). Acceptable for identifying designs; revisit if exact skins are wanted.
- **Viewer tech:** start with a zero-dep canvas isometric render; upgrade to three.js
  for orbit/interactivity if desired (bundle-size cost).
- **Unnamed design granularity:** hashing `(materials, cuboids)` treats rotations as
  distinct designs. If that fragments too much, normalize rotation before hashing.
- **Dataset size:** only attach `chisel` payloads to chiseled/microblock listings;
  geometry can be deduped onto the catalog entry to keep `listings.json` small.
