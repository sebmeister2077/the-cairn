// Owner-only dialog for logging a completed (or adjusted) trade against an
// order. Decrements remaining quantity and optionally publishes the sale price
// for community price analytics.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatGears } from "@/lib/auction";
import { ordersApi, useInvalidateOrders } from "@/lib/orders";
import type { FillReason, Order } from "@/models/orders";
import { priceUnitLabel, SELL_UNIT_MANY } from "./ordersShared";

interface TradeFillDialogProps {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TradeFillDialog({ order, open, onOpenChange }: TradeFillDialogProps) {
  const invalidate = useInvalidateOrders();

  // The reason is implied by the order side: a sell order's trades are sales,
  // a buy order's trades are purchases.
  const reason: FillReason = order.side === "sell" ? "sell" : "buy";

  const [quantity, setQuantity] = useState("1");
  // The user enters the *total* price for the whole trade; we store per-unit.
  const [price, setPrice] = useState(String(order.unit_price));
  const [priceEdited, setPriceEdited] = useState(false);
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleQuantityChange = (value: string) => {
    setQuantity(value);
    // Keep the suggested total in sync with quantity until the user edits it.
    if (!priceEdited) {
      const q = Number.parseInt(value, 10);
      setPrice(Number.isInteger(q) && q > 0 ? String(order.unit_price * q) : "");
    }
  };

  const handlePriceChange = (value: string) => {
    setPrice(value);
    setPriceEdited(true);
  };

  const mutation = useMutation({
    mutationFn: (payload: {
      quantity_reduced: number;
      reason: FillReason;
      unit_price?: number | null;
      publish_analytics: boolean;
    }) => ordersApi.addFill(order.id, payload),
    onSuccess: () => {
      invalidate();
      setError(null);
      onOpenChange(false);
    },
    onError: (e) =>
      setError(e instanceof ApiError ? String(e.detail ?? e.message) : "Failed to record trade"),
  });

  const submit = () => {
    setError(null);
    const qty = Number.parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      setError("Enter a valid quantity (≥ 1).");
      return;
    }
    if (qty > order.quantity_remaining) {
      setError(`Only ${order.quantity_remaining} ${SELL_UNIT_MANY[order.sell_unit]} remaining.`);
      return;
    }
    const total = price.trim() ? Number.parseFloat(price) : null;
    if (total != null && (!Number.isFinite(total) || total <= 0)) {
      setError("Price must be greater than 0.");
      return;
    }
    mutation.mutate({
      quantity_reduced: qty,
      reason,
      // Store the per-unit price so analytics stays comparable across trades.
      unit_price: total != null ? total / qty : null,
      publish_analytics: publish,
    });
  };

  const qtyNum = Number.parseInt(quantity, 10);
  const totalNum = Number.parseFloat(price);
  // Show the per-unit breakdown only when trading more than one unit.
  const perUnitPreview =
    Number.isInteger(qtyNum) && qtyNum > 1 && Number.isFinite(totalNum) && totalNum > 0
      ? totalNum / qtyNum
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record a trade</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {order.quantity_remaining} of {order.quantity} {SELL_UNIT_MANY[order.sell_unit]}{" "}
            remaining.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="fill-qty">Quantity traded ({SELL_UNIT_MANY[order.sell_unit]})</Label>
              <Input
                id="fill-qty"
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => handleQuantityChange(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fill-price">Total price (⚙)</Label>
              <Input
                id="fill-price"
                type="number"
                min="0"
                step="1"
                value={price}
                onChange={(e) => handlePriceChange(e.target.value)}
              />
            </div>
          </div>
          {perUnitPreview != null && (
            <p className="text-xs text-muted-foreground">
              ≈ {formatGears(perUnitPreview)} {priceUnitLabel(order)}
            </p>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={publish} onCheckedChange={(v) => setPublish(Boolean(v))} />
            <span>
              Publish this price for community analytics. Unchecking blocks price analytics for this
              order.
            </span>
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            Record trade
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
