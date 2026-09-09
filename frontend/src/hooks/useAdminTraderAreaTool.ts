import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    adminBulkDeleteTraders,
    adminListTradersInArea,
    type AdminTraderInArea,
} from "@/lib/api";

export interface AreaBox {
    min_x: number;
    max_x: number;
    min_z: number;
    max_z: number;
}

export interface AdminTraderAreaTool {
    active: boolean;
    open: () => void;
    close: () => void;
    /** True while waiting for the next map click to set the area center. */
    picking: boolean;
    startPicking: () => void;
    cancelPicking: () => void;
    center: { x: number; z: number } | null;
    /** Half-extent of the square selection box, in blocks. */
    radius: number;
    setRadius: (n: number) => void;
    box: AreaBox | null;
    /** Route a map world-click here while `picking` is true. */
    handleWorldClick: (x: number, z: number) => void;
    clearCenter: () => void;
    traders: AdminTraderInArea[];
    isFetching: boolean;
    isError: boolean;
    selectedIds: Set<string>;
    toggleId: (id: string) => void;
    selectAll: () => void;
    clearSelection: () => void;
    deleteSelected: () => Promise<void>;
    isDeleting: boolean;
    lastDeletedCount: number | null;
}

const DEFAULT_RADIUS = 250;
const MIN_RADIUS = 25;
const MAX_RADIUS = 5000;

/**
 * State + data for the admin map area tool: pick a center on the map, define a
 * square radius, review the traders inside (with who / when / method), and
 * bulk-delete the selected ones. Kept as a hook so the map click routing lives
 * in the page while the panel just consumes the return value.
 */
export function useAdminTraderAreaTool(enabled: boolean): AdminTraderAreaTool {
    const queryClient = useQueryClient();
    const [active, setActive] = useState(false);
    const [picking, setPicking] = useState(false);
    const [center, setCenter] = useState<{ x: number; z: number } | null>(null);
    const [radius, setRadiusRaw] = useState(DEFAULT_RADIUS);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [lastDeletedCount, setLastDeletedCount] = useState<number | null>(null);

    const setRadius = useCallback((n: number) => {
        if (!Number.isFinite(n)) return;
        setRadiusRaw(Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Math.round(n))));
    }, []);

    const box: AreaBox | null = useMemo(() => {
        if (!center) return null;
        return {
            min_x: center.x - radius,
            max_x: center.x + radius,
            min_z: center.z - radius,
            max_z: center.z + radius,
        };
    }, [center, radius]);

    const areaQuery = useQuery({
        queryKey: [
            "admin-traders-in-area",
            box?.min_x,
            box?.max_x,
            box?.min_z,
            box?.max_z,
        ],
        queryFn: () => adminListTradersInArea(box as AreaBox),
        enabled: enabled && active && box != null,
        staleTime: 0,
    });

    const traders = useMemo(
        () => areaQuery.data?.traders ?? [],
        [areaQuery.data],
    );

    // Default: every trader in the area is selected for removal. Recomputed
    // whenever the result set changes so newly-fetched ids start checked.
    const resultKey = traders.map((t) => t.trader_id).join(",");
    useEffect(() => {
        setSelectedIds(new Set(traders.map((t) => t.trader_id)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resultKey]);

    const toggleId = useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const selectAll = useCallback(() => {
        setSelectedIds(new Set(traders.map((t) => t.trader_id)));
    }, [traders]);

    const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

    const handleWorldClick = useCallback((x: number, z: number) => {
        setCenter({ x: Math.round(x), z: Math.round(z) });
        setPicking(false);
        setLastDeletedCount(null);
    }, []);

    const deleteMutation = useMutation({
        mutationFn: (ids: string[]) => adminBulkDeleteTraders(ids),
        onSuccess: (res) => {
            setLastDeletedCount(res.deleted);
            // Refresh the live traders overlay + the area result so removed dots
            // disappear from the map and the list.
            queryClient.invalidateQueries({ queryKey: ["overlay", "traders"] });
            queryClient.invalidateQueries({ queryKey: ["admin-traders-in-area"] });
        },
    });

    const deleteSelected = useCallback(async () => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        await deleteMutation.mutateAsync(ids);
    }, [selectedIds, deleteMutation]);

    const open = useCallback(() => setActive(true), []);
    const close = useCallback(() => {
        setActive(false);
        setPicking(false);
    }, []);
    const startPicking = useCallback(() => setPicking(true), []);
    const cancelPicking = useCallback(() => setPicking(false), []);
    const clearCenter = useCallback(() => {
        setCenter(null);
        setLastDeletedCount(null);
    }, []);

    // ESC cancels an in-progress location pick without closing the panel.
    useEffect(() => {
        if (!picking) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setPicking(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [picking]);

    return {
        active,
        open,
        close,
        picking,
        startPicking,
        cancelPicking,
        center,
        radius,
        setRadius,
        box,
        handleWorldClick,
        clearCenter,
        traders,
        isFetching: areaQuery.isFetching,
        isError: areaQuery.isError,
        selectedIds,
        toggleId,
        selectAll,
        clearSelection,
        deleteSelected,
        isDeleting: deleteMutation.isPending,
        lastDeletedCount,
    };
}
