import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  patchAuctionFilters,
  resetAuctionFilters,
  type AuctionSortKey,
  type AuctionStateFilter,
} from "@/store/slices/auctionFilters";

// Sentinel for "no category" — base-ui Select can't hold an empty-string value.
const ALL_CATEGORIES = "__all__";

const STATE_LABELS: Record<string, string> = {
  all: "All",
  sold: "Sold",
  active: "Active",
  expired: "Expired",
};

const SORT_LABELS: Record<string, string> = {
  date: "Date",
  price: "Price",
  pricePerUnit: "Price / unit",
  qty: "Quantity",
  name: "Name",
};

export function MarketFilterBar({ categories }: { categories: string[] }) {
  const dispatch = useAppDispatch();
  const f = useAppSelector((s) => s.auctionFilters);

  return (
    <div className="rounded-md border p-3 flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Search</Label>
        <Input
          value={f.q}
          placeholder="Item, seller or buyer…"
          className="h-9 w-56"
          onChange={(e) => dispatch(patchAuctionFilters({ q: e.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Category</Label>
        <Select
          value={f.category === "" ? ALL_CATEGORIES : f.category}
          onValueChange={(v) =>
            dispatch(patchAuctionFilters({ category: v === ALL_CATEGORIES ? "" : (v ?? "") }))
          }
        >
          <SelectTrigger size="sm" className="w-48">
            <SelectValue>
              {(value) => (value === ALL_CATEGORIES || !value ? "All categories" : value)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Status</Label>
        <Select
          value={f.state}
          onValueChange={(v) => dispatch(patchAuctionFilters({ state: v as AuctionStateFilter }))}
        >
          <SelectTrigger size="sm" className="w-32">
            <SelectValue>{(value) => STATE_LABELS[value as string] ?? value}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="sold">Sold</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Price (gears)</Label>
        <div className="flex items-center gap-1">
          <Input
            value={f.priceMin}
            inputMode="numeric"
            placeholder="min"
            className="h-9 w-20"
            onChange={(e) => dispatch(patchAuctionFilters({ priceMin: e.target.value }))}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            value={f.priceMax}
            inputMode="numeric"
            placeholder="max"
            className="h-9 w-20"
            onChange={(e) => dispatch(patchAuctionFilters({ priceMax: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Sort by</Label>
        <div className="flex items-center gap-1">
          <Select
            value={f.sort}
            onValueChange={(v) => dispatch(patchAuctionFilters({ sort: v as AuctionSortKey }))}
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue>{(value) => SORT_LABELS[value as string] ?? value}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="price">Price</SelectItem>
              <SelectItem value="pricePerUnit">Price / unit</SelectItem>
              <SelectItem value="qty">Quantity</SelectItem>
              <SelectItem value="name">Name</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() =>
              dispatch(patchAuctionFilters({ sortDir: f.sortDir === "asc" ? "desc" : "asc" }))
            }
            title="Toggle sort direction"
          >
            {f.sortDir === "asc" ? "↑" : "↓"}
          </Button>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer h-9">
        <Checkbox
          checked={f.deliveredOnly}
          onCheckedChange={(v) => dispatch(patchAuctionFilters({ deliveredOnly: !!v }))}
        />
        Delivered only
      </label>

      <label className="flex items-center gap-2 text-sm cursor-pointer h-9">
        <Checkbox
          checked={f.excludeSpam}
          onCheckedChange={(v) => dispatch(patchAuctionFilters({ excludeSpam: !!v }))}
        />
        Hide spam
      </label>

      <Button
        variant="ghost"
        size="sm"
        className="h-9 ml-auto"
        onClick={() => dispatch(resetAuctionFilters())}
      >
        Reset
      </Button>
    </div>
  );
}
