import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/usage/StatCard";
import { Badge } from "@/components/ui/badge";
import { useAuctionListings, useCurrentGameHours, formatGears } from "@/lib/auction";
import {
  VirtualListingsTable,
  formatListingDate,
  formatGameDate,
  ListingStateBadge,
  type ListingColumn,
} from "./VirtualListingsTable";

// Auctioneer entities respawn a few blocks off (with a new entity id) after a
// culling event, so the same physical stall shows up under slightly different
// coordinates. Merge seller positions within this radius (blocks) into one.
const LOCATION_CLUSTER_RADIUS = 12;

export function MarketPlayerPage() {
  const { uid } = useParams<{ uid: string }>();
  const { data, isLoading } = useAuctionListings();
  const currentGameHours = useCurrentGameHours();

  const decodedUid = uid ? decodeURIComponent(uid) : "";

  const { name, asSeller, asBuyer, favItems, favBuyItems, locations, revenue, spent } =
    useMemo(() => {
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

      const itemCounts = new Map<number, { name: string; count: number }>();
      for (const l of asSeller) {
        const prev = itemCounts.get(l.itemId);
        itemCounts.set(l.itemId, { name: l.name, count: (prev?.count ?? 0) + 1 });
      }
      const favItems = [...itemCounts.entries()]
        .map(([itemId, v]) => ({ itemId, name: v.name, count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      const buyCounts = new Map<number, { name: string; count: number }>();
      for (const l of asBuyer) {
        const prev = buyCounts.get(l.itemId);
        buyCounts.set(l.itemId, { name: l.name, count: (prev?.count ?? 0) + 1 });
      }
      const favBuyItems = [...buyCounts.entries()]
        .map(([itemId, v]) => ({ itemId, name: v.name, count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      // Greedily cluster seller positions so respawned auctioneers (same stall,
      // coords off by a few blocks) collapse into a single location. Each cluster
      // is represented by the running centroid of its members.
      const clusters: { cx: number; cz: number; sx: number; sz: number; count: number }[] = [];
      for (const l of asSeller) {
        if (!l.srcX && !l.srcZ) continue;
        let target = null;
        for (const c of clusters) {
          if (Math.hypot(c.cx - l.srcX, c.cz - l.srcZ) <= LOCATION_CLUSTER_RADIUS) {
            target = c;
            break;
          }
        }
        if (target) {
          target.sx += l.srcX;
          target.sz += l.srcZ;
          target.count += 1;
          target.cx = target.sx / target.count;
          target.cz = target.sz / target.count;
        } else {
          clusters.push({ cx: l.srcX, cz: l.srcZ, sx: l.srcX, sz: l.srcZ, count: 1 });
        }
      }
      const locations = clusters
        .map((c) => ({ x: Math.round(c.cx), z: Math.round(c.cz), count: c.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);

      return { name, asSeller, asBuyer, favItems, favBuyItems, locations, revenue, spent };
    }, [data, decodedUid]);

  // Newest first by in-game posting time (matches the Game date column).
  const sortedSellerListings = useMemo(
    () => [...asSeller].sort((a, b) => (b.postedTotalHours ?? 0) - (a.postedTotalHours ?? 0)),
    [asSeller],
  );

  const columns = useMemo<ListingColumn[]>(
    () => [
      {
        key: "item",
        header: "Item",
        width: "minmax(8rem,1fr)",
        cell: (l) => (
          <Link to={`/market/items/${l.itemId}`} className="hover:underline">
            {l.name}
          </Link>
        ),
      },
      {
        key: "price",
        header: "Price",
        width: "6rem",
        align: "right",
        cell: (l) => l.price.toLocaleString(),
      },
      {
        key: "qty",
        header: "Qty",
        width: "3.5rem",
        align: "right",
        cell: (l) => l.qty,
      },
      {
        key: "date",
        header: "Game date",
        width: "6.5rem",
        cell: (l) => (
          <span
            className="text-xs text-muted-foreground"
            title={`Observed ${formatListingDate(l.observedUtc ?? l.lastObservedUtc)}`}
          >
            {formatGameDate(l.postedTotalHours)}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        width: "5rem",
        cell: (l) => <ListingStateBadge listing={l} currentGameHours={currentGameHours} />,
      },
    ],
    [currentGameHours],
  );

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

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <h2 className="font-semibold mb-2">Favorite items to sell</h2>
          <div className="rounded-md border divide-y">
            {favItems.map((it) => (
              <Link
                key={it.itemId}
                to={`/market/items/${it.itemId}`}
                className="flex justify-between px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors"
                title="Open item page"
              >
                <span className="truncate text-primary hover:underline">{it.name}</span>
                <Badge variant="secondary">{it.count}</Badge>
              </Link>
            ))}
            {favItems.length === 0 && (
              <p className="text-sm text-muted-foreground px-3 py-2">No sales.</p>
            )}
          </div>
        </div>

        <div>
          <h2 className="font-semibold mb-2">Favorite items to buy</h2>
          <div className="rounded-md border divide-y">
            {favBuyItems.map((it) => (
              <Link
                key={it.itemId}
                to={`/market/items/${it.itemId}`}
                className="flex justify-between px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors"
                title="Open item page"
              >
                <span className="truncate text-primary hover:underline">{it.name}</span>
                <Badge variant="secondary">{it.count}</Badge>
              </Link>
            ))}
            {favBuyItems.length === 0 && (
              <p className="text-sm text-muted-foreground px-3 py-2">No purchases.</p>
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
        <VirtualListingsTable listings={sortedSellerListings} columns={columns} />
      </div>
    </div>
  );
}
