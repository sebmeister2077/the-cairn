// Bridges the `drawing` Redux slice into the props the map viewer needs for its
// planning-board surface. Loads the active paste blueprint's elements from
// IndexedDB so the ghost can follow the cursor.

import { useEffect, useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { drawingActions } from "@/store/slices/drawing";
import { useDrawingBoards } from "@/hooks/useDrawingBoards";
import type { MapDrawingProps } from "@/components/tops-map/WebCartographerMapViewer";
import type { DrawElement } from "@/lib/drawing/types";

const EMPTY_ELEMENTS: DrawElement[] = [];

export function useDrawingViewerProps(): MapDrawingProps {
    const dispatch = useAppDispatch();
    const drawingMode = useAppSelector((s) => s.drawing.drawingMode);
    const activeTool = useAppSelector((s) => s.drawing.activeTool);
    const style = useAppSelector((s) => s.drawing.style);
    const activeBoardId = useAppSelector((s) => s.drawing.activeBoardId);
    const elements = useAppSelector((s) => s.drawing.activeBoard?.elements) ?? EMPTY_ELEMENTS;
    const selectedIds = useAppSelector((s) => s.drawing.selectedIds);
    const pasteBlueprintId = useAppSelector((s) => s.drawing.pasteBlueprintId);
    const { loadBlueprint } = useDrawingBoards();

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
            pasteBlueprint,
            onCommit: (el) => dispatch(drawingActions.addElement(el)),
            onCommitMany: (els) => dispatch(drawingActions.addElements(els)),
            onErase: (ids) => dispatch(drawingActions.eraseElements(ids)),
            onSelect: (ids) => dispatch(drawingActions.setSelection(ids)),
            onMove: (ids, dx, dz) => dispatch(drawingActions.moveElements({ ids, dx, dz })),
            onResize: (el) => dispatch(drawingActions.updateElement({ id: el.id, changes: el })),
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
            pasteBlueprint,
        ],
    );
}
