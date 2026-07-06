// Owner-only dialog to re-open a closed or fulfilled order, optionally adding
// stock. A fulfilled order (0 remaining) must be restocked with at least one
// unit; a closed order with stock left can simply be reopened.

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
import { formatQtyInUnit, SELL_UNIT_MANY } from "./ordersShared";

interface ReopenOrderDialogProps {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReopenOrderDialog({ order, open, onOpenChange }: ReopenOrderDialogProps) {
  const invalidate = useInvalidateOrders();
  const remaining = order.quantity_remaining;
  // A fulfilled order has no stock left, so pre-fill the previous total as a
  // sensible restock default; a closed order that still has stock defaults to 0.
  const [add, setAdd] = useState(remaining < 1 ? String(order.quantity) : "0");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (addQuantity: number) => ordersApi.reopen(order.id, addQuantity),
    onSuccess: () => {
      invalidate();
      setError(null);
      onOpenChange(false);
    },
    onError: (e) =>
      setError(e instanceof ApiError ? String(e.detail ?? e.message) : "Failed to reopen order"),
  });

  const parsed = Number.parseInt(add, 10);
  const addQty = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  const newRemaining = remaining + addQty;

  const submit = () => {
    setError(null);
    if (add.trim() !== "" && (!Number.isInteger(parsed) || parsed < 0)) {
      setError("Enter a valid amount to add (≥ 0).");
      return;
    }
    if (newRemaining < 1) {
      setError("Add at least one unit of stock to reopen this order.");
      return;
    }
    mutation.mutate(addQty);
  };

  const unitMany = SELL_UNIT_MANY[order.sell_unit];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen order</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {order.item_name} · {formatQtyInUnit(remaining, order)} left in stock.
          </p>
          <div className="space-y-1">
            <Label htmlFor="reopen-add">Add stock ({unitMany})</Label>
            <Input
              id="reopen-add"
              type="number"
              min="0"
              step="1"
              value={add}
              onChange={(e) => setAdd(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Order will reopen with {formatQtyInUnit(newRemaining, order)} available.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            Reopen order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
