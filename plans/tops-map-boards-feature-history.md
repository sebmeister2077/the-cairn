# TOPS Map Planning Boards ("Draw on the Map") — Feature History

A living record of the drawing/boards feature: the initial draft, then each round
of user feedback with the decision taken and what actually shipped. Keep new
feedback appended under a new "Round" heading so context stays small.

## File map (where things live)
- Types: `frontend/src/lib/drawing/types.ts` (`DrawElement` union: pen/marker/line/arrow/rect/circle/poly/text/stamp; `PolyShape`, `ShapeKind`, `Board`, `Blueprint`)
- Geometry: `frontend/src/lib/drawing/elements.ts` (bbox, `translateElement`, hit-testing, `polyVertices`, resize handles + `resizeElement`)
- Canvas render: `frontend/src/lib/drawing/render.ts`
- Vector stamp icons: `frontend/src/lib/drawing/stampIcons.ts`
- Gesture controller: `frontend/src/hooks/useMapDrawing.ts`
- State (Redux, mirrored to IndexedDB): `frontend/src/store/slices/drawing.ts`, `lib/drawing/boardStore.ts`
- Persisted UI prefs (survive reload): `frontend/src/store/slices/mapView.ts` (`fullscreenControlsCollapsed`, `boardControlsCollapsed`)
- UI: `frontend/src/components/tops-map/drawing/{DrawingToolbar,MapDrawingUi,BoardsPanel,BlueprintLibrary}.tsx`
- Viewer bridge: `useDrawingViewerProps.ts` → `WebCartographerMapViewer.tsx` (`MapDrawingProps`)

All geometry is in WORLD blocks; the viewer supplies project/unproject so drawings
stay anchored to terrain and scale with zoom.

---

## Initial feature draft (v1)
The first version shipped a planning-board surface on the TOPS map:
- **Tools**: pen, marker (highlighter), line, arrow, rectangle, circle, text, stamp (emoji), eraser, select (marquee).
- **Boards**: multiple named boards, autosaved to IndexedDB; board picker + rename/delete.
- **Blueprints**: marquee-select elements → save as a reusable group; paste/stamp a blueprint clone onto the map.
- **Style**: single shared "Style options" gear popup (colour palette, width, marker opacity, shape fill, text size, stamp glyph + size).
- **Undo/redo** (in-memory), clear board, keyboard Ctrl+Z / Ctrl+Y.
- Drawings rendered on the canvas above the map + overlays.

---

## Round 1 — batch testing feedback
Source: user testing notes (move items, opacity, per-tool style popups, right-click,
stamp default size, scroll/keyboard on sliders, fonts/formatting, outline for all,
layers, OS-dependent stamps).

Design decisions taken (via clarifying questions): general opacity affects only
new elements; stamps default to 10-block minimum; keep emoji for now (icon set
deferred); layers deferred.

Shipped:
- **Move selected items**: in the Select tool, drag a marquee to select, then drag *inside* the selection to move it (live preview, undoable). `moveElements` action + `move` gesture.
- **General opacity**: one Opacity slider per tool popup applies to whatever you draw next (pen/line/arrow/shape stroke/text/stamp). Marker keeps its own highlighter opacity.
- **Stamp default size** lowered (default 20, slider min 10).
- **Scroll + keyboard on sliders**: `Slider` gains mouse-wheel adjust (Shift = ×10) site-wide, plus an optional compact number field (`showInput`) used across the drawing popups.
- **Per-tool style popups + right-click**: removed the single gear menu; selecting a tool (or right-clicking it) opens that tool's own settings popup.
- **Text formatting**: bold, italic, font picker (Sans / Serif / Mono / Rounded).
- **Outline** option extended to text & stamps (toggle + colour), not just shapes.

Deferred: **Layers**; **OS-independent stamps** (user picked a bundled SVG icon-set direction for later).

---

## Round 2 — trash button behaviour
Request: the trash button should only delete *selected* items, never clear the whole board; disable it when nothing is selected.

Shipped:
- Trash now deletes only the current selection; disabled (greyed) with an explanatory tooltip when the selection is empty. Removed the "Clear board?" confirm flow. Deletion stays undoable.

---

## Round 3 — pan the map while drawing
Request: allow moving around the map with middle-click (scroll-click) or right-click while in drawing mode.

Shipped:
- **Middle-click or right-click drag pans** the map anywhere, including mid-drawing (left button still draws).
- Suppresses the OS middle-click autoscroll and the browser right-click menu over the map; a right-*drag* won't trigger a translocator right-click, but a stationary right-click still does.

---

## Round 4 — stamps, outline, selection, text editing, colour redundancy
Source feedback: emoji/stamp outline only worked in black; selecting text/stamps
showed only a tiny hitbox that was hard to drag; want to edit text content and
styles after writing; colour felt redundant (bottom row *and* per-tool popup, same
state); asked for a better set of stamp options.

Shipped:
- **Stamps → vector icons**: replaced emoji with ~37 baked Lucide (ISC-licensed) vector icons drawn directly on the canvas (`stampIcons.ts`). Fixes the outline bug (vectors stroke in any colour), makes stamps identical across OSes, and gives a much bigger/cleaner icon set. Icons are tinted by the shared colour row. Legacy emoji stamps on old boards still render.
- **Selection hitbox fix**: text/stamp bounding boxes were a single point; now text uses an approximated width×height box from its top-left anchor and stamps a box centred on their position — fixing both the dashed highlight and the drag-to-move grab region.
- **Edit text after writing**: double-click a text element (in the Select tool) to edit its content in a pre-filled dialog (`updateElement`, `requestTextEdit`, `editingTextId`).
- **Edit styles after writing**: with a selection active, a wand button applies the current tool style to the selection per element kind, in one undoable step (`restyleSelected`).
- **Colour de-duplicated**: removed the colour swatch from per-tool popups; the always-visible bottom colour row is the single source (hidden for eraser/select).

---

## Round 5 — declutter the toolbar, fold Line/Arrow into Pen, Shapes tool, split hide toggles
Source feedback: arrow positioning felt off; the toolbar had too many top-level
tools; Line + Arrow could live inside Pen as combinable toggles (an arrow should
work even on a non-straight stroke); Marker is now obsolete; wanted a grouped
"Shapes" tool (square / rounded square / circle); colours could be their own
control or per-tool (plus an optional wheel + eyedropper); the map's overlay
side-controls and the board controls should hide *independently*; and praise for
"apply current style".

Design decisions:
- **Marker removed from the toolbar** (Pen + opacity covers the highlighter use).
  Legacy `marker` elements on old boards still render, and the `marker` element
  kind is kept so nothing breaks.
- **Pen absorbs Line + Arrow** as two combinable toggles (`penStraight`,
  `penArrow`): freehand / straight line / straight arrow / freehand-with-
  arrowhead. Kept as toggles (not new tools) to shrink the top row. `StrokeElement`
  gained an optional `arrow?: boolean` so freehand strokes can carry a head.
- **Shapes grouped** under one `shape` tool that reads `style.shapeKind` rather
  than three separate buttons. Added an optional `cornerRadiusBlocks` to
  `RectElement` for the rounded variant.
- **Colours stay per-tool (shared row)** but gained a native custom-colour
  picker + an eyedropper (Chromium `EyeDropper` API, feature-detected). Rejected
  a full standalone colour tool as more clicks for the common case.

Shipped:
- **Arrow positioning fix**: the shaft now stops at the base of the arrowhead so a
  round line-cap no longer pokes past the tip; the tip sits exactly on the
  endpoint (`render.ts` — shared arrowhead geometry constants).
- **Pen toggles**: Straight + Arrowhead switches in the Pen popup; arrowheads also
  render at the end of freehand strokes.
- **Shapes tool**: rectangle / rounded rectangle / circle picker with a corner-
  radius slider for the rounded one.
- **Custom colour + eyedropper** added to the quick-colour row.
- **Independent hide toggles**: board controls now collapse to a small "Board"
  restore chip via their own toggle, decoupled from the map's overlay "Hide
  controls" (which no longer also hides the board bar).

Deferred at the time: resizing shapes by their corners; more shape types.

---

## Round 6 — resize selected elements by handles
Request: shapes (and ideally anything) should be resizable by dragging corners
after selection.

Decision: make it general rather than shape-only. A **single** selected element
in the Select tool shows drag handles; multi-select still just moves.

Shipped (`elements.ts` `elementResizeHandles` + `resizeElement`, gesture in
`useMapDrawing.ts`, handle rendering in `WebCartographerMapViewer.tsx`):
- **line/arrow** → two endpoint handles (drag an end).
- **circle** → four cardinal handles (drag changes radius, centre fixed).
- **rect / pen / marker** → eight bbox handles (corners + edge midpoints), free
  non-uniform resize; strokes remap all their points, rects keep proportional
  corner radius.
- **text / stamp** → four corner handles, aspect-locked uniform scale of the
  font/icon size.
- Handles are white squares hit-tested in world space (~9px), checked before the
  move/marquee so grabbing a corner wins; a live preview renders during the drag
  and commits once via `updateElement`.

---

## Round 7 — persist the board-controls hide state + more shapes
Two requests: (a) the "hide board controls" toggle reset on refresh; (b) can the
Shapes tool offer more shapes?

(a) **Persistence fix** — the flag lived in the `drawing` slice, which is
intentionally **blacklisted** from the localStorage envelope (boards are large and
restored from IndexedDB), so any UI flag there resets to `initialState` on reload.
Moved `boardControlsCollapsed` into the persisted `mapView` slice, next to the
analogous `fullscreenControlsCollapsed`, so the preference now survives reloads.

(b) **More shapes** — added a single `poly` element kind (shares a bbox `a`/`b`;
concrete vertices derived at render/hit-test time via `polyVertices`) covering
**triangle, diamond, ellipse, pentagon, hexagon, octagon, star**. The Shapes
picker is now a 5-column grid (rectangle, rounded, circle, ellipse, triangle,
diamond, pentagon, hexagon, octagon, star). `ShapeKind` (in `types.ts`) is the
shared union used by `style.shapeKind`. Poly gets proper hit-testing (point-in-
polygon for fills, ellipse-normalised test for ellipse), bbox resize, translate,
and restyle support. `circle` stays its own uniform kind; `rect`/`roundedRect`
stay `RectElement`.

---

## Round 8 — tiny sizes, freehand arrows, layers, unified popups, blueprint search, duplicate + rotate
Source feedback: minimum sizes should start at 1 (user works very zoomed in);
freehand arrowheads are broken unless the stroke is straight; colours could be
per-tool or their own tool to shrink the menu (admin: keep the single shared
colour so tool1/tool2 don't diverge → no change); add a couple of layers so
drawings don't interact; unify the control language/order across tool popups
(size/opacity/etc. appeared in different orders); search through blueprints;
duplicate a selection; rotate selected items.

Shipped:
- **Min size 1**: Size / corner-radius sliders now `min=1 step=1`; resize floors
  for text/stamp lowered 4→1 (`elements.ts`).
- **Freehand arrowhead fix**: the head now walks back a full head-length along
  the stroke for a stable direction (adjacent samples were sub-pixel apart, so
  the barbs pointed the wrong way on curves) — `render.ts`.
- **Colours stay shared** (admin decision): unchanged.
- **Unified popups**: every tool popup follows **Size → Opacity → tool-specific →
  colours (fill/outline)**, with one label word "Size" everywhere (was "Line
  width" / "Text size" / "Stamp size"). `DrawingToolbar.tsx`.
- **Layers**: `Board.layers` + `activeLayerId` (+ optional `layerId` per element);
  hidden layers aren't drawn, locked layers are drawn but not selectable/erasable,
  new elements land on the active layer, stack order controls draw order. New
  `LayersPanel` (add / rename / show-hide / lock / reorder / delete-with-elements).
  Legacy boards normalise to one default layer on open (`ensureBoardLayers`).
- **Blueprint search**: a filter box appears once there are >3 blueprints.
- **Duplicate selection**: `duplicateSelected` clones the selection (nudged) onto
  the same layers and selects the copies; Copy button in the toolbar.
- **Rotate**: `rotation` field on rect/poly/text/stamp (point kinds rotate their
  points). A rotate dot above a single selected element drags to rotate; toolbar
  buttons rotate the selection ±15°. Rotated box elements hide resize handles
  (rotate-only) to avoid an axis/rotated handle mismatch.

Deferred: rotating a rotated element's resize handles (resize hidden while
rotated); shift-to-constrain; numeric rotation entry.

---

## Round 9 — layer z-order, group rotation, freehand arrow tip
Source feedback: layer order wasn't applied (last-drawn always on top regardless
of layer); multi-select rotation should spin the whole selection about its centre
(pasted blueprints broke when rotated) and the rotate handle didn't appear for a
multi-selection; the free-hand Pen arrow sat just *before* the end instead of at
the very end like the straight arrow.

Shipped:
- **Layer z-order**: `moveLayer` now reorders via `splice` (the previous Immer
  destructuring swap could leave the array unreordered, so stacking never
  changed). Elements are already drawn ordered by layer (`useDrawingViewerProps`).
- **Group rotation**: `rotateElement(el, angle, pivot)` now orbits box/text/stamp
  centres (and circle centres) around the pivot instead of only bumping the
  stored angle, so `rotateSelected` rotates the whole selection rigidly about the
  selection-bbox centre — blueprints/groups rotate without distorting. The rotate
  handle now shows for multi-selections (at the group's top-centre); single
  elements keep their own rotation-aware handle.
- **Free-hand arrow tip**: the stroke is trimmed back by the head length (like the
  straight arrow) so the round cap tucks under the head and the tip lands exactly
  on the last point (`trimPolylineEnd` in `render.ts`).

---

## Round 10 — stable toolbar width + group resize
Two requests: (a) the toolbar changed width a lot depending on the selected
tool, whether the colour palette showed, and whether the select-mode help text
showed — sometimes very wide, sometimes half-size, and being centred it shifted
around; (b) in Select mode, resizing a *multi-element* selection as one, keeping
the elements' relative sizes/positions.

Design decisions:
- **Fixed-width toolbar** (`w-72`, matching the tool popovers). Content wraps
  within that width, so appearing/disappearing controls (selection-action
  buttons, the colour row, the select-mode help text) only change the toolbar's
  *height*, never its width — and, being centre-anchored, it no longer shifts
  sideways. Chosen over always-rendering every button (which added clutter) or
  hard-structuring rows (fragile).
- **Group resize is uniform (aspect-locked)** about the opposite corner, scaling
  both geometry *and* sizes (stroke widths, radii, glyph/text sizes). This is the
  only interpretation that keeps the selection "the same relative to each other,
  just bigger/smaller"; non-uniform per-axis scaling would distort circles/text.

Shipped:
- **Stable toolbar**: `DrawingToolbar` container is now `w-72`; the select-mode
  help text wraps within it.
- **Group corner-resize**: a multi-element selection now shows four white corner
  handles (plus the existing group rotate dot). Dragging a corner scales the
  whole selection uniformly about the opposite corner with a live preview,
  committed once (undoable). New `scaleElement(el, factor, origin)` +
  `groupResizeHandles` / `oppositeCorner` in `elements.ts`; a `groupResize`
  gesture in `useMapDrawing.ts` (`onScaleGroup`); a `scaleSelected` action in the
  `drawing` slice; wired through `MapDrawingProps.onScaleGroup` /
  `useDrawingViewerProps`. Single-element resize is unchanged.

---

## Round 11 — Pen outline
Request: give the Pen tool an outline/halo option, just like Text (and stamps).

Shipped:
- **Pen halo**: `StrokeElement` gains optional `outline` + `outlineColor`; the
  renderer draws a wider halo pass under the stroke (dot, shaft, and arrowhead)
  before the main pass. The Pen popup now shows the shared `OutlineControls`
  (same `style.outlineEnabled` / `outlineColor` state as Text/Stamp), the gesture
  bakes the outline onto new pen strokes, and the wand (`restyleSelected`) applies
  it to selected pen strokes. Marker (highlighter) is unaffected.

---

## Deferred / backlog
- **Shift-to-constrain** while drawing/resizing (square/circle lock, 45° line snap) and numeric size/rotation entry for a selected element.
- **Resize while rotated** (currently resize handles hide for a rotated box/text/stamp; rotate back to 0 to resize).

---

## How to add new feedback
Append a new `## Round N — <topic>` section with: the raw request, any design
decision, and a short "Shipped:" list. Keep entries terse so this file stays a
quick reference rather than a full spec.
