// Structured negotiation thread for a single order request. Both parties can
// post messages or counter-offers (a new quantity/price); the order owner can
// accept or reject, and the requester can withdraw.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import { ordersApi, useInvalidateOrders } from "@/lib/orders";
import type { MessageKind, NegotiationMessage, Order, OrderRequest } from "@/models/orders";

interface NegotiationThreadProps {
  order: Order;
  request: OrderRequest;
  myId: string | null;
}

const STATUS_LABELS: Record<OrderRequest["status"], string> = {
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  countered: "Counter-offer",
};

const STATUS_CLASS: Record<OrderRequest["status"], string> = {
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  accepted: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  rejected: "bg-destructive/15 text-destructive",
  withdrawn: "bg-muted text-muted-foreground",
  countered: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
};

function MessageRow({ msg, myId }: { msg: NegotiationMessage; myId: string | null }) {
  const mine = msg.author_api_key_id != null && msg.author_api_key_id === myId;
  return (
    <div
      className={`rounded-md border px-2.5 py-1.5 text-sm ${mine ? "bg-primary/5" : "bg-muted/40"}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{msg.author ?? "Unknown"}</span>
        {msg.kind === "counter" && <Badge variant="outline">Counter</Badge>}
        {msg.kind === "accept" && <Badge variant="outline">Accept</Badge>}
        {msg.kind === "reject" && <Badge variant="outline">Reject</Badge>}
        {(msg.proposed_quantity != null || msg.proposed_unit_price != null) && (
          <span className="text-xs text-muted-foreground">
            {msg.proposed_quantity != null && `${msg.proposed_quantity}×`}
            {msg.proposed_unit_price != null && ` @ ${msg.proposed_unit_price} ⚙`}
          </span>
        )}
        {msg.created_at && (
          <span className="ml-auto text-xs text-muted-foreground">
            {new Date(msg.created_at).toLocaleString()}
          </span>
        )}
      </div>
      {msg.note && <p className="mt-0.5 whitespace-pre-wrap">{msg.note}</p>}
    </div>
  );
}

export function NegotiationThread({ order, request, myId }: NegotiationThreadProps) {
  const invalidate = useInvalidateOrders();
  const isOwner = order.author_api_key_id != null && order.author_api_key_id === myId;
  const isRequester = request.requester_api_key_id != null && request.requester_api_key_id === myId;
  const isParty = isOwner || isRequester;
  const active = request.status === "pending" || request.status === "countered";
  const orderOpen = order.status !== "closed";

  const [note, setNote] = useState("");
  const [counterQty, setCounterQty] = useState("");
  const [counterPrice, setCounterPrice] = useState("");
  const [showCounter, setShowCounter] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = useMutation({
    mutationFn: (payload: {
      kind: MessageKind;
      proposed_quantity?: number | null;
      proposed_unit_price?: number | null;
      note?: string | null;
    }) => ordersApi.postMessage(request.id, payload),
    onSuccess: () => {
      invalidate();
      setNote("");
      setCounterQty("");
      setCounterPrice("");
      setShowCounter(false);
      setError(null);
    },
    onError: (e) =>
      setError(e instanceof ApiError ? String(e.detail ?? e.message) : "Failed to post"),
  });

  const decide = useMutation({
    mutationFn: (action: "accept" | "reject" | "withdraw") =>
      action === "accept"
        ? ordersApi.acceptRequest(request.id)
        : action === "reject"
          ? ordersApi.rejectRequest(request.id)
          : ordersApi.withdrawRequest(request.id),
    onSuccess: () => {
      invalidate();
      setError(null);
    },
    onError: (e) =>
      setError(e instanceof ApiError ? String(e.detail ?? e.message) : "Failed to update request"),
  });

  const busy = post.isPending || decide.isPending;

  const sendMessage = () => {
    if (!note.trim()) return;
    post.mutate({ kind: "message", note: note.trim() });
  };

  const sendCounter = () => {
    setError(null);
    const qty = counterQty.trim() ? Number.parseInt(counterQty, 10) : null;
    const price = counterPrice.trim() ? Number.parseFloat(counterPrice) : null;
    if (qty == null && price == null && !note.trim()) {
      setError("Add a new quantity, price, or note for your counter.");
      return;
    }
    if (qty != null && (!Number.isInteger(qty) || qty < 1)) {
      setError("Counter quantity must be ≥ 1.");
      return;
    }
    if (price != null && (!Number.isFinite(price) || price <= 0)) {
      setError("Counter price must be greater than 0.");
      return;
    }
    post.mutate({
      kind: "counter",
      proposed_quantity: qty,
      proposed_unit_price: price,
      note: note.trim() || null,
    });
  };

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{request.requester ?? "Unknown"}</span>
          <Badge className={STATUS_CLASS[request.status]}>{STATUS_LABELS[request.status]}</Badge>
        </div>
        <span className="text-sm text-muted-foreground">
          {request.quantity}×
          {request.proposed_unit_price != null
            ? ` @ ${request.proposed_unit_price} ⚙`
            : ` @ ${order.unit_price} ⚙`}
        </span>
      </div>

      {request.note && <p className="mt-1 whitespace-pre-wrap text-sm">{request.note}</p>}

      {request.messages.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {request.messages.map((m) => (
            <MessageRow key={m.id} msg={m} myId={myId} />
          ))}
        </div>
      )}

      {isParty && active && orderOpen && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Write a message…"
          />
          {showCounter && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                min="1"
                step="1"
                value={counterQty}
                onChange={(e) => setCounterQty(e.target.value)}
                placeholder={`Qty (${request.quantity})`}
              />
              <Input
                type="number"
                min="0"
                step="1"
                value={counterPrice}
                onChange={(e) => setCounterPrice(e.target.value)}
                placeholder={`Price (${request.proposed_unit_price ?? order.unit_price})`}
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={sendMessage}
              disabled={busy || !note.trim()}
            >
              Send message
            </Button>
            {showCounter ? (
              <Button size="sm" onClick={sendCounter} disabled={busy}>
                {busy ? <Spinner /> : null}
                Submit counter
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowCounter(true)}
                disabled={busy}
              >
                Counter-offer
              </Button>
            )}
            {isOwner && (
              <>
                <Button size="sm" onClick={() => decide.mutate("accept")} disabled={busy}>
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => decide.mutate("reject")}
                  disabled={busy}
                >
                  Reject
                </Button>
              </>
            )}
            {isRequester && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => decide.mutate("withdraw")}
                disabled={busy}
              >
                Withdraw
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
