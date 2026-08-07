// Data access for the community "Orders" marketplace (Market > Orders).
//
// Thin API client + TanStack Query hooks over the FastAPI `/orders` endpoints.
// The backend returns 404 for every endpoint when the `orders_enabled` feature
// flag is OFF, so the browse hook exposes a `featureDisabled` flag (derived
// from a 404) that callers use to render an "unavailable" state instead of a
// scary error — matching the Groupings Library convention.

import {
    useMutation,
    useQuery,
    useQueryClient,
    type UseQueryResult,
} from "@tanstack/react-query";

import { API_BASE, ApiError, authHeaders, handleResponse } from "@/lib/api";
import type {
    CreateOrderPayload,
    MessageKind,
    Order,
    OrderDetail,
    OrderFilters,
    OrderListResult,
    OrderLocation,
    OrderRequest,
    TraderMobility,
    TraderProfile,
} from "@/models/orders";

export const ORDERS_KEY = ["orders"] as const;

function isNotFound(err: unknown): boolean {
    return err instanceof ApiError && err.status === 404;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${API_BASE}/orders${path}`, {
        headers: authHeaders(),
        signal,
    });
    return (await handleResponse(res)).json();
}

async function sendJson<T>(
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
): Promise<T> {
    const res = await fetch(`${API_BASE}/orders${path}`, {
        method,
        headers: authHeaders(
            body !== undefined ? { "Content-Type": "application/json" } : undefined,
        ),
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return (await handleResponse(res)).json();
}

// --------------------------------------------------------------------------- //
// API client
// --------------------------------------------------------------------------- //

function buildQuery(filters: OrderFilters): string {
    const p = new URLSearchParams();
    if (filters.side) p.set("side", filters.side);
    if (filters.item_id != null) p.set("item_id", String(filters.item_id));
    if (filters.q) p.set("q", filters.q);
    if (filters.mobility) p.set("mobility", filters.mobility);
    if (filters.sort) p.set("sort", filters.sort);
    if (filters.include_closed) p.set("include_closed", "true");
    if (filters.limit != null) p.set("limit", String(filters.limit));
    if (filters.offset != null) p.set("offset", String(filters.offset));
    const s = p.toString();
    return s ? `?${s}` : "";
}

export const ordersApi = {
    list: (filters: OrderFilters, signal?: AbortSignal) =>
        getJson<OrderListResult>(buildQuery(filters), signal),
    get: (id: string, signal?: AbortSignal) =>
        getJson<OrderDetail>(`/${encodeURIComponent(id)}`, signal),
    create: (payload: CreateOrderPayload) =>
        sendJson<Order>("", "POST", payload),
    update: (id: string, payload: Partial<CreateOrderPayload> & { clear_location?: boolean }) =>
        sendJson<Order>(`/${encodeURIComponent(id)}`, "PATCH", payload),
    close: (id: string) => sendJson<{ ok: boolean }>(`/${encodeURIComponent(id)}/close`, "POST"),
    remove: (id: string) => sendJson<{ ok: boolean }>(`/${encodeURIComponent(id)}`, "DELETE"),
    reopen: (id: string, addQuantity: number) =>
        sendJson<Order>(`/${encodeURIComponent(id)}/reopen`, "POST", { add_quantity: addQuantity }),
    createRequest: (
        id: string,
        payload: { quantity: number; proposed_unit_price?: number | null; note?: string | null },
    ) => sendJson<OrderRequest>(`/${encodeURIComponent(id)}/requests`, "POST", payload),
    postMessage: (
        requestId: number,
        payload: {
            kind: MessageKind;
            proposed_quantity?: number | null;
            proposed_unit_price?: number | null;
            note?: string | null;
        },
    ) => sendJson<OrderRequest>(`/requests/${requestId}/messages`, "POST", payload),
    acceptRequest: (requestId: number) =>
        sendJson<OrderRequest>(`/requests/${requestId}/accept`, "POST"),
    rejectRequest: (requestId: number) =>
        sendJson<OrderRequest>(`/requests/${requestId}/reject`, "POST"),
    withdrawRequest: (requestId: number) =>
        sendJson<OrderRequest>(`/requests/${requestId}/withdraw`, "POST"),
    flagFill: (fillId: number, flagged: boolean) =>
        sendJson<OrderDetail>(`/fills/${fillId}/flag`, "POST", { flagged }),
    profile: (signal?: AbortSignal) => getJson<TraderProfile>("/profile", signal),
    setProfile: (payload: {
        location?: OrderLocation | null;
        clear_location?: boolean;
        mobility?: TraderMobility | null;
    }) => sendJson<TraderProfile>("/profile", "PUT", payload),
    notificationsCount: (signal?: AbortSignal) =>
        getJson<{ unread: number }>("/notifications/count", signal),
    unreadOrders: (signal?: AbortSignal) =>
        getJson<{ order_ids: string[] }>("/notifications/orders", signal),
    markSeen: () => sendJson<{ ok: boolean }>("/notifications/seen", "POST"),
    markOrderSeen: (id: string) =>
        sendJson<{ ok: boolean }>(`/${encodeURIComponent(id)}/seen`, "POST"),
};

// --------------------------------------------------------------------------- //
// Query hooks
// --------------------------------------------------------------------------- //

export function useOrdersList(
    filters: OrderFilters,
    enabled = true,
): UseQueryResult<OrderListResult> & { featureDisabled: boolean } {
    const query = useQuery<OrderListResult>({
        queryKey: [...ORDERS_KEY, "list", filters],
        queryFn: ({ signal }) => ordersApi.list(filters, signal),
        enabled,
        retry: (count, err) => !isNotFound(err) && count < 2,
        staleTime: 15_000,
    });
    return { ...query, featureDisabled: isNotFound(query.error) };
}

export function useOrderDetail(
    id: string | undefined,
): UseQueryResult<OrderDetail> & { featureDisabled: boolean } {
    const query = useQuery<OrderDetail>({
        queryKey: [...ORDERS_KEY, "detail", id],
        queryFn: ({ signal }) => ordersApi.get(id!, signal),
        enabled: Boolean(id),
        retry: (count, err) => !isNotFound(err) && count < 2,
        staleTime: 5_000,
    });
    return { ...query, featureDisabled: isNotFound(query.error) };
}

export function useTraderProfile(enabled = true): UseQueryResult<TraderProfile> {
    return useQuery<TraderProfile>({
        queryKey: [...ORDERS_KEY, "profile"],
        queryFn: ({ signal }) => ordersApi.profile(signal),
        enabled,
        retry: (count, err) => !isNotFound(err) && count < 2,
        staleTime: 60_000,
    });
}

/** Unread-activity count that drives the dot on the Orders nav button. Only
 *  runs when the caller is signed in; a 404 (feature off) yields 0. */
export function useOrdersUnread(enabled = true): number {
    const query = useQuery<number>({
        queryKey: [...ORDERS_KEY, "unread"],
        queryFn: async ({ signal }) => {
            try {
                const { unread } = await ordersApi.notificationsCount(signal);
                return unread;
            } catch (err) {
                // Feature off (404) or no account / unauthenticated (401/403):
                // treat as "nothing to show" rather than surfacing an error.
                if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
                    return 0;
                }
                throw err;
            }
        },
        enabled,
        retry: (count, err) => !isNotFound(err) && count < 2,
        staleTime: 30_000,
        refetchInterval: 60_000,
        refetchOnWindowFocus: true,
    });
    return query.data ?? 0;
}

/** Set of order IDs with unseen activity for the caller, used to dot the
 *  specific orders in the list/detail. Empty set while signed-out or off. */
export function useOrdersUnreadIds(enabled = true): Set<string> {
    const query = useQuery<string[]>({
        queryKey: [...ORDERS_KEY, "unread", "ids"],
        queryFn: async ({ signal }) => {
            try {
                const { order_ids } = await ordersApi.unreadOrders(signal);
                return order_ids;
            } catch (err) {
                if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
                    return [];
                }
                throw err;
            }
        },
        enabled,
        retry: (count, err) => !isNotFound(err) && count < 2,
        staleTime: 30_000,
        refetchInterval: 60_000,
        refetchOnWindowFocus: true,
    });
    return new Set(query.data ?? []);
}

// --------------------------------------------------------------------------- //
// Mutation hooks
// --------------------------------------------------------------------------- //

/** Invalidate every orders query after a write so lists/detail/unread refresh. */
export function useInvalidateOrders() {
    const qc = useQueryClient();
    return () => qc.invalidateQueries({ queryKey: ORDERS_KEY });
}

export function useCreateOrder() {
    const invalidate = useInvalidateOrders();
    return useMutation({
        mutationFn: (payload: CreateOrderPayload) => ordersApi.create(payload),
        onSuccess: invalidate,
    });
}

export function useMarkOrdersSeen() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: () => ordersApi.markSeen(),
        onSuccess: () => qc.invalidateQueries({ queryKey: [...ORDERS_KEY, "unread"] }),
    });
}

/** Clear the unread marker for a single order (called when its detail opens). */
export function useMarkOrderSeen() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => ordersApi.markOrderSeen(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: [...ORDERS_KEY, "unread"] }),
    });
}
