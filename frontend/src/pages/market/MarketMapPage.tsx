import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAuctionSummary } from "@/lib/auction";

/**
 * Trade Map launcher. The interactive heatmap now lives on the TOPS map
 * viewer (full pan/zoom, landmarks, route planner) via a `?auction=` deep
 * link. This page explains the layer and lets users jump straight in, plus
 * lists the busiest auction locations as one-click map links.
 */
export function MarketMapPage() {
  const { data, isPending, isError } = useAuctionSummary();

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading…
      </div>
    );
  }
  if (isError || !data) {
    return <p className="text-destructive py-12 text-center">Failed to load map data.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-semibold">Trade Map</h1>
        <Button size="sm" render={<Link to="/multiplayer/tops-map?auction=both" />}>
          Open interactive Trade Map →
        </Button>
      </div>

      <Card>
        <CardContent className="py-4 space-y-3 text-sm">
          <p className="text-muted-foreground">
            The trade heatmap is now an overlay on the full world map, so you can zoom, pan, see
            landmarks and translocators, and use the route planner (rendezvous mode) to scout where
            to set up a Bazaar.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-blue-500" /> Sell origins — where items were
              listed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-red-500" /> Buy destinations — where
              deliveries were sent
            </span>
          </div>
          <p className="text-muted-foreground">
            Grid resolution {data.heatmapBin} blocks. Toggle each layer from the panel that appears
            on the map.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/multiplayer/tops-map?auction=sell" />}
            >
              Sells only
            </Button>
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/multiplayer/tops-map?auction=buy" />}
            >
              Buys only
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="font-semibold mb-2">Busiest auction locations</h2>
        <div className="rounded-md border divide-y">
          {data.auctioneers.slice(0, 12).map((a) => (
            <Link
              key={`${a.x},${a.z}`}
              to={`/multiplayer/tops-map?x=${a.x}&z=${a.z}&zoom=2&auction=both`}
              className="flex justify-between px-3 py-1.5 text-sm tabular-nums hover:bg-accent/50 transition-colors"
              title="Open on the TOPS map"
            >
              <span className="text-primary hover:underline">
                X {a.x}, Z {a.z}
              </span>
              <span className="text-muted-foreground">{a.listings} listings</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
