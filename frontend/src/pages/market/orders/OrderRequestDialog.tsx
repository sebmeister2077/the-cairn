// Dialog for a non-owner to send a buy/sell request against an order,
// optionally proposing a different unit price to open a negotiation.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import { ordersApi, useInvalidateOrders } from "@/lib/orders";
import type { Order } from "@/models/orders";
import { priceUnitLabel, SELL_UNIT_MANY, SELL_UNIT_ONE } from "./ordersShared";

interface OrderRequestDialogProps {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OrderRequestDialog({ order, open, onOpenChange }: OrderRequestDialogProps) {
  const invalidate = useInvalidateOrders();
  const isSell = order.side === "sell";

  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (payload: {
      quantity: number;
      proposed_unit_price?: number | null;
      note?: string | null;
    }) => ordersApi.createRequest(order.id, payload),
    onSuccess: () => {
      invalidate();
      setQuantity("1");
      setPrice("");
      setNote("");
      setError(null);
      onOpenChange(false);
    },
    onError: (e) =>
      setError(e instanceof ApiError ? String(e.detail ?? e.message) : "Failed to send request"),
  });

  const submit = () => {
    setError(null);
    const qty = Number.parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      setError("Enter a valid quantity (≥ 1).");
      return;
    }
    // The user enters a *total* price for the whole request; the backend stores
    // a per-unit price, so divide by the quantity before sending.
    const total = price.trim() ? Number.parseFloat(price) : null;
    if (total != null && (!Number.isFinite(total) || total <= 0)) {
      setError("Total price must be greater than 0.");
      return;
    }
    const proposed = total != null ? total / qty : null;
    mutation.mutate({ quantity: qty, proposed_unit_price: proposed, note: note.trim() || null });
  };

  // Default total shown as the placeholder: listed unit price × requested qty.
  const parsedQty = Number.parseInt(quantity, 10);
  const effectiveQty = Number.isInteger(parsedQty) && parsedQty >= 1 ? parsedQty : 1;
  const listedTotal = order.unit_price * effectiveQty;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isSell ? "Request to buy" : "Offer to sell"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {order.item_name} · listed at {order.unit_price} ⚙ {priceUnitLabel(order)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="req-qty">Quantity ({SELL_UNIT_MANY[order.sell_unit]})</Label>
              <Input
                id="req-qty"
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="req-price">Total price (optional)</Label>
              <Input
                id="req-price"
                type="number"
                min="1"
                step="1"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder={String(listedTotal)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            This is the <span className="font-medium">total</span> price for all {effectiveQty}{" "}
            {SELL_UNIT_MANY[order.sell_unit]} — not the price per{" "}
            {SELL_UNIT_ONE[order.sell_unit]}.
          </p>
          <div className="space-y-1">
            <Label htmlFor="req-note">Note (optional)</Label>
            <textarea
              id="req-note"
              value={note}
              maxLength={200}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder="Anything the other trader should know…"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
