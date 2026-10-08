// `useSailboatRoute` — drives the sailboat routing worker from the planner's
// From/To endpoints. Compute is explicit (the panel calls `compute()`) because
// each run streams tile fetches through the proxy and we don't want to fire on
// every endpoint tweak.

import { useCallback, useEffect, useRef } from "react";
import { API_BASE } from "@/lib/api";
import { computeSailboatRouteAsync } from "@/lib/sailboat/sailboat-client";
import type { SailboatTL } from "@/lib/sailboat/sailboat-routing";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
    setSailboatComputing,
    setSailboatError,
    setSailboatProgress,
    setSailboatRoute,
    setSailboatScannedTiles,
} from "@/store/slices/sailboatRoute";

export interface UseSailboatRouteArgs {
    baseUrl: string;
    ext: "png" | "webp";
    boatTLs: SailboatTL[];
}

export function useSailboatRoute({ baseUrl, ext, boatTLs }: UseSailboatRouteArgs) {
    const dispatch = useAppDispatch();
    const from = useAppSelector((s) => s.sailboatRoute.from);
    const to = useAppSelector((s) => s.sailboatRoute.to);
    const landPenalty = useAppSelector((s) => s.sailboatRoute.landPenalty);
    const tlHopCost = useAppSelector((s) => s.sailboatRoute.tlHopCost);
    const maxTiles = useAppSelector((s) => s.sailboatRoute.maxTiles);
    const maxVisited = useAppSelector((s) => s.sailboatRoute.maxVisited);
    const abortRef = useRef<AbortController | null>(null);

    const cancel = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
    }, []);

    const compute = useCallback(async () => {
        if (!from || !to) return;
        if (!baseUrl) {
            dispatch(setSailboatError("No map source available for water detection."));
            return;
        }
        cancel();
        const controller = new AbortController();
        abortRef.current = controller;
        dispatch(setSailboatComputing(true));
        try {
            const { result } = await computeSailboatRouteAsync({
                proxyBase: API_BASE,
                baseUrl,
                ext,
                start: { x: from.point.x, z: from.point.z },
                dest: { x: to.point.x, z: to.point.z },
                boatTLs,
                options: { landPenalty, tlHopCost, maxTiles, maxVisited },
                signal: controller.signal,
                onProgress: (p) => {
                    dispatch(setSailboatProgress(p.visited));
                    dispatch(setSailboatScannedTiles(p.tiles));
                },
            });
            if (controller.signal.aborted) return;
            dispatch(setSailboatRoute(result));
        } catch (err) {
            if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
                return;
            }
            dispatch(setSailboatError(err instanceof Error ? err.message : String(err)));
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
        }
    }, [from, to, baseUrl, ext, boatTLs, landPenalty, tlHopCost, maxTiles, maxVisited, cancel, dispatch]);

    // Abort any in-flight compute on unmount.
    useEffect(() => () => cancel(), [cancel]);

    return { compute, cancel };
}
