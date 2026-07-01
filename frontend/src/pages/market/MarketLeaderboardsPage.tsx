import { Link } from "react-router-dom";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useAuctionSummary, formatGears } from "@/lib/auction";

export function MarketLeaderboardsPage() {
  const { data, isLoading, isError } = useAuctionSummary();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading…
      </div>
    );
  }
  if (isError || !data) {
    return <p className="text-destructive py-12 text-center">Failed to load leaderboards.</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Leaderboards</h1>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="py-4">
            <h2 className="font-semibold mb-2">Top sellers (net revenue)</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trader</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Sold</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topSellers.slice(0, 15).map((s) => (
                  <TableRow key={s.uid}>
                    <TableCell>
                      <Link
                        to={`/market/players/${encodeURIComponent(s.uid)}`}
                        className="hover:underline"
                      >
                        {s.name ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGears(s.revenue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.sold}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4">
            <h2 className="font-semibold mb-2">Top buyers (spend)</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Buyer</TableHead>
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead className="text-right">Bought</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topBuyers.slice(0, 15).map((b) => (
                  <TableRow key={b.uid}>
                    <TableCell>
                      <Link
                        to={`/market/players/${encodeURIComponent(b.uid)}`}
                        className="hover:underline"
                      >
                        {b.name ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGears(b.spent)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{b.bought}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4">
            <h2 className="font-semibold mb-2">Most valuable items</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Gears traded</TableHead>
                  <TableHead className="text-right">Sold</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.itemStats.slice(0, 15).map((it) => (
                  <TableRow key={it.itemId}>
                    <TableCell>
                      <Link to={`/market/items/${it.itemId}`} className="hover:underline">
                        {it.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGears(it.gearsTraded)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{it.unitsSold}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4">
            <h2 className="font-semibold mb-2">Biggest single sales</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead>Seller</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.biggestSales.slice(0, 15).map((s) => (
                  <TableRow key={s.auctionId}>
                    <TableCell>
                      <span className="font-medium">{s.name}</span>
                      <span className="text-muted-foreground text-xs"> ×{s.qty}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGears(s.price)}
                    </TableCell>
                    <TableCell className="text-xs">{s.sellerName ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
