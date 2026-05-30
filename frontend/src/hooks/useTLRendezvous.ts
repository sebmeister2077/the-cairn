// `useTLRendezvous` — compute a meeting point for the planner's party
// of players against the loaded translocator overlay, debounced.
//
// Sibling of `useTLRoute`: only active while the planner is in
// `"rendezvous"` mode and at least two player positions are filled in.
// Compute always runs in the worker (`tl-routing.worker.ts`) — the
// rendezvous algorithm is N× more expensive than a single route so we
// don't bother with a main-thread fallback.

import { useEffect, useMemo, useRef } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { useActiveTranslocators } from "@/hooks/useActiveTranslocators";
import type {
    RendezvousResult,
    RouteOptions,
    WorldPoint,
} from "@/lib/tl-routing";
import {
    computeRendezvousAsync,
    isRouteWorkerAvailable,
} from "@/lib/tl-routing-client";
import {
    setRendezvousComputing,
    setRendezvousError,
    setRendezvousResult,
} from "@/store/slices/routePlanner";

const DEBOUNCE_MS = 150;

interface UseTLRendezvousResult {
    result: RendezvousResult | null;
    isComputing: boolean;
    error: string | null;
}

export function useTLRendezvous(): UseTLRendezvousResult {
    const dispatch = useAppDispatch();
    const mode = useAppSelector((s) => s.routePlanner.mode);
    const players = useAppSelector((s) => s.routePlanner.players);
    const objective = useAppSelector((s) => s.routePlanner.rendezvousObjective);
    const walkSpeed = useAppSelector((s) => s.routePlanner.walkSpeed);
    const tlPenaltySeconds = useAppSelector((s) => s.routePlanner.tlPenaltySeconds);
    const kNeighbors = useAppSelector((s) => s.routePlanner.kNeighbors);
    const result = useAppSelector((s) => s.routePlanner.rendezvousResult);
    const isComputing = useAppSelector((s) => s.routePlanner.rendezvousIsComputing);
    const error = useAppSelector((s) => s.routePlanner.rendezvousError);

    // Route against the same TL set the map is drawing — see
    // `useActiveTranslocators` for the cairn/WC switch.
    const { segments, etag: segmentsEtag } = useActiveTranslocators();

    const opts = useMemo<RouteOptions>(
        () => ({ walkSpeed, tlPenaltySeconds, kNeighbors }),
        [walkSpeed, tlPenaltySeconds, kNeighbors],
    );

    // Filter to filled-in slots. We re-derive a fresh array on every
    // render but the effect's dep array uses a stable key string built
    // from the points so it only re-runs when positions actually change.
    const filled: WorldPoint[] = useMemo(
        () =>
            players
                .filter((p): p is NonNullable<typeof p> => p != null)
                .map((p) => ({ x: p.point.x, z: p.point.z })),
        [players],
    );
    const playersKey = useMemo(
        () => filled.map((p) => `${p.x},${p.z}`).join("|"),
        [filled],
    );

    const pendingTimer = useRef<number | null>(null);
    const pendingAbort = useRef<AbortController | null>(null);

    useEffect(() => {
        if (pendingTimer.current != null) {
            window.clearTimeout(pendingTimer.current);
            pendingTimer.current = null;
        }
        if (pendingAbort.current) {
            pendingAbort.current.abort();
            pendingAbort.current = null;
        }
        if (mode !== "rendezvous") return;
        if (filled.length < 2) return;
        if (!segments) return;
        if (!isRouteWorkerAvailable()) {
            dispatch(
                setRendezvousError(
                    "Rendezvous mode requires Web Workers (unsupported in this browser).",
                ),
            );
            return;
        }

        dispatch(setRendezvousComputing(true));

        const capturedSegments = segments;
        const capturedPlayers = filled;
        const capturedObjective = objective;

        pendingTimer.current = window.setTimeout(() => {
            const ctrl = new AbortController();
            pendingAbort.current = ctrl;
            computeRendezvousAsync({
                segments: capturedSegments,
                segmentsKey: segmentsEtag ?? `len:${capturedSegments.length}`,
                players: capturedPlayers,
                opts,
                objective: capturedObjective,
                signal: ctrl.signal,
            })
                .then(({ result: r, elapsedMs }) => {
                    if (ctrl.signal.aborted) return;
                    if (import.meta.env.DEV) {
                        // eslint-disable-next-line no-console
                        console.debug(
                            `[useTLRendezvous] computed in ${elapsedMs.toFixed(1)}ms ` +
                            `(players=${capturedPlayers.length}, objective=${capturedObjective}, ` +
                            `segments=${capturedSegments.length})`,
                        );
                    }
                    if (!r) {
                        dispatch(
                            setRendezvousError(
                                "No meeting point reachable for everyone. Try widening neighbour count or moving a player.",
                            ),
                        );
                        dispatch(setRendezvousResult(null));
                    } else {
                        dispatch(setRendezvousResult(r));
                    }
                })
                .catch((err: unknown) => {
                    if (ctrl.signal.aborted) return;
                    if (err instanceof DOMException && err.name === "AbortError") return;
                    const message = err instanceof Error ? err.message : "Rendezvous failed";
                    dispatch(setRendezvousError(message));
                });
        }, DEBOUNCE_MS);

        return () => {
            if (pendingTimer.current != null) {
                window.clearTimeout(pendingTimer.current);
                pendingTimer.current = null;
            }
            if (pendingAbort.current) {
                pendingAbort.current.abort();
                pendingAbort.current = null;
            }
        };
        // playersKey covers `filled` content; we deliberately omit
        // `filled` itself to avoid re-running on array-identity churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, playersKey, objective, opts, segments, segmentsEtag, dispatch]);

    return { result, isComputing, error };
}
