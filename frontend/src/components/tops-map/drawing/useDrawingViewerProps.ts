// Bridges the `drawing` Redux slice into the props the map viewer needs for its
// planning-board surface. Loads the active paste blueprint's elements from
// IndexedDB so the ghost can follow the cursor.

import { useEffect, useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { drawingActions } from "@/store/slices/drawing";
import { useDrawingBoards } from "@/hooks/useDrawingBoards";
import type { MapDrawingProps } from "@/components/tops-map/WebCartographerMapViewer";
import type { DrawElement, Layer } from "@/lib/drawing/types";

const EMPTY_ELEMENTS: DrawElement[] = [];
const EMPTY_LAYERS: Layer[] = [];
const EMPTY_LOCKED: ReadonlySet<string> = new Set();

export function useDrawingViewerProps(): MapDrawingProps {
    const dispatch = useAppDispatch();
    const drawingMode = useAppSelector((s) => s.drawing.drawingMode);
    const activeTool = useAppSelector((s) => s.drawing.activeTool);
    const style = useAppSelector((s) => s.drawing.style);
    const activeBoardId = useAppSelector((s) => s.drawing.activeBoardId);
    const allElements = useAppSelector((s) => s.drawing.activeBoard?.elements) ?? EMPTY_ELEMENTS;
    const layers = useAppSelector((s) => s.drawing.activeBoard?.layers) ?? EMPTY_LAYERS;
    const selectedIds = useAppSelector((s) => s.drawing.selectedIds);
    const pasteBlueprintId = useAppSelector((s) => s.drawing.pasteBlueprintId);
    const { loadBlueprint } = useDrawingBoards();

    // Hidden layers aren't drawn; locked layers are drawn but not editable.
    // Elements are ordered by their layer's stack position (bottom→top).
    const { elements, lockedIds } = useMemo(() => {
        if (layers.length === 0) return { elements: allElements, lockedIds: EMPTY_LOCKED };
        const meta = new Map(layers.map((l, i) => [l.id, { i, visible: l.visible, locked: l.locked }]));
        const defaultId = layers[0].id;
        const visible: DrawElement[] = [];
        const locked = new Set<string>();
        for (const el of allElements) {
            const m = meta.get(el.layerId ?? defaultId) ?? meta.get(defaultId)!;
            if (!m.visible) continue;
            visible.push(el);
            if (m.locked) locked.add(el.id);
        }
        const idx = (el: DrawElement) => (meta.get(el.layerId ?? defaultId) ?? meta.get(defaultId)!).i;
        visible.sort((a, b) => idx(a) - idx(b));
        return { elements: visible, lockedIds: locked as ReadonlySet<string> };
    }, [allElements, layers]);

    const [pasteElements, setPasteElements] = useState<DrawElement[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        const run = async () => {
            if (!pasteBlueprintId) {
                if (!cancelled) setPasteElements(null);
                return;
            }
            const bp = await loadBlueprint(pasteBlueprintId);
            if (!cancelled) setPasteElements(bp?.elements ?? null);
        };
        void run();
        return () => {
            cancelled = true;
        };
    }, [pasteBlueprintId, loadBlueprint]);

    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const pasteBlueprint = useMemo(
        () => (pasteElements ? { elements: pasteElements } : null),
        [pasteElements],
    );

    return useMemo<MapDrawingProps>(
        () => ({
            enabled: drawingMode && Boolean(activeBoardId),
            tool: activeTool,
            style,
            elements,
            selectedIds: selectedSet,
            lockedIds,
            pasteBlueprint,
            onCommit: (el) => dispatch(drawingActions.addElement(el)),
            onCommitMany: (els) => dispatch(drawingActions.addElements(els)),
            onErase: (ids) => dispatch(drawingActions.eraseElements(ids)),
            onSelect: (ids) => dispatch(drawingActions.setSelection(ids)),
            onMove: (ids, dx, dz) => dispatch(drawingActions.moveElements({ ids, dx, dz })),
            onResize: (el) => dispatch(drawingActions.updateElement({ id: el.id, changes: el })),
            onRotate: (angleDelta) => dispatch(drawingActions.rotateSelected(angleDelta)),
            onRequestText: (world) => dispatch(drawingActions.requestText(world)),
            onEditText: (id) => dispatch(drawingActions.requestTextEdit(id)),
        }),
        [
            dispatch,
            drawingMode,
            activeBoardId,
            activeTool,
            style,
            elements,
            selectedSet,
            lockedIds,
            pasteBlueprint,
        ],
    );
}
