import { FreshnessBanner } from "@/components/market/FreshnessBanner";
import { MarketPriceIndexCategoryBreakdown } from "@/components/market/price-index/CategoryBreakdown";
import { MarketPriceIndexExplainer } from "@/components/market/price-index/Explainer";
import { MarketPriceIndexHeadline } from "@/components/market/price-index/Headline";
import { MarketInflationChart } from "@/components/market/MarketInflationChart";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useAuctionSummary } from "@/lib/market/auction";

export function MarketPriceIndexPage() {
  const { data, isPending, isError } = useAuctionSummary();

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

  const pi = data.priceIndex;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Price Index</h1>
        <FreshnessBanner generatedUtc={data.generatedUtc} />
      </div>

      {!pi ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Not enough sales have been recorded yet to estimate Price Index.
          </CardContent>
        </Card>
      ) : (
        <>
          <MarketPriceIndexHeadline h={pi.headline} />
          <MarketInflationChart trend={pi.trend} />

          {pi.categories.length > 0 && (
            <MarketPriceIndexCategoryBreakdown categories={pi.categories} />
          )}

          <MarketPriceIndexExplainer />
        </>
      )}
    </div>
  );
}
