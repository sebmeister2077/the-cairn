// Owner-only dialog to edit an existing order's price, quantity, text,
// location and availability.

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import { ordersApi, useInvalidateOrders } from "@/lib/orders";
import type { CreateOrderPayload, Order, OrderLocation, TraderMobility } from "@/models/orders";
import { MOBILITY_LABELS, priceUnitLabel, SELL_UNIT_MANY } from "./ordersShared";
import { TraderLocationField } from "./TraderLocationField";

interface EditOrderDialogProps {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MOBILITY_VALUES: TraderMobility[] = ["stationary", "occasional", "frequent"];
const NO_MOBILITY = "__none__";

interface EditOrderFormProps {
  order: Order;
  onClose: () => void;
}

function EditOrderForm({ order, onClose }: EditOrderFormProps) {
  const invalidate = useInvalidateOrders();

  const [unitPrice, setUnitPrice] = useState(String(order.unit_price));
  const [quantity, setQuantity] = useState(String(order.quantity));
  const [previewText, setPreviewText] = useState(order.preview_text ?? "");
  const [notes, setNotes] = useState(order.notes ?? "");
  const [location, setLocation] = useState<OrderLocation | null>(order.location);
  const [mobility, setMobility] = useState<TraderMobility | null>(order.mobility);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (payload: Partial<CreateOrderPayload> & { clear_location?: boolean }) =>
      ordersApi.update(order.id, payload),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (e) =>
      setError(e instanceof ApiError ? String(e.detail ?? e.message) : "Failed to update order"),
  });

  const submit = () => {
    setError(null);
    const price = Number.parseFloat(unitPrice);
    const qty = Number.parseInt(quantity, 10);
    if (!Number.isFinite(price) || price <= 0) {
      setError("Enter a valid unit price (> 0).");
      return;
    }
    if (!Number.isInteger(qty) || qty < 1) {
      setError("Enter a valid quantity (≥ 1).");
      return;
    }
    mutation.mutate({
      unit_price: price,
      quantity: qty,
      preview_text: previewText.trim() || null,
      notes: notes.trim() || null,
      location,
      clear_location: location == null,
      mobility,
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit order</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="edit-price">Price {priceUnitLabel(order)} (⚙)</Label>
            <Input
              id="edit-price"
              type="number"
              min="0"
              step="1"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-qty">Quantity ({SELL_UNIT_MANY[order.sell_unit]})</Label>
            <Input
              id="edit-qty"
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="edit-preview">Short preview (60 chars)</Label>
          <Input
            id="edit-preview"
            value={previewText}
            maxLength={60}
            onChange={(e) => setPreviewText(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="edit-notes">Notes (200 chars)</Label>
          <textarea
            id="edit-notes"
            value={notes}
            maxLength={200}
            rows={3}
            onChange={(e) => setNotes(e.target.value)}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <TraderLocationField value={location} onChange={setLocation} />
        <div className="space-y-1">
          <Label htmlFor="edit-mobility">Availability</Label>
          <Select
            value={mobility ?? NO_MOBILITY}
            onValueChange={(v) => setMobility(v === NO_MOBILITY ? null : (v as TraderMobility))}
          >
            <SelectTrigger id="edit-mobility" className="w-full">
              <SelectValue placeholder="How often are you around?">
                {(value) =>
                  value === NO_MOBILITY ? "Not specified" : MOBILITY_LABELS[value as TraderMobility]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_MOBILITY}>Not specified</SelectItem>
              {MOBILITY_VALUES.map((m) => (
                <SelectItem key={m} value={m}>
                  {MOBILITY_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter showCloseButton>
        <Button onClick={submit} disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : null}
          Save changes
        </Button>
      </DialogFooter>
    </>
  );
}

export function EditOrderDialog({ order, open, onOpenChange }: EditOrderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        {open && <EditOrderForm order={order} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
