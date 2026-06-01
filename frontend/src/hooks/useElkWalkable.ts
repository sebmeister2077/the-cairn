// Elk-walkable edges loader. Mirrors the translocators/landmarks pattern
// — pull a presigned URL from the API, fetch + parse the JSON, push the
// resulting edge set into Redux so the routing graph can read it
// synchronously during graph construction.
//
// Backend may set `empty: true` with `url=""` when the live file has
// never been written; we treat that as "no edges" without trying to
// download. After a successful Submit the caller dispatches
// `setElkWalkableEdges` directly with the locally-mutated set or
// invalidates the query key to force a refetch — see
// `useElkWalkableSubmit`.

import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
    getElkWalkableUrl,
    submitElkWalkable,
    type ElkWalkableSubmitPayload,
} from "@/lib/api";
import type { ElkWalkableEdge, ElkWalkableFile } from "@/lib/elk-walkable";
import { canonicalEdgeKey } from "@/lib/elk-walkable";
import {
    setElkSubmitStatus,
    setElkWalkableEdges,
    setElkWalkableLoadError,
    setElkWalkableLoading,
    clearElkDraft,
} from "@/store/slices/elkWalkable";
import { useAppDispatch, useAppSelector } from "@/store/hooks";

const QUERY_KEY = ["elk-walkable"] as const;

/** ~30s less than the backend's reuse window to avoid races at the edge. */
const EXPIRY_GUARD_MS = 30_000;

interface ElkWalkableQueryResult {
    etag: string;
    expiresAt: number;
    edges: ElkWalkableEdge[];
    empty: boolean;
}

async function fetchElkWalkable(): Promise<ElkWalkableQueryResult> {
    const info = await getElkWalkableUrl();
    if (info.empty || !info.url) {
        return {
            etag: info.etag ?? "__empty__",
            expiresAt: Date.now() + 5 * 60_000,
            edges: [],
            empty: true,
        };
    }
    const res = await fetch(info.url);
    if (!res.ok) {
        throw new Error(`Failed to load elk-walkable file (${res.status})`);
    }
    const raw = (await res.json()) as unknown;
    const parsed = (raw && typeof raw === "object" ? raw : {}) as Partial<ElkWalkableFile>;
    const list = Array.isArray(parsed.edges) ? parsed.edges : [];
    // Normalise: drop malformed entries, recompute the canonical key so a
    // server typo can't put us out of sync with the routing graph.
    const edges: ElkWalkableEdge[] = [];
    for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const e = raw as ElkWalkableEdge;
        if (!e.a?.tl_id || !e.b?.tl_id) continue;
        if ((e.a.ep !== 0 && e.a.ep !== 1) || (e.b.ep !== 0 && e.b.ep !== 1)) continue;
        let key: string;
        try {
            key = canonicalEdgeKey(e.a, e.b);
        } catch {
            continue;
        }
        edges.push({ ...e, key });
    }
    const expiresAt =
        Date.now() + Math.max(0, (info.expires_in_seconds ?? 3600) * 1000 - EXPIRY_GUARD_MS);
    return { etag: info.etag ?? "", expiresAt, edges, empty: false };
}

/**
 * Mount-once hook: fetches the elk-walkable edge set and mirrors it into
 * Redux so the routing layer / planner panel can read it as plain state.
 * The TanStack Query cache stays the source of truth for refetch / retry
 * scheduling; Redux just holds the most recent snapshot.
 */
export function useElkWalkable(): UseQueryResult<ElkWalkableQueryResult> {
    const dispatch = useAppDispatch();
    const query = useQuery<ElkWalkableQueryResult>({
        queryKey: [...QUERY_KEY],
        queryFn: fetchElkWalkable,
        staleTime: 0,
        meta: { persist: true },
    });

    useEffect(() => {
        if (query.isFetching && !query.data) {
            dispatch(setElkWalkableLoading(true));
        }
    }, [dispatch, query.isFetching, query.data]);

    useEffect(() => {
        if (query.data) {
            dispatch(
                setElkWalkableEdges({
                    edges: query.data.edges,
                    etag: query.data.etag,
                }),
            );
        }
    }, [dispatch, query.data]);

    useEffect(() => {
        if (query.error) {
            dispatch(
                setElkWalkableLoadError(
                    query.error instanceof Error ? query.error.message : String(query.error),
                ),
            );
        }
    }, [dispatch, query.error]);

    return query;
}

/**
 * Submit hook: validates a draft from Redux and POSTs it to the backend.
 * On success: clears the draft, marks Redux with a success status, and
 * invalidates the elk-walkable query so the next render pulls the fresh
 * server state.
 */
export function useElkWalkableSubmit() {
    const dispatch = useAppDispatch();
    const queryClient = useQueryClient();
    const draftAttest = useAppSelector((s) => s.elkWalkable.pendingAttest);
    const draftUnattest = useAppSelector((s) => s.elkWalkable.pendingUnattest);

    return {
        canSubmit: draftAttest.length + draftUnattest.length > 0,
        async submit(note?: string) {
            if (draftAttest.length + draftUnattest.length === 0) return;
            const payload: ElkWalkableSubmitPayload = {
                attest: draftAttest.map((p) => ({ a: p.a, b: p.b })),
                unattest: draftUnattest.map((p) => ({ a: p.a, b: p.b })),
                note,
            };
            dispatch(setElkSubmitStatus({ kind: "submitting" }));
            try {
                const result = await submitElkWalkable(payload);
                dispatch(clearElkDraft());
                dispatch(
                    setElkSubmitStatus({
                        kind: "success",
                        changeId: result.change_id,
                        appliedCount: result.applied_count,
                        at: Date.now(),
                    }),
                );
                await queryClient.invalidateQueries({ queryKey: [...QUERY_KEY] });
            } catch (err) {
                dispatch(
                    setElkSubmitStatus({
                        kind: "error",
                        message: err instanceof Error ? err.message : String(err),
                        at: Date.now(),
                    }),
                );
                throw err;
            }
        },
    };
}
