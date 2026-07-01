import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/usage/StatCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useAuctionListings, formatGears } from "@/lib/auction";

export function MarketPlayerPage() {
  const { uid } = useParams<{ uid: string }>();
  const { data, isLoading } = useAuctionListings();

  const decodedUid = uid ? decodeURIComponent(uid) : "";

  const { name, asSeller, asBuyer, favItems, locations, revenue, spent } = useMemo(() => {
    const all = data ?? [];
    const asSeller = all.filter((l) => l.sellerUid === decodedUid);
    const asBuyer = all.filter((l) => l.buyerUid === decodedUid && l.sold);
    const name =
      asSeller.find((l) => l.sellerName)?.sellerName ??
      asBuyer.find((l) => l.buyerName)?.buyerName ??
      decodedUid;

    const revenue = asSeller
      .filter((l) => l.sold)
      .reduce((s, l) => s + l.price - (l.traderCut || 0), 0);
    const spent = asBuyer.reduce((s, l) => s + l.price, 0);

    const itemCounts = new Map<string, number>();
    for (const l of asSeller) itemCounts.set(l.name, (itemCounts.get(l.name) ?? 0) + 1);
    const favItems = [...itemCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    const locSet = new Map<string, { x: number; z: number; count: number }>();
    for (const l of asSeller) {
      if (l.srcX || l.srcZ) {
        const x = Math.round(l.srcX);
        const z = Math.round(l.srcZ);
        const key = `${x}, ${z}`;
        const prev = locSet.get(key);
        if (prev) prev.count += 1;
        else locSet.set(key, { x, z, count: 1 });
      }
    }
    const locations = [...locSet.values()].sort((a, b) => b.count - a.count).slice(0, 6);

    return { name, asSeller, asBuyer, favItems, locations, revenue, spent };
  }, [data, decodedUid]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading…
      </div>
    );
  }
  if (asSeller.length === 0 && asBuyer.length === 0) {
    return (
      <div className="py-12 text-center space-y-2">
        <p className="text-muted-foreground">No trades found for this player.</p>
        <Link to="/market/leaderboards" className="text-primary hover:underline">
          Back to leaderboards
        </Link>
      </div>
    );
  }

  const soldCount = asSeller.filter((l) => l.sold).length;
  const sellThrough = asSeller.length ? soldCount / asSeller.length : 0;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/market/leaderboards" className="text-sm text-primary hover:underline">
          ← Leaderboards
        </Link>
        <h1 className="text-2xl font-semibold">{name}</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Net revenue" value={formatGears(revenue)} />
        <StatCard label="Total spent" value={formatGears(spent)} />
        <StatCard label="Items listed" value={asSeller.length} />
        <StatCard label="Sell-through" value={`${(sellThrough * 100).toFixed(0)}%`} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <h2 className="font-semibold mb-2">Favorite items to sell</h2>
          <div className="rounded-md border divide-y">
            {favItems.map(([itemName, count]) => (
              <div key={itemName} className="flex justify-between px-3 py-1.5 text-sm">
                <span>{itemName}</span>
                <Badge variant="secondary">{count}</Badge>
              </div>
            ))}
            {favItems.length === 0 && (
              <p className="text-sm text-muted-foreground px-3 py-2">No sales.</p>
            )}
          </div>
        </div>

        <div>
          <h2 className="font-semibold mb-2">Trade locations</h2>
          <div className="rounded-md border divide-y">
            {locations.map((loc) => (
              <Link
                key={`${loc.x},${loc.z}`}
                to={`/multiplayer/tops-map?x=${loc.x}&z=${loc.z}&zoom=2`}
                className="flex justify-between px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors"
                title="Open on the TOPS map"
              >
                <span className="tabular-nums text-primary hover:underline">
                  X {loc.x}, Z {loc.z}
                </span>
                <Badge variant="secondary">{loc.count}</Badge>
              </Link>
            ))}
            {locations.length === 0 && (
              <p className="text-sm text-muted-foreground px-3 py-2">No known locations.</p>
            )}
          </div>
        </div>
      </div>

      <div>
        <h2 className="font-semibold mb-2">Listings ({asSeller.length})</h2>
        <div className="rounded-md border overflow-auto max-h-96">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {asSeller.slice(0, 100).map((l) => (
                <TableRow key={l.auctionId}>
                  <TableCell>
                    <Link to={`/market/items/${l.itemId}`} className="hover:underline">
                      {l.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.price.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.qty}</TableCell>
                  <TableCell>
                    {l.sold ? (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600">Sold</Badge>
                    ) : (
                      <Badge variant="outline">{l.state}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
