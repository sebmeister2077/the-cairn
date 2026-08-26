# TOPS Map Planning Boards ("Draw on the Map") — Feature History

A living record of the drawing/boards feature: the initial draft, then each round
of user feedback with the decision taken and what actually shipped. Keep new
feedback appended under a new "Round" heading so context stays small.

## File map (where things live)
- Types: `frontend/src/lib/drawing/types.ts` (`DrawElement` union: pen/marker/line/arrow/rect/circle/text/stamp, `Board`, `Blueprint`)
- Geometry: `frontend/src/lib/drawing/elements.ts` (bbox, `translateElement`, hit-testing)
- Canvas render: `frontend/src/lib/drawing/render.ts`
- Vector stamp icons: `frontend/src/lib/drawing/stampIcons.ts`
- Gesture controller: `frontend/src/hooks/useMapDrawing.ts`
- State (Redux, mirrored to IndexedDB): `frontend/src/store/slices/drawing.ts`, `lib/drawing/boardStore.ts`
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

## Deferred / backlog
- **Layers**: group drawings and show/hide them (e.g. a "rivers" or "paths" layer). Needs a data-model + persistence + panel; the largest outstanding item.

---

## How to add new feedback
Append a new `## Round N — <topic>` section with: the raw request, any design
decision, and a short "Shipped:" list. Keep entries terse so this file stays a
quick reference rather than a full spec.
