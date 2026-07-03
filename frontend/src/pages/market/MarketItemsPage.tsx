// Simple searchable index of every item on the market. Backed by the small,
// precomputed `summary.json` (`itemStats`) so it loads without pulling the
// large `listings.json` payload. Each row links through to the item page.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuctionSummary, formatGears } from "@/lib/auction";
import type { ItemStat } from "@/models/auction";

// Sentinel for "no category" — base-ui Select can't hold an empty-string value.
const ALL_CATEGORIES = "__all__";
// Cap the rendered rows so a broad search doesn't paint thousands of rows.
const MAX_ROWS = 250;

type SortKey = "gears" | "sold" | "listings" | "name";

const SORT_LABELS: Record<SortKey, string> = {
  gears: "Gears traded",
  sold: "Units sold",
  listings: "Listings",
  name: "Name",
};

function sortItems(rows: ItemStat[], key: SortKey): ItemStat[] {
  const sorted = [...rows];
  switch (key) {
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "sold":
      sorted.sort((a, b) => b.unitsSold - a.unitsSold);
      break;
    case "listings":
      sorted.sort((a, b) => b.listings - a.listings);
      break;
    case "gears":
    default:
      sorted.sort((a, b) => b.gearsTraded - a.gearsTraded);
      break;
  }
  return sorted;
}

export function MarketItemsPage() {
  const { data, isPending, isError } = useAuctionSummary();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [sort, setSort] = useState<SortKey>("gears");

  const categories = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.itemStats.map((it) => it.category)))
      .sort()
      .map((c) => ({ value: c, label: c }));
  }, [data]);

  const results = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const filtered = data.itemStats.filter((it) => {
      if (category !== ALL_CATEGORIES && it.category !== category) return false;
      if (needle && !it.name.toLowerCase().includes(needle)) return false;
      return true;
    });
    return sortItems(filtered, sort);
  }, [data, q, category, sort]);

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading market data…
      </div>
    );
  }
  if (isError || !data) {
    return <p className="text-destructive py-12 text-center">Failed to load market summary.</p>;
  }

  const shown = results.slice(0, MAX_ROWS);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Item Search</h1>
        <p className="text-sm text-muted-foreground">
          Search {data.itemStats.length.toLocaleString()} items traded on the Auction House.
        </p>
      </div>

      <div className="rounded-md border p-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Search</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              placeholder="Item name…"
              className="h-9 w-64 pl-8"
              autoFocus
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Category</Label>
          <Select value={category} onValueChange={(v) => setCategory(v ?? ALL_CATEGORIES)}>
            <SelectTrigger className="h-9 w-44">
              <SelectValue>
                {(value) => categories.find((c) => c.value === value)?.label ?? "All categories"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Sort by</Label>
          <Select value={sort} onValueChange={(v) => setSort((v as SortKey) ?? "gears")}>
            <SelectTrigger className="h-9 w-40">
              <SelectValue>
                {(value) => SORT_LABELS[value as SortKey] ?? SORT_LABELS.gears}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SORT_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="ml-auto text-sm text-muted-foreground">
          {results.length.toLocaleString()} match{results.length === 1 ? "" : "es"}
          {results.length > MAX_ROWS ? ` · showing ${MAX_ROWS}` : ""}
        </p>
      </div>

      <div className="rounded-md border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Fair price</TableHead>
              <TableHead className="text-right">Units sold</TableHead>
              <TableHead className="text-right">Listings</TableHead>
              <TableHead className="text-right">Gears traded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((it) => (
              <TableRow key={it.itemId}>
                <TableCell className="font-medium">
                  <Link to={`/market/items/${it.itemId}`} className="hover:underline">
                    {it.name}
                  </Link>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{it.category}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {it.priceStats ? formatGears(it.priceStats.median) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {it.unitsSold.toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {it.listings.toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatGears(it.gearsTraded)}
                </TableCell>
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No items match your search.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
