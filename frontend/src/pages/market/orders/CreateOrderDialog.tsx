// Create-order dialog for the Orders marketplace. Account-gated by the caller.
// Pre-fills location + mobility from the trader profile and offers a
// "Save as default" checkbox that writes those values back to the profile.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
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
import { ORDERS_KEY, ordersApi, useTraderProfile } from "@/lib/orders";
import type { CreateOrderPayload, OrderLocation, OrderSide, TraderMobility } from "@/models/orders";
import { MOBILITY_LABELS, SIDE_LABELS, STACKS_PER_CRATE, useItemPicker } from "./ordersShared";
import { TraderLocationField } from "./TraderLocationField";

interface CreateOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MOBILITY_VALUES: TraderMobility[] = ["stationary", "occasional", "frequent"];
const NO_MOBILITY = "__none__";

type QtyUnit = "unit" | "stack" | "crate";
const QTY_UNIT_LABELS: Record<QtyUnit, string> = {
  unit: "Individual units",
  stack: "Stacks",
  crate: `Crates (${STACKS_PER_CRATE} stacks)`,
};
const PRICE_UNIT_LABELS: Record<QtyUnit, string> = {
  unit: "Price per unit (⚙)",
  stack: "Price per stack (⚙)",
  crate: "Price per crate (⚙)",
};

interface CreateOrderFormProps {
  initialLocation: OrderLocation | null;
  initialMobility: TraderMobility | null;
  onClose: () => void;
}

function CreateOrderForm({ initialLocation, initialMobility, onClose }: CreateOrderFormProps) {
  const qc = useQueryClient();
  const { suggestions, resolveId, resolveStackSize, isPending: catalogPending } = useItemPicker();

  const [side, setSide] = useState<OrderSide>("sell");
  const [itemName, setItemName] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [qtyUnit, setQtyUnit] = useState<QtyUnit>("unit");
  const [stackSizeInput, setStackSizeInput] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [notes, setNotes] = useState("");
  const [location, setLocation] = useState<OrderLocation | null>(initialLocation);
  const [mobility, setMobility] = useState<TraderMobility | null>(initialMobility);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stack size for the selected item: from the catalog when known, otherwise
  // the value the user typed in manually.
  const knownStackSize = itemName ? resolveStackSize(itemName) : null;
  const stackSizeKnown = knownStackSize != null;
  const effectiveStackSize = stackSizeKnown ? knownStackSize : Number.parseInt(stackSizeInput, 10);

  // Units-per-selected-unit multiplier and the resulting total unit count.
  const multiplier =
    qtyUnit === "crate"
      ? effectiveStackSize * STACKS_PER_CRATE
      : qtyUnit === "stack"
        ? effectiveStackSize
        : 1;
  const qtyNum = Number.parseInt(quantity, 10);
  const totalUnits =
    Number.isFinite(qtyNum) && qtyNum > 0 && Number.isFinite(multiplier) && multiplier > 0
      ? qtyNum * multiplier
      : 0;

  const mutation = useMutation({
    mutationFn: (payload: CreateOrderPayload) => ordersApi.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ORDERS_KEY });
      onClose();
    },
    onError: (e) => {
      setError(e instanceof ApiError ? String(e.detail ?? e.message) : "Failed to create order");
    },
  });

  const handleSubmit = () => {
    setError(null);
    const itemId = resolveId(itemName);
    if (itemId == null) {
      setError("Pick an item from the list.");
      return;
    }
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
    if (qtyUnit !== "unit" && (!Number.isInteger(effectiveStackSize) || effectiveStackSize < 1)) {
      setError("Enter a valid stack size (≥ 1).");
      return;
    }
    mutation.mutate({
      side,
      item_id: itemId,
      item_name: itemName.trim(),
      unit_price: price,
      quantity: qty,
      sell_unit: qtyUnit,
      stack_size: qtyUnit === "unit" ? null : effectiveStackSize,
      preview_text: previewText.trim() || null,
      notes: notes.trim() || null,
      location,
      mobility,
      save_as_default: saveAsDefault,
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New order</DialogTitle>
      </DialogHeader>

      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {(["sell", "buy"] as OrderSide[]).map((s) => (
            <Button
              key={s}
              type="button"
              variant={side === s ? "default" : "outline"}
              onClick={() => setSide(s)}
            >
              {SIDE_LABELS[s]}
            </Button>
          ))}
        </div>

        <div className="space-y-1">
          <Label htmlFor="order-item">Item</Label>
          {catalogPending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading items…
            </div>
          ) : (
            <Combobox
              id="order-item"
              value={itemName}
              onChange={setItemName}
              suggestions={suggestions}
              placeholder="Search an item…"
            />
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="order-price">{PRICE_UNIT_LABELS[qtyUnit]}</Label>
            <Input
              id="order-price"
              type="number"
              min="0"
              step="1"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              placeholder="e.g. 5"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="order-unit">Measured in</Label>
            <Select value={qtyUnit} onValueChange={(v) => setQtyUnit(v as QtyUnit)}>
              <SelectTrigger id="order-unit" className="w-full">
                <SelectValue>{(value) => QTY_UNIT_LABELS[value as QtyUnit]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(["unit", "stack", "crate"] as QtyUnit[]).map((u) => (
                  <SelectItem key={u} value={u}>
                    {QTY_UNIT_LABELS[u]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="order-qty">
              {side === "sell" ? "Quantity available" : "Quantity requested"}
            </Label>
            <Input
              id="order-qty"
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          {qtyUnit !== "unit" && (
            <div className="space-y-1">
              <Label htmlFor="order-stack-size">Stack size</Label>
              <Input
                id="order-stack-size"
                type="number"
                min="1"
                step="1"
                value={stackSizeKnown ? String(knownStackSize) : stackSizeInput}
                onChange={(e) => setStackSizeInput(e.target.value)}
                disabled={stackSizeKnown}
                placeholder="e.g. 64"
              />
            </div>
          )}
        </div>

        {qtyUnit !== "unit" && (
          <p className="text-xs text-muted-foreground">
            {stackSizeKnown
              ? `Known stack size: ${knownStackSize}. `
              : "Stack size unknown for this item — enter it manually. "}
            {totalUnits > 0 && `That's ${totalUnits.toLocaleString()} individual items.`}
          </p>
        )}

        <div className="space-y-1">
          <Label htmlFor="order-preview">Short preview (optional, 60 chars)</Label>
          <Input
            id="order-preview"
            value={previewText}
            maxLength={40}
            onChange={(e) => setPreviewText(e.target.value)}
            placeholder="e.g. Bulk red clay, cheap!"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="order-notes">Notes (optional, 200 chars)</Label>
          <textarea
            id="order-notes"
            value={notes}
            maxLength={200}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="Extra details for buyers/sellers…"
          />
        </div>

        <TraderLocationField value={location} onChange={setLocation} />

        <div className="space-y-1">
          <Label htmlFor="order-mobility">Availability</Label>
          <Select
            value={mobility ?? NO_MOBILITY}
            onValueChange={(v) => setMobility(v === NO_MOBILITY ? null : (v as TraderMobility))}
          >
            <SelectTrigger id="order-mobility" className="w-full">
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

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={saveAsDefault} onCheckedChange={(v) => setSaveAsDefault(Boolean(v))} />
          Save this location &amp; availability as my default
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <DialogFooter showCloseButton>
        <Button onClick={handleSubmit} disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : null}
          Post order
        </Button>
      </DialogFooter>
    </>
  );
}

export function CreateOrderDialog({ open, onOpenChange }: CreateOrderDialogProps) {
  const { data: profile, isPending: profilePending } = useTraderProfile(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        {open && profilePending ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : (
          <CreateOrderForm
            initialLocation={profile?.default_location ?? null}
            initialMobility={profile?.default_mobility ?? null}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
