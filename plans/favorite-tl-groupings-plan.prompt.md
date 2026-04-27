# Plan: Favorite TL Groupings on TOPS Map

Add a local-only (browser) feature on the TOPS Map view that lets users create named groupings of Translocators (TLs) and use them to (a) filter the map to only show TLs in selected groupings or (b) highlight favorites while still rendering all TLs. Multiple groupings can be active at once; a TL can belong to multiple groupings. UI lives in a right-side drawer; data persists in localStorage with JSON import/export.

## Phase 1 — Data model & storage (foundation)

1. Define types and storage helpers in a new file `frontend/src/lib/tl-groupings.ts`:
   - `TLId = string` — canonical key built from segment coords: `${x1},${z1},${x2},${z2}` (after the same z-negation transform already applied when loading the geojson, so keys match what the page works with).
   - `TLGrouping = { id: string (uuid/crypto.randomUUID), name: string, color?: string, tlIds: string[], createdAt: number, updatedAt: number }`.
   - Pure helpers: `tlIdFor(segment)`, `loadGroupings()`, `saveGroupings(list)`, `serializeForExport(list)`, `parseImport(json)` (validate shape; reject silently-bad files).
   - localStorage key: `tops-map-tl-groupings` (JSON array). Versioned wrapper: `{ version: 1, groupings: [...] }`.
2. Build a small React hook `useTLGroupings()` in same file:
   - Returns `{ groupings, createGrouping, renameGrouping, deleteGrouping, addTLs(groupingId, tlIds[]), removeTLs(groupingId, tlIds[]), setColor, importJSON, exportJSON }`.
   - State held in component, persisted on every mutation; cross-tab sync via `storage` event listener.
3. Define a separate hook/state for ephemeral view state (NOT persisted to keep it simple):
   - `activeGroupingIds: Set<string>` (which groupings are toggled on)
   - `viewMode: "all" | "filter" | "highlight"` — "all" means groupings don't affect rendering.
   - `editingGroupingId: string | null` — when non-null, edit mode is active.

## Phase 2 — MapViewer multi-highlight support (parallel with Phase 3)

Currently `MapViewer` accepts a single `highlightedSegment`. To support highlighting many TLs at once (favorites highlight mode + showing membership in edit mode), extend it:

4. In `frontend/src/components/MapViewer.tsx`:
   - Add new optional prop `highlightedSegments?: WorldLineSegment[]` (kept alongside existing `highlightedSegment` for backward compat).
   - Internally combine into a `Set<string>` keyed by the same coord-tuple format used for `TLId`.
   - In the segment render path, if a segment's key is in the set, render it with the existing highlight style (same color/stroke as current pinned highlight). Reuse the existing single-highlight visual exactly — no new style work.
   - Add an optional `secondaryHighlightedSegments?: WorldLineSegment[]` for edit-mode "candidate but not yet added" — render with a distinct dashed/lighter style. Only use if needed; otherwise drop and rely on a single highlight set with the active grouping's color.

## Phase 3 — Groupings drawer UI (parallel with Phase 2)

5. Create `frontend/src/components/tops-map/TLGroupingsDrawer.tsx`:
   - Right-side `Sheet` (shadcn/ui) opened by a new toolbar button "Groupings" (with count badge) added near the existing translocator/landmark switches around line 600–660 of [TOPSMapViewPage.tsx](frontend/src/pages/TOPSMapViewPage.tsx).
   - Header section: view-mode segmented control (`All TLs` / `Filter to selected` / `Highlight selected`), and Import / Export buttons.
   - List section: one row per grouping with: checkbox (toggles active), name (inline-rename on click), TL count, color swatch (optional small palette), Edit button (toggles edit mode for that grouping), Delete button (with confirm).
   - "New grouping" button at the bottom — creates an empty grouping and immediately enters edit mode for it.
   - Empty state copy explaining the feature.
6. Edit-mode banner on the page (rendered above the MapViewer when `editingGroupingId !== null`):
   - Shows "Editing: <name> — click TLs on the map to add or remove. N selected." with a "Done" button.
   - While in edit mode, the existing left-click handler in `TOPSMapViewPage.tsx` (`handleTranslocatorClick`) is reused but rewired: instead of (or in addition to) selecting/displaying coords, it toggles the clicked TL's membership in the editing grouping. Right-click pin behavior preserved.
   - Visual: TLs already in the editing grouping render via `highlightedSegments` so the user sees the current selection.

## Phase 4 — Wire view modes into rendering

7. In [TOPSMapViewPage.tsx](frontend/src/pages/TOPSMapViewPage.tsx) where `<MapViewer overlaySegments={showTranslocators ? translocatorSegments : undefined} ... />` is set up:
   - Compute `activeTLIdSet` = union of `tlIds` from all active groupings.
   - When `viewMode === "filter"` and `activeTLIdSet.size > 0`: pass a filtered `translocatorSegments` (keep only segments whose `tlIdFor(seg)` is in the set). Update the displayed `translocatorCount` accordingly (e.g. `123 / 4,567 shown`).
   - When `viewMode === "highlight"`: pass full `translocatorSegments` plus the set as `highlightedSegments`.
   - When `viewMode === "all"` or no active groupings: behave exactly as today.
   - In edit mode, force `viewMode` behavior to "all" (so user can click any TL) and pass `highlightedSegments` = current grouping's members.

## Phase 5 — Import / export

8. Export: build a JSON blob from `serializeForExport()` and trigger download `tops-tl-groupings-YYYY-MM-DD.json`. (Reuse the same approach as the existing PNG download in TOPSMapViewPage if helpful.)
9. Import: hidden `<input type="file" accept="application/json">` triggered by Import button. On select, parse, validate, then prompt the user with a small dialog: "Replace existing groupings or merge?" — merge appends groupings with new ids; replace overwrites localStorage. Show a toast/error on invalid file.

## Phase 6 — Polish

10. Persist `viewMode` and `activeGroupingIds` to localStorage so they survive reloads (separate keys, e.g. `tops-map-tl-groupings-view-mode`, `tops-map-tl-groupings-active`).
11. Defensive cleanup: when the static `translocators.geojson` changes upstream, some `TLId`s in stored groupings may no longer exist. Don't delete them — just compute `validCount` per grouping in the drawer (e.g. "12 TLs (2 missing)") so users notice without losing data.

## Relevant files

- [frontend/src/pages/TOPSMapViewPage.tsx](../frontend/src/pages/TOPSMapViewPage.tsx) — wire toolbar button, drawer, edit-mode banner, and view-mode logic into existing translocator state (`translocatorSegments`, `selectedTranslocator`, `handleTranslocatorClick`, `handleTranslocatorRightClick`, `showTranslocators`).
- [frontend/src/components/MapViewer.tsx](../frontend/src/components/MapViewer.tsx) — add `highlightedSegments` (set-based) alongside existing `highlightedSegment`; reuse current highlight style.
- `frontend/src/components/tops-map/TLGroupingsDrawer.tsx` — new component (sheet, list, edit controls, import/export buttons).
- `frontend/src/lib/tl-groupings.ts` — new: types, `tlIdFor`, localStorage helpers, `useTLGroupings` hook, import/export validators.
- `frontend/src/components/ui/sheet.tsx` — confirm it exists (shadcn); if not, add via shadcn CLI alongside this work.

## Verification

1. Manual: open TOPS map page, open Groupings drawer, create grouping "Spawn TLs", click Edit, click 3 TLs on the map → see them highlighted; press Done.
2. Toggle view mode to "Filter to selected" → only those 3 TLs render; count shows "3 / N shown".
3. Toggle view mode to "Highlight selected" → all TLs render, the 3 favorites are highlighted.
4. Create a second grouping; activate both → union renders/highlights correctly.
5. Right-click pin and left-click select still work normally when not in edit mode.
6. Refresh page → groupings persist; active selection + view mode also persist.
7. Export JSON, clear localStorage, import the file → groupings restored.
8. Import "merge" appends; "replace" overwrites; malformed JSON shows an error and changes nothing.
9. Open the page in two tabs → mutations in one tab reflect in the other (storage event).
10. Run `pnpm lint` and `pnpm build` (or the project's equivalent) in `frontend/` — no errors.

## Decisions

- Local-only storage (per user request); no backend changes.
- TL identity = coord tuple `${x1},${z1},${x2},${z2}` (stable against reorder, fragile only on actual TL edit — handled by "missing" indicator, not deletion).
- Sidebar drawer (Sheet) for management; dedicated edit mode for bulk editing.
- Multi-grouping membership allowed; multi-grouping activation allowed (union).
- View modes: `all` / `filter` / `highlight`, user-toggleable.
- Out of scope: sharing groupings via URL, server sync, per-grouping styling beyond an optional color swatch, search/filter inside the drawer.

## Further Considerations

1. Per-grouping color on the map? Currently every TL renders with the same color and we'd reuse the single highlight style for all favorites. Option A: monochrome highlight (simplest, ship first). Option B: per-grouping color shown when in highlight mode (requires extending MapViewer to accept a colored-segments map). Recommend **A** for v1.
2. Should the drawer button live in the existing controls row or in the MapViewer toolbar (`toolbarStart`)? Recommend **controls row next to the translocator switch** for discoverability.
3. Should creating a grouping from a single selected TL be a shortcut on the TL info card too (e.g. "Add to grouping…" menu)? Recommend deferring to v2 since you chose "Dedicated edit mode" — but trivial to add later.
