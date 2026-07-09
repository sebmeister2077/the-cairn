import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Small "?" popover explaining what the Median vs Quantity-weighted price
 * options mean, shown next to the price-mode toggle on the Insights and Item
 * pages. Content mirrors the "How to choose" guidance.
 */
export function PriceModeInfo() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="What do these price modes mean?"
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <Info className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-sm">
        <p className="font-medium">How to choose</p>
        <p className="mt-1 text-muted-foreground">
          Both options report a price that a trade actually happened at — neither invents a new
          blended number, so a single mispriced trade won't skew the result.
        </p>
        <dl className="mt-3 space-y-2">
          <div>
            <dt className="font-medium">Median</dt>
            <dd className="text-muted-foreground">
              The middle listing price — every seller counts once, no matter how many units they
              moved. Best for “what price do most <em>listings</em> post at?”
            </dd>
          </div>
          <div>
            <dt className="font-medium">Quantity-weighted</dt>
            <dd className="text-muted-foreground">
              The middle price by <em>units sold</em> — a sale of 50 counts 50×, a sale of 1 counts
              once, so bulk trades set the going rate. Best for “what price do most <em>goods</em>{" "}
              trade at?”
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          Example: four 1-unit sales at 100 and one 50-unit sale at 60 → Median = 100 (the small
          trades win), Quantity-weighted = 60 (most goods moved at 60).
        </p>
      </PopoverContent>
    </Popover>
  );
}
