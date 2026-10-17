import { Card, CardContent } from "@/components/ui/card";

export function MarketInflationExplainer() {
  return (
    <Card>
      <CardContent className="py-4 text-sm text-muted-foreground space-y-2">
        <div className="font-medium text-foreground">How this is measured</div>
        <p>
          We take thousands of real Auction House sales and compare what the same items sold for
          recently versus at the start of tracking — like a shopping basket you re-price over time.
        </p>
        <p>
          Not every seller raises prices with inflation, and a few rare items swing wildly. So we
          use the <strong>typical</strong> change across many items (not the average), which stops a
          handful of big jumps from distorting the picture. Items that never change price correctly
          pull the number toward zero.
        </p>
        <p>
          “Confidence” reflects how much sellers agree and how many items we could match between the
          two periods — not a guarantee.
        </p>
      </CardContent>
    </Card>
  );
}
