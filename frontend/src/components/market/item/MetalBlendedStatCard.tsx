import { Card, CardContent } from "@/components/ui/card";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { formatGears } from "@/lib/auction";
import { Info } from "lucide-react";

export function MetalBlendedStatCard({
  perUnitUseful,
  blendedFairUnit,
  blendedFairStack,
  blendedMetal,
  priceModeWeighted,
  metalFamily,
}: {
  perUnitUseful: boolean;
  blendedFairUnit: number | null;
  blendedFairStack: number | null;
  blendedMetal: {
    formsUsed: number;
  } | null;
  priceModeWeighted: boolean;
  metalFamily: {
    label: string;
  } | null;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          {perUnitUseful ? "Blended price / unit" : "Blended price / stack"}
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="What is the blended fair price?"
                  className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Info className="size-4" />
                </button>
              }
            />
            <PopoverContent className="max-w-xs">
              <div className="space-y-1.5 text-left">
                <p>
                  Combines the sold prices of <span className="text-foreground">every</span> form of
                  this metal — ore chunks, nuggets, metal bits, ingots — each reduced to its
                  pure-metal content, then scaled back up to this item&apos;s content.
                </p>
                <p>
                  Useful when one form has few sales of its own: the other forms fill in a
                  content-consistent price. Crystallized chunks are excluded.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="text-3xl font-semibold tabular-nums">
          {perUnitUseful
            ? blendedFairUnit != null
              ? formatGears(blendedFairUnit)
              : "—"
            : blendedFairStack != null
              ? formatGears(blendedFairStack)
              : "—"}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {blendedMetal
            ? `${priceModeWeighted ? "Qty-weighted" : "Median"} across ${blendedMetal.formsUsed} ${metalFamily?.label.toLowerCase()} form${blendedMetal.formsUsed === 1 ? "" : "s"}, by metal content`
            : "No sold data across forms in this range"}
        </div>
      </CardContent>
    </Card>
  );
}
