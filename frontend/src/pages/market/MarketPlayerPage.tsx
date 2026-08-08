import { useMemo } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useReportEntityLabel } from "@/hooks/useReportEntityLabel";
import { StatCard } from "@/components/usage/StatCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuctionListings, useAuctionSummary, formatGears } from "@/lib/auction";
import { INSIGHTS_WINDOWS, filterListingsByWindow, resolveWindowDays } from "./useMarketInsights";
import { usePlayerWindow } from "./useMarketPlayerWindow";
import { usePlayerProfile } from "./usePlayerProfile";
import { PlayerPricingChart, PlayerActivityChart } from "./PlayerCharts";
import { PlayerListingsSection } from "./PlayerListingsSection";
import { PlayerPurchasesSection } from "./PlayerPurchasesSection";
import { PlayerBehaviorSection } from "./PlayerBehaviorSection";

// Auctioneer entities respawn a few blocks off (with a new entity id) after a
// culling event, so the same physical stall shows up under slightly different
// coordinates. Merge seller positions within this radius (blocks) into one.
const LOCATION_CLUSTER_RADIUS = 12;

export function MarketPlayerPage() {
  const { uid } = useParams<{ uid: string }>();
  const { data, isLoading } = useAuctionListings();
  const { data: summary } = useAuctionSummary();
  const navigate = useNavigate();
  const location = useLocation();

  // Player profiles keep their OWN persisted time window, independent of the
  // market-wide pages (Insights / items), so investigating a trader never
  // disturbs the range selected elsewhere.
  const [windowKey, setWindowKey] = usePlayerWindow();
  const windowDays = useMemo(
    () => resolveWindowDays(windowKey, summary?.recordingStartGameHours),
    [windowKey, summary?.recordingStartGameHours],
  );

  const decodedUid = uid ? decodeURIComponent(uid) : "";

  const profile = usePlayerProfile(data, decodedUid, windowDays);

  // Whether this player exists in the dataset at all (across all time), so a
  // player who traded only outside the selected window still resolves to a real
  // profile instead of the dead-end "No trades found" page — which would
  // otherwise hide the window selector needed to widen the range.
  const hasAnyTrades = useMemo(
    () =>
      (data ?? []).some((l) => l.sellerUid === decodedUid || (l.buyerUid === decodedUid && l.sold)),
    [data, decodedUid],
  );

  const { name, asSeller, asBuyer, favItems, favBuyItems, locations, revenue, spent, delivery } =
    useMemo(() => {
      const all = filterListingsByWindow(data ?? [], windowDays);
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

      // Delivery: what share of this player's sales/purchases used delivery, and
      // the total delivery fees they paid as a buyer.
      const soldSeller = asSeller.filter((l) => l.sold);
      const sellerDelivered = soldSeller.filter((l) => l.delivered).length;
      const buyerDelivered = asBuyer.filter((l) => l.delivered).length;
      const delivery = {
        feesPaid: asBuyer.reduce((s, l) => s + (l.deliveryFee || 0), 0),
        sellerDelivered,
        sellerRate: soldSeller.length ? sellerDelivered / soldSeller.length : null,
        buyerDelivered,
        buyerRate: asBuyer.length ? buyerDelivered / asBuyer.length : null,
      };

      return {
        name,
        asSeller,
        asBuyer,
        favItems,
        favBuyItems,
        locations,
        revenue,
        spent,
        delivery,
      };
    }, [data, decodedUid, windowDays]);

  // Report the resolved in-game name (never the raw uid fallback) so the admin
  // usage "Items & Players" tab can show names instead of opaque uids.
  useReportEntityLabel(
    "/market/players/:uid",
    decodedUid || null,
    name && name !== decodedUid ? name : null,
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading…
      </div>
    );
  }
  // Only a player with no trades in ANY time range is genuinely unknown. A
  // player who simply hasn't traded within the selected window still gets a
  // profile page (below), where they can widen the range.
  if (!hasAnyTrades) {
    return (
      <div className="py-12 text-center space-y-2">
        <p className="text-muted-foreground">No trades found for this player.</p>
        <Link to="/market/leaderboards" className="text-primary hover:underline">
          Back to leaderboards
        </Link>
      </div>
    );
  }

  const emptyInWindow = asSeller.length === 0 && asBuyer.length === 0;

  const soldCount = asSeller.filter((l) => l.sold).length;
  const sellThrough = asSeller.length ? soldCount / asSeller.length : 0;

  const onBack = () => {
    // Return to wherever the user came from; fall back to the leaderboards on a
    // fresh load with no in-app history to pop.
    if (location.key !== "default") navigate(-1);
    else navigate("/market/leaderboards");
  };

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back
        </button>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-2xl font-semibold">{name}</h1>
          <div className="flex items-center gap-1">
            {INSIGHTS_WINDOWS.map((w) => (
              <Button
                key={w.key}
                size="sm"
                variant={windowKey === w.key ? "default" : "outline"}
                onClick={() => setWindowKey(w.key)}
              >
                {w.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {emptyInWindow ? (
        <div className="rounded-md border bg-muted/30 px-4 py-10 text-center space-y-3">
          <p className="text-muted-foreground">
            No trades in the selected time range — this player last traded earlier.
          </p>
          <Button size="sm" variant="outline" onClick={() => setWindowKey("all")}>
            Show all time
          </Button>
        </div>
      ) : (
        <>
          <PlayerBehaviorSection profile={profile} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Net revenue" value={formatGears(revenue)} />
            <StatCard label="Total spent" value={formatGears(spent)} />
            <StatCard label="Items listed" value={asSeller.length} />
            <StatCard label="Sell-through" value={`${(sellThrough * 100).toFixed(0)}%`} />
            <StatCard label="Delivery paid" value={formatGears(delivery.feesPaid)} />
            <StatCard
              label="Sales delivered"
              value={
                delivery.sellerRate != null
                  ? `${delivery.sellerDelivered} · ${(delivery.sellerRate * 100).toFixed(0)}%`
                  : "—"
              }
            />
            <StatCard
              label="Buys delivered"
              value={
                delivery.buyerRate != null
                  ? `${delivery.buyerDelivered} · ${(delivery.buyerRate * 100).toFixed(0)}%`
                  : "—"
              }
            />
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
            <h2 className="font-semibold mb-1">Pricing vs the market</h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Each point is one listing, plotted as how far its per-unit price sat above or below
              the prevailing market median at the time (the dashed line). It reflects pricing
              habits, not fairness.
            </p>
            <PlayerPricingChart points={profile.pricingHistory} />
          </div>

          <div>
            <h2 className="font-semibold mb-2">Activity over time</h2>
            <PlayerActivityChart activity={profile.activity} />
          </div>

          <PlayerListingsSection listings={asSeller} />

          <PlayerPurchasesSection listings={asBuyer} />
        </>
      )}
    </div>
  );
}
