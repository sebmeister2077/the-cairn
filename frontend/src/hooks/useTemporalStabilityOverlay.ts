import { useEffect, useMemo, useState } from "react";
import {
    getStabilitySliceMeta,
    getStabilityWorld,
    loadStabilityColor,
} from "@/lib/stability/loader";
import type {
    StabilityOverlayBounds,
    StabilitySliceMeta,
    StabilityYSlice,
} from "@/lib/stability/types";

/** WC world center in absolute stability raster coords. The bundled
 *  raster's `world.json` uses absolute coords (origin = 412 000, center
 *  512 000), but the viewer renders in centered TOPS coords (spawn ≈ 0,0).
 *  Subtract this offset at the hook boundary so the overlay lines up with
 *  the climate/ocean overlays that apply the same shift. */
const STABILITY_WORLD_CENTER_OFFSET = 512_000;

export interface UseTemporalStabilityOverlayParams {
    enabled: boolean;
    ySlice: StabilityYSlice;
}

export interface UseTemporalStabilityOverlayResult {
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    overlayUrl: string | null;
    overlayBounds: StabilityOverlayBounds | null;
    /** Per-slice color anchors live on the root meta; stats are per-slice. */
    sliceMeta: StabilitySliceMeta | null;
}

export function useTemporalStabilityOverlay({
    enabled,
    ySlice,
}: UseTemporalStabilityOverlayParams): UseTemporalStabilityOverlayResult {
    const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
    const [status, setStatus] = useState<UseTemporalStabilityOverlayResult["status"]>("idle");
    const [error, setError] = useState<string | null>(null);

    const sliceMeta = useMemo(
        () => (enabled ? getStabilitySliceMeta(ySlice) : null),
        [enabled, ySlice],
    );

    const overlayBounds = useMemo<StabilityOverlayBounds | null>(() => {
        if (!enabled) return null;
        const world = getStabilityWorld(ySlice);
        return {
            originX: world.originBlockX - STABILITY_WORLD_CENTER_OFFSET,
            originZ: world.originBlockZ - STABILITY_WORLD_CENTER_OFFSET,
            extentX: world.widthPx * world.blocksPerPixelX,
            extentZ: world.heightPx * world.blocksPerPixelZ,
        };
    }, [enabled, ySlice]);

    // Resolve the bundled color PNG URL for the active slice. Each slice is
    // already baked at its own Y, so there's no altitude adjustment and no
    // worker/mask step — just swap the <img> src when the slice changes.
    useEffect(() => {
        if (!enabled) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setOverlayUrl(null);
            setStatus("idle");
            setError(null);
            return;
        }
        let aborted = false;
        setStatus("loading");
        setError(null);
        loadStabilityColor(ySlice)
            .then((c) => {
                if (aborted) return;
                setOverlayUrl(c.url);
                setStatus("ready");
            })
            .catch((e: unknown) => {
                if (aborted) return;
                setError(e instanceof Error ? e.message : String(e));
                setStatus("error");
            });
        return () => {
            aborted = true;
        };
    }, [enabled, ySlice]);

    return { status, error, overlayUrl, overlayBounds, sliceMeta };
}
