// Order detail page: full order info, structured negotiation threads, owner
// controls (edit / close), and a per-order price analytics panel fed by
// accepted negotiations. Trades are attributed to the offerer, who can flag
// their own trade as false.

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, MapPin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { getMyAccountSafe } from "@/lib/api";
import { ordersApi, useInvalidateOrders, useMarkOrderSeen, useOrderDetail } from "@/lib/orders";
import {
  MOBILITY_LABELS,
  priceUnitLabel,
  SELL_UNIT_MANY,
  unitTotalHint,
} from "./orders/ordersShared";
import { EditOrderDialog } from "./orders/EditOrderDialog";
import { NegotiationThread } from "./orders/NegotiationThread";
import { OrderRequestDialog } from "./orders/OrderRequestDialog";
import { ReopenOrderDialog } from "./orders/ReopenOrderDialog";
import { OrderAnalyticsPanel } from "./orders/OrderAnaliticsPanel";
import { formatGears } from "@/lib/auction";

export function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: order, isPending, isError, featureDisabled } = useOrderDetail(id);
  const accountQuery = useQuery({ queryKey: ["account-me"], queryFn: getMyAccountSafe });
  const myId = accountQuery.data?.user?.api_key_id ?? null;
  const isAdmin = accountQuery.data?.is_admin ?? false;
  const isLoggedIn = Boolean(accountQuery.data?.user);
  const invalidate = useInvalidateOrders();
  const markOrderSeen = useMarkOrderSeen();

  const [requestOpen, setRequestOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Clear this order's unread dot once the user opens it.
  useEffect(() => {
    if (isLoggedIn && id) markOrderSeen.mutate(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, id]);

  const close = useMutation({
    mutationFn: () => ordersApi.close(id!),
    onSuccess: invalidate,
  });

  const del = useMutation({
    mutationFn: () => ordersApi.remove(id!),
    onSuccess: () => {
      invalidate();
      navigate("/market/orders");
    },
  });

  if (featureDisabled) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        The Orders marketplace is not currently available.
      </div>
    );
  }
  if (isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Spinner /> Loading order…
      </div>
    );
  }
  if (isError || !order) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">This order could not be found.</p>
        <Link to="/market/orders" className="mt-2 inline-block underline">
          Back to orders
        </Link>
      </div>
    );
  }

  const isOwner = order.author_api_key_id != null && order.author_api_key_id === myId;
  const isSell = order.side === "sell";
  const sideLabel = isSell ? "Selling" : "Looking to buy";
  const isOpen = order.status === "open";

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        to="/market/orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All orders
      </Link>

      <Card className="space-y-3 px-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Badge
                className={
                  isSell
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                }
              >
                {sideLabel}
              </Badge>
              {order.status === "closed" && <Badge variant="outline">Closed</Badge>}
              {order.status === "fulfilled" && <Badge variant="outline">Fulfilled</Badge>}
            </div>
            <h1 className="mt-1 text-2xl font-semibold">{order.item_name}</h1>
            {order.author && <p className="text-sm text-muted-foreground">by {order.author}</p>}
          </div>
          <div className="rounded-lg bg-muted/50 px-4 py-2 text-right">
            <div className="text-2xl font-semibold leading-tight">
              {formatGears(order.unit_price)}
            </div>
            <div className="text-xs text-muted-foreground">{priceUnitLabel(order)}</div>
          </div>
        </div>

        {order.preview_text && <p className="text-sm">{order.preview_text}</p>}
        {order.notes && (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{order.notes}</p>
        )}

        <div className="grid gap-x-6 gap-y-2 border-t border-border/60 pt-3 text-sm sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">Remaining: </span>
            {order.quantity_remaining} / {order.quantity}{" "}
            {order.sell_unit === "unit" ? "units" : `${order.sell_unit}s`}{" "}
            <span className="text-muted-foreground">
              {unitTotalHint(order.quantity_remaining, order)}
            </span>
          </div>
          {order.mobility && (
            <div>
              <span className="text-muted-foreground">Availability: </span>
              {MOBILITY_LABELS[order.mobility]}
            </div>
          )}
          {order.location && (
            <Link
              to={`/multiplayer/tops-map?x=${order.location.x}&z=${order.location.z}&zoom=2`}
              className="inline-flex w-fit items-center gap-1 hover:text-foreground hover:underline"
              title="View this location on the TOPS map"
            >
              <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />
              {order.location.label || `${order.location.x}, ${order.location.z}`}
            </Link>
          )}
        </div>

        {(order.created_at || order.updated_at) && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            {order.created_at && (
              <span>
                Posted{" "}
                <time
                  dateTime={order.created_at}
                  title={new Date(order.created_at).toLocaleString()}
                >
                  {new Date(order.created_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </time>
              </span>
            )}
            {order.updated_at && order.updated_at !== order.created_at && (
              <span>
                · Updated{" "}
                <time
                  dateTime={order.updated_at}
                  title={new Date(order.updated_at).toLocaleString()}
                >
                  {new Date(order.updated_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </time>
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
          {isOwner ? (
            <>
              {isOpen && (
                <>
                  <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => close.mutate()}
                    disabled={close.isPending}
                  >
                    {close.isPending ? <Spinner /> : null}
                    Close order
                  </Button>
                </>
              )}
              {!isOpen && (
                <Button size="sm" onClick={() => setReopenOpen(true)}>
                  Reopen order
                </Button>
              )}
            </>
          ) : (
            isOpen &&
            isLoggedIn && (
              <Button size="sm" onClick={() => setRequestOpen(true)}>
                {isSell ? "Request to buy" : "Offer to sell"}
              </Button>
            )
          )}
          {!isLoggedIn && isOpen && (
            <p className="text-sm text-muted-foreground">
              <Link to="/account" className="underline">
                Sign in
              </Link>{" "}
              to send a request or negotiate.
            </p>
          )}
          {(isOwner || isAdmin) && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={del.isPending}
            >
              {del.isPending ? <Spinner /> : null}
              {isOwner ? "Delete" : "Delete (admin)"}
            </Button>
          )}
        </div>
      </Card>

      <OrderAnalyticsPanel
        analytics={order.analytics}
        blockedBy={order.author ?? "the seller"}
        unitLabel={SELL_UNIT_MANY[order.sell_unit]}
        fills={order.fills}
        sellUnit={order.sell_unit}
        myId={myId}
      />

      {/* Requests / negotiations. Non-owners only see their own threads. */}
      {order.requests.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{isOwner ? "Requests" : "Your requests"}</h2>
          {order.requests.map((req) => (
            <NegotiationThread key={req.id} order={order} request={req} myId={myId} />
          ))}
        </div>
      )}

      <OrderRequestDialog order={order} open={requestOpen} onOpenChange={setRequestOpen} />
      <EditOrderDialog order={order} open={editOpen} onOpenChange={setEditOpen} />
      <ReopenOrderDialog order={order} open={reopenOpen} onOpenChange={setReopenOpen} />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this order?"
        description={
          isOwner
            ? "This permanently removes your order and its entire negotiation history. This cannot be undone."
            : "As an admin, this permanently removes this order and its entire negotiation history. This cannot be undone."
        }
        confirmLabel="Delete"
        variant="destructive"
        loading={del.isPending}
        onConfirm={() => del.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
