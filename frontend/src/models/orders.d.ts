// Shared types for the community "Orders" marketplace (Market > Orders).
// Mirrors the backend serialization in `backend/app/core/orders_db.py`.

export type OrderSide = "buy" | "sell";
export type OrderStatus = "open" | "closed" | "fulfilled";
export type TraderMobility = "stationary" | "occasional" | "frequent";
/** How an order is priced & stocked: by individual item, by stack, or by crate
 *  (a crate holds a fixed 20 stacks). `unit_price` and `quantity` are expressed
 *  in terms of this unit. */
export type SellUnit = "unit" | "stack" | "crate";
export type LocationSource = "manual" | "landmark" | "favorite";
export type RequestStatus =
    | "pending"
    | "accepted"
    | "rejected"
    | "withdrawn"
    | "countered";
export type MessageKind = "offer" | "counter" | "message" | "accept" | "reject";
export type FillReason = "sell" | "buy" | "adjust";

export interface OrderLocation {
    source: LocationSource;
    x: number;
    z: number;
    label?: string | null;
    landmark_id?: string | null;
}

export interface Order {
    id: string;
    side: OrderSide;
    item_id: number;
    item_name: string;
    preview_text: string | null;
    notes: string | null;
    unit_price: number;
    quantity: number;
    quantity_remaining: number;
    /** Whether price/quantity are per item, per stack, or per crate. */
    sell_unit: SellUnit;
    /** Item stack size captured at post time; null for `sell_unit: "unit"`. */
    stack_size: number | null;
    status: OrderStatus;
    location: OrderLocation | null;
    mobility: TraderMobility | null;
    author_api_key_id: string | null;
    author: string | null;
    created_at: string | null;
    updated_at: string | null;
}

export interface NegotiationMessage {
    id: number;
    request_id: number;
    kind: MessageKind;
    proposed_quantity: number | null;
    proposed_unit_price: number | null;
    note: string | null;
    author_api_key_id: string | null;
    author: string | null;
    created_at: string | null;
}

export interface OrderRequest {
    id: number;
    order_id: string;
    quantity: number;
    proposed_unit_price: number | null;
    note: string | null;
    status: RequestStatus;
    requester_api_key_id: string | null;
    requester: string | null;
    created_at: string | null;
    updated_at: string | null;
    messages: NegotiationMessage[];
}

export interface OrderFill {
    id: number;
    order_id: string;
    quantity_reduced: number;
    reason: FillReason;
    unit_price: number | null;
    publish_analytics: boolean;
    reporter_api_key_id: string | null;
    created_at: string | null;
}

export interface OrderAnalytics {
    published: boolean;
    blocked: boolean;
    count: number;
    avg_price?: number | null;
    min_price?: number | null;
    max_price?: number | null;
    total_quantity?: number;
}

export interface OrderDetail extends Order {
    requests: OrderRequest[];
    fills: OrderFill[];
    analytics: OrderAnalytics;
}

export interface OrderListResult {
    orders: Order[];
    total: number;
}

export interface TraderProfile {
    default_location: OrderLocation | null;
    default_mobility: TraderMobility | null;
}

export type OrderSort = "newest" | "oldest" | "price_asc" | "price_desc";

export interface OrderFilters {
    side?: OrderSide;
    item_id?: number;
    q?: string;
    mobility?: TraderMobility;
    sort?: OrderSort;
    include_closed?: boolean;
    limit?: number;
    offset?: number;
}

export interface CreateOrderPayload {
    side: OrderSide;
    item_id: number;
    item_name: string;
    unit_price: number;
    quantity: number;
    preview_text?: string | null;
    notes?: string | null;
    location?: OrderLocation | null;
    mobility?: TraderMobility | null;
    sell_unit?: SellUnit;
    stack_size?: number | null;
    save_as_default?: boolean;
}
