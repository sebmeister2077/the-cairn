import { FreshnessBanner } from "@/components/market/FreshnessBanner";
import { MarketInflationCategoryBreakdown } from "@/components/market/inflation/CategoryBreakdown";
import { MarketInflationExplainer } from "@/components/market/inflation/Explainer";
import { MarketInflationHeadline } from "@/components/market/inflation/Headline";
import { MarketInflationChart } from "@/components/market/MarketInflationChart";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useAuctionSummary } from "@/lib/auction";

export function MarketInflationPage() {
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
        <h1 className="text-2xl font-semibold">Inflation</h1>
        <FreshnessBanner generatedUtc={data.generatedUtc} />
      </div>

      {!pi ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Not enough sales have been recorded yet to estimate inflation.
          </CardContent>
        </Card>
      ) : (
        <>
          <MarketInflationHeadline h={pi.headline} />
          <MarketInflationChart trend={pi.trend} />

          {pi.categories.length > 0 && (
            <MarketInflationCategoryBreakdown categories={pi.categories} />
          )}

          <MarketInflationExplainer />
        </>
      )}
    </div>
  );
}
