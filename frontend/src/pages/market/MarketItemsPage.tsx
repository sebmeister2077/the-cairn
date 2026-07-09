// Simple searchable index of every item on the market. The master list is the
// full item catalog (`items.json`), enriched with trade metrics from the
// precomputed `summary.json` (`itemStats`) where available — so every item is
// listed, even ones with no (non-spam) sales yet. Each row links to the item page.

import { useMemo } from "react";
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
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuctionSummary, useItemCatalog, formatGears } from "@/lib/auction";
import {
  useItemSearch,
  patchItemSearch,
  resetItemSearch,
  isDefaultItemSearch,
  ALL_CATEGORIES,
  type ItemSort,
} from "./useItemSearch";

// Cap the rendered rows so a broad search doesn't paint thousands of rows.
const MAX_ROWS = 250;

type SortKey = ItemSort;

const SORT_LABELS: Record<SortKey, string> = {
  gears: "Gears traded",
  sold: "Units sold",
  listings: "Listings",
  name: "Name",
};

interface SearchRow {
  itemId: number;
  name: string;
  category: string;
  listings: number;
  unitsSold: number;
  gearsTraded: number;
  median: number | null;
  weighted: number | null;
}

function sortRows(rows: SearchRow[], key: SortKey): SearchRow[] {
  const sorted = [...rows];
  switch (key) {
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "sold":
      sorted.sort((a, b) => b.unitsSold - a.unitsSold || a.name.localeCompare(b.name));
      break;
    case "listings":
      sorted.sort((a, b) => b.listings - a.listings || a.name.localeCompare(b.name));
      break;
    case "gears":
    default:
      sorted.sort((a, b) => b.gearsTraded - a.gearsTraded || a.name.localeCompare(b.name));
      break;
  }
  return sorted;
}

/** Whole-number display, or "—" when zero/absent. */
function num(n: number): string {
  return n ? n.toLocaleString() : "—";
}

export function MarketItemsPage() {
  const catalogQ = useItemCatalog();
  const summaryQ = useAuctionSummary();
  const search = useItemSearch();
  const { q, category, sort } = search;

  // Master list: every catalog item, enriched with stats where we have them.
  const rows = useMemo<SearchRow[]>(() => {
    const catalog = catalogQ.data;
    if (!catalog) return [];
    const statsById = new Map(
      (summaryQ.data?.itemStats ?? []).map((it) => [it.itemId, it] as const),
    );
    return Object.entries(catalog).map(([idStr, entry]) => {
      const itemId = Number(idStr);
      const st = statsById.get(itemId);
      return {
        itemId,
        name: entry.name,
        category: entry.category,
        listings: st?.listings ?? 0,
        unitsSold: st?.unitsSold ?? 0,
        gearsTraded: st?.gearsTraded ?? 0,
        median: st?.priceStats?.median ?? null,
        weighted: st?.weightedPricePerUnit ?? null,
      };
    });
  }, [catalogQ.data, summaryQ.data]);

  const categories = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.category)))
        .sort()
        .map((c) => ({ value: c, label: c })),
    [rows],
  );

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (category !== ALL_CATEGORIES && r.category !== category) return false;
      // Match the item name OR its category, so a search like "tapestry" surfaces
      // every grouped tapestry (named "Ambush", "Rot", …) not just a literal name.
      if (
        needle &&
        !r.name.toLowerCase().includes(needle) &&
        !r.category.toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
    return sortRows(filtered, sort);
  }, [rows, q, category, sort]);

  const isPending = catalogQ.isPending || summaryQ.isPending;
  const isError = catalogQ.isError || summaryQ.isError;

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading market data…
      </div>
    );
  }
  if (isError || !catalogQ.data) {
    return <p className="text-destructive py-12 text-center">Failed to load market data.</p>;
  }

  const shown = results.slice(0, MAX_ROWS);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Item Search</h1>
        <p className="text-sm text-muted-foreground">
          Search {rows.length.toLocaleString()} items traded on the Auction House.
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
              onChange={(e) => patchItemSearch({ q: e.target.value })}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Category</Label>
          <Select
            value={category}
            onValueChange={(v) => patchItemSearch({ category: v ?? ALL_CATEGORIES })}
          >
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
          <Select
            value={sort}
            onValueChange={(v) => patchItemSearch({ sort: (v as SortKey) ?? "gears" })}
          >
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

        <div className="ml-auto flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            disabled={isDefaultItemSearch(search)}
            onClick={resetItemSearch}
          >
            Reset
          </Button>
          <p className="text-sm text-muted-foreground">
            {results.length.toLocaleString()} match{results.length === 1 ? "" : "es"}
            {results.length > MAX_ROWS ? ` · showing ${MAX_ROWS}` : ""}
          </p>
        </div>
      </div>

      <div className="rounded-md border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Fair price</TableHead>
              <TableHead className="text-right">Weighted price</TableHead>
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
                  {it.median != null ? formatGears(it.median) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {it.weighted != null ? formatGears(it.weighted) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{num(it.unitsSold)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(it.listings)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {it.gearsTraded ? formatGears(it.gearsTraded) : "—"}
                </TableCell>
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
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
