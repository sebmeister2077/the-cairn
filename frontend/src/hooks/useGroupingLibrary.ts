// Community Groupings Library data hooks.
//
// Thin TanStack Query wrappers over the `groupingLibrary` client in
// [lib/api.ts]. The backend returns 404 for every endpoint when the
// `grouping_library_enabled` feature flag is OFF, so the browse hook exposes a
// `featureDisabled` flag (derived from a 404) that callers use to hide the UI
// rather than surfacing a scary error.

import { useCallback, useMemo } from "react";
import {
    useMutation,
    useQuery,
    useQueryClient,
    type UseQueryResult,
} from "@tanstack/react-query";

import {
    adminGroupingLibrary,
    ApiError,
    groupingLibrary,
    type EditGroupingPayload,
    type GroupingLibrarySort,
    type LibraryBrowseResult,
    type LibraryGroupingCard,
    type LibrarySubscription,
    type PublishGroupingPayload,
} from "@/lib/api";
import { useAppSelector } from "@/store/hooks";

export const GROUPING_LIBRARY_KEY = ["grouping-library"] as const;

export interface BrowseParams {
    q?: string;
    tag?: string;
    sort?: GroupingLibrarySort;
    officialOnly?: boolean;
    page?: number;
    pageSize?: number;
}

function isNotFound(err: unknown): boolean {
    return err instanceof ApiError && err.status === 404;
}

/**
 * Browse the public library. Returns the standard query plus a
 * `featureDisabled` flag so the UI can render an "unavailable" state when the
 * backend feature flag is off (signalled by a 404).
 */
export function useGroupingLibraryBrowse(
    params: BrowseParams,
    enabled = true,
): UseQueryResult<LibraryBrowseResult> & { featureDisabled: boolean } {
    const query = useQuery<LibraryBrowseResult>({
        queryKey: [...GROUPING_LIBRARY_KEY, "browse", params],
        queryFn: ({ signal }) => groupingLibrary.browse(params, signal),
        enabled,
        // A 404 means "feature off" — don't hammer it with retries.
        retry: (count, err) => !isNotFound(err) && count < 2,
        staleTime: 30_000,
    });
    return { ...query, featureDisabled: isNotFound(query.error) };
}

/** The current user's published groupings. */
export function useMyGroupings(enabled = true): UseQueryResult<LibraryGroupingCard[]> {
    return useQuery<LibraryGroupingCard[]>({
        queryKey: [...GROUPING_LIBRARY_KEY, "mine"],
        queryFn: async ({ signal }) => (await groupingLibrary.mine(signal)).items,
        enabled,
        retry: (count, err) => !isNotFound(err) && count < 2,
    });
}

/** The current user's subscriptions, with upstream-update detection. */
export function useGroupingSubscriptions(enabled = true): UseQueryResult<LibrarySubscription[]> {
    return useQuery<LibrarySubscription[]>({
        queryKey: [...GROUPING_LIBRARY_KEY, "subscriptions"],
        queryFn: async ({ signal }) => (await groupingLibrary.subscriptions(signal)).items,
        enabled,
        retry: (count, err) => !isNotFound(err) && count < 2,
        staleTime: 60_000,
    });
}

/**
 * Mutations for the library. Each invalidates the relevant query keys so the
 * browse list / subscription badges refresh after a write. Returns thin async
 * wrappers (not the raw mutation objects) so callers can `await` them.
 */
export function useGroupingLibraryActions() {
    const qc = useQueryClient();

    const invalidateAll = useCallback(() => {
        void qc.invalidateQueries({ queryKey: GROUPING_LIBRARY_KEY });
    }, [qc]);

    const publish = useMutation({
        mutationFn: (payload: PublishGroupingPayload) => groupingLibrary.publish(payload),
        onSuccess: invalidateAll,
    });
    const edit = useMutation({
        mutationFn: ({ id, payload }: { id: string; payload: EditGroupingPayload }) =>
            groupingLibrary.edit(id, payload),
        onSuccess: invalidateAll,
    });
    const unpublish = useMutation({
        mutationFn: (id: string) => groupingLibrary.unpublish(id),
        onSuccess: invalidateAll,
    });
    const upvote = useMutation({
        mutationFn: ({ id, on }: { id: string; on: boolean }) =>
            on ? groupingLibrary.upvote(id) : groupingLibrary.removeUpvote(id),
        onSuccess: invalidateAll,
    });
    const install = useMutation({
        mutationFn: ({ id, mode, version }: { id: string; mode: "fork" | "subscribe"; version?: number }) =>
            groupingLibrary.install(id, mode, version),
        onSuccess: invalidateAll,
    });
    const uninstall = useMutation({
        mutationFn: (id: string) => groupingLibrary.uninstall(id),
        onSuccess: invalidateAll,
    });
    const report = useMutation({
        mutationFn: ({ id, reason, details }: { id: string; reason: string; details?: string }) =>
            groupingLibrary.report(id, reason, details),
    });

    // Admin moderation, surfaced here so the browse list refreshes after a
    // takedown / official toggle. Callers must gate these behind `isAdmin`.
    const adminRemove = useMutation({
        mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
            adminGroupingLibrary.remove(id, reason),
        onSuccess: invalidateAll,
    });
    const adminSetOfficial = useMutation({
        mutationFn: ({ id, official }: { id: string; official: boolean }) =>
            adminGroupingLibrary.setOfficial(id, official),
        onSuccess: invalidateAll,
    });

    return useMemo(
        () => ({
            publish: (payload: PublishGroupingPayload) => publish.mutateAsync(payload),
            edit: (id: string, payload: EditGroupingPayload) => edit.mutateAsync({ id, payload }),
            unpublish: (id: string) => unpublish.mutateAsync(id),
            setUpvote: (id: string, on: boolean) => upvote.mutateAsync({ id, on }),
            install: (id: string, mode: "fork" | "subscribe", version?: number) =>
                install.mutateAsync({ id, mode, version }),
            uninstall: (id: string) => uninstall.mutateAsync(id),
            report: (id: string, reason: string, details?: string) =>
                report.mutateAsync({ id, reason, details }),
            adminRemove: (id: string, reason?: string) => adminRemove.mutateAsync({ id, reason }),
            adminSetOfficial: (id: string, official: boolean) =>
                adminSetOfficial.mutateAsync({ id, official }),
            invalidateAll,
            isPublishing: publish.isPending,
            isEditing: edit.isPending,
        }),
        [publish, edit, unpublish, upvote, install, uninstall, report, adminRemove, adminSetOfficial, invalidateAll],
    );
}

/** Admin-only: open reports queue + moderation actions. */
export function useAdminGroupingReports(enabled = true) {
    const isAdmin = useAppSelector((s) => s.auth.isAdmin);
    const qc = useQueryClient();
    const query = useQuery({
        queryKey: [...GROUPING_LIBRARY_KEY, "admin", "reports"],
        queryFn: async ({ signal }) => (await adminGroupingLibrary.reports(signal)).items,
        enabled: enabled && isAdmin,
    });

    const invalidate = useCallback(() => {
        void qc.invalidateQueries({ queryKey: [...GROUPING_LIBRARY_KEY, "admin", "reports"] });
        void qc.invalidateQueries({ queryKey: ["admin", "pending-counts"] });
    }, [qc]);

    const remove = useMutation({
        mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
            adminGroupingLibrary.remove(id, reason),
        onSuccess: invalidate,
    });
    const setOfficial = useMutation({
        mutationFn: ({ id, official }: { id: string; official: boolean }) =>
            adminGroupingLibrary.setOfficial(id, official),
        onSuccess: invalidate,
    });
    const resolve = useMutation({
        mutationFn: ({ reportId, dismiss }: { reportId: number; dismiss: boolean }) =>
            adminGroupingLibrary.resolveReport(reportId, dismiss),
        onSuccess: invalidate,
    });

    return {
        reports: query.data ?? [],
        isLoading: query.isLoading,
        error: query.error,
        remove: (id: string, reason?: string) => remove.mutateAsync({ id, reason }),
        setOfficial: (id: string, official: boolean) => setOfficial.mutateAsync({ id, official }),
        resolveReport: (reportId: number, dismiss: boolean) => resolve.mutateAsync({ reportId, dismiss }),
    };
}
