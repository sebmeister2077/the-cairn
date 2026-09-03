// Searchable directory of every trader on the Auction House. There's no backend
// player endpoint — the full `listings.json` is already loaded, so we aggregate
// one lightweight row per player (see `usePlayerSearchIndex`) and let the user
// search, filter by role and sort. Each row links to the full player profile.

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
import { useAuctionListings, formatGears } from "@/lib/auction";
import { formatListingDate } from "@/components/market/VirtualListingsTable";
import { usePlayerSearchIndex, type PlayerIndexRow } from "@/hooks/usePlayerSearchIndex";
import {
  usePlayerSearch,
  patchPlayerSearch,
  resetPlayerSearch,
  isDefaultPlayerSearch,
  type PlayerRole,
  type PlayerSort,
} from "@/hooks/usePlayerSearch";

// Cap the rendered rows so a broad search doesn't paint thousands of rows.
const MAX_ROWS = 250;

const SORT_LABELS: Record<PlayerSort, string> = {
  revenue: "Net revenue",
  spent: "Total spent",
  listed: "Listings",
  sold: "Items sold",
  bought: "Items bought",
  activity: "Last active",
  name: "Name",
};

const ROLE_LABELS: Record<PlayerRole, string> = {
  all: "Everyone",
  seller: "Sellers",
  buyer: "Buyers",
  both: "Buys & sells",
};

const ROLE_BADGE: Record<PlayerIndexRow["role"], string> = {
  seller: "Seller",
  buyer: "Buyer",
  both: "Both",
};

function sortRows(rows: PlayerIndexRow[], key: PlayerSort): PlayerIndexRow[] {
  const sorted = [...rows];
  const byName = (a: PlayerIndexRow, b: PlayerIndexRow) => a.name.localeCompare(b.name);
  switch (key) {
    case "name":
      sorted.sort(byName);
      break;
    case "spent":
      sorted.sort((a, b) => b.spent - a.spent || byName(a, b));
      break;
    case "listed":
      sorted.sort((a, b) => b.listed - a.listed || byName(a, b));
      break;
    case "sold":
      sorted.sort((a, b) => b.sold - a.sold || byName(a, b));
      break;
    case "bought":
      sorted.sort((a, b) => b.bought - a.bought || byName(a, b));
      break;
    case "activity":
      // Newest first; players with no timestamp sort last.
      sorted.sort(
        (a, b) => (b.lastActiveUtc ?? "").localeCompare(a.lastActiveUtc ?? "") || byName(a, b),
      );
      break;
    case "revenue":
    default:
      sorted.sort((a, b) => b.revenue - a.revenue || byName(a, b));
      break;
  }
  return sorted;
}

/** Whole-number display, or "—" when zero. */
function num(n: number): string {
  return n ? n.toLocaleString() : "—";
}

export function MarketPlayersPage() {
  const listingsQ = useAuctionListings();
  const rows = usePlayerSearchIndex(listingsQ.data);
  const search = usePlayerSearch();
  const { q, role, sort } = search;

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (role !== "all" && r.role !== role) return false;
      if (needle && !r.name.toLowerCase().includes(needle) && !r.uid.toLowerCase().includes(needle))
        return false;
      return true;
    });
    return sortRows(filtered, sort);
  }, [rows, q, role, sort]);

  if (listingsQ.isPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading market data…
      </div>
    );
  }
  if (listingsQ.isError || !listingsQ.data) {
    return <p className="text-destructive py-12 text-center">Failed to load market data.</p>;
  }

  const shown = results.slice(0, MAX_ROWS);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Player Search</h1>
        <p className="text-sm text-muted-foreground">
          Search {rows.length.toLocaleString()} traders seen on the Auction House. Open a player to
          see their full profile — pricing style, favourite items, trade locations and more.
        </p>
      </div>

      <div className="rounded-md border p-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Search</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              placeholder="Player name…"
              className="h-9 w-64 pl-8"
              autoFocus
              onChange={(e) => patchPlayerSearch({ q: e.target.value })}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Role</Label>
          <Select
            value={role}
            onValueChange={(v) => patchPlayerSearch({ role: (v as PlayerRole) ?? "all" })}
          >
            <SelectTrigger className="h-9 w-40">
              <SelectValue>
                {(value) => ROLE_LABELS[value as PlayerRole] ?? ROLE_LABELS.all}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ROLE_LABELS) as PlayerRole[]).map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Sort by</Label>
          <Select
            value={sort}
            onValueChange={(v) => patchPlayerSearch({ sort: (v as PlayerSort) ?? "revenue" })}
          >
            <SelectTrigger className="h-9 w-40">
              <SelectValue>
                {(value) => SORT_LABELS[value as PlayerSort] ?? SORT_LABELS.revenue}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as PlayerSort[]).map((k) => (
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
            disabled={isDefaultPlayerSearch(search)}
            onClick={resetPlayerSearch}
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
              <TableHead>Player</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Top category</TableHead>
              <TableHead className="text-right">Net revenue</TableHead>
              <TableHead className="text-right">Total spent</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Listed</TableHead>
              <TableHead className="text-right">Bought</TableHead>
              <TableHead className="text-right">Sell-through</TableHead>
              <TableHead className="text-right">Last active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((p) => (
              <TableRow key={p.uid}>
                <TableCell className="font-medium">
                  <Link
                    to={`/market/players/${encodeURIComponent(p.uid)}`}
                    className="hover:underline"
                  >
                    {p.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {ROLE_BADGE[p.role]}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {p.topCategory ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.revenue ? formatGears(p.revenue) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.spent ? formatGears(p.spent) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{num(p.sold)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(p.listed)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(p.bought)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.sellThrough != null ? `${Math.round(p.sellThrough * 100)}%` : "—"}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {formatListingDate(p.lastActiveUtc)}
                </TableCell>
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  No players match your search.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
