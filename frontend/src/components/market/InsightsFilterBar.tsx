// Filter bar for the Market Insights screener. Mirrors [MarketFilterBar.tsx] but
// targets the derived `InsightsRow` indicators. All state lives in the persisted
// `insightsFilters` slice; the screener sort is persisted separately. Every
// dropdown is multi-select — only the free-text search is single-valued.

import { ChevronDown, Star } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  patchInsightsFilters,
  resetInsightsFilters,
  isDefaultInsightsFilters,
  type InsightsFilters,
} from "@/store/slices/insightsFilters";
import { ExternalTradeToggle } from "../../components/market/ExternalTradeToggle";

interface Option {
  value: string;
  label: string;
}

const DEMAND_OPTIONS: Option[] = [
  { value: "hot", label: "Hot" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];
const VOLATILITY_OPTIONS: Option[] = [
  { value: "stable", label: "Stable" },
  { value: "moderate", label: "Moderate" },
  { value: "volatile", label: "Volatile" },
];
const LIQUIDITY_OPTIONS: Option[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];
const CONFIDENCE_OPTIONS: Option[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];
const CONCENTRATION_OPTIONS: Option[] = [
  { value: "competitive", label: "Competitive" },
  { value: "moderate", label: "Moderate" },
  { value: "concentrated", label: "Concentrated" },
  { value: "monopoly", label: "Monopoly" },
];
const TREND_OPTIONS: Option[] = [
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
  { value: "flat", label: "Flat" },
];

/** A compact multi-select (checkbox popover) for a tier/category field. */
function MultiSelect({
  label,
  options,
  selected,
  onChange,
  allLabel = "Any",
  width = "w-36",
}: {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel?: string;
  width?: string;
}) {
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className={cn("h-9 justify-between gap-1 font-normal", width)}
            />
          }
        >
          <span className={cn("truncate", selected.length === 0 && "text-muted-foreground")}>
            {summary}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground/70" />
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-52 p-1">
          <div className="max-h-[min(18rem,60vh)] overflow-y-auto">
            {options.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
              >
                <Checkbox
                  checked={selected.includes(o.value)}
                  onCheckedChange={() => toggle(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
          {selected.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-7 w-full text-xs text-muted-foreground"
              onClick={() => onChange([])}
            >
              Clear
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function InsightsFilterBar({ categories }: { categories: string[] }) {
  const dispatch = useAppDispatch();
  const f = useAppSelector((s) => s.insightsFilters);
  const favoritesCount = useAppSelector((s) => s.marketFavorites.ids.length);
  const categoryOptions: Option[] = categories.map((c) => ({ value: c, label: c }));

  return (
    <div className="rounded-md border p-3 flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Search</Label>
        <Input
          value={f.q}
          placeholder="Item name…"
          className="h-9 w-48"
          onChange={(e) => dispatch(patchInsightsFilters({ q: e.target.value }))}
        />
      </div>

      <MultiSelect
        label="Category"
        options={categoryOptions}
        selected={f.category}
        allLabel="All categories"
        width="w-44"
        onChange={(v) => dispatch(patchInsightsFilters({ category: v }))}
      />
      <MultiSelect
        label="Demand"
        options={DEMAND_OPTIONS}
        selected={f.demand}
        onChange={(v) => dispatch(patchInsightsFilters({ demand: v as InsightsFilters["demand"] }))}
      />
      <MultiSelect
        label="Volatility"
        options={VOLATILITY_OPTIONS}
        selected={f.volatility}
        onChange={(v) =>
          dispatch(patchInsightsFilters({ volatility: v as InsightsFilters["volatility"] }))
        }
      />
      <MultiSelect
        label="Liquidity"
        options={LIQUIDITY_OPTIONS}
        selected={f.liquidity}
        onChange={(v) =>
          dispatch(patchInsightsFilters({ liquidity: v as InsightsFilters["liquidity"] }))
        }
      />
      <MultiSelect
        label="Confidence"
        options={CONFIDENCE_OPTIONS}
        selected={f.confidence}
        onChange={(v) =>
          dispatch(patchInsightsFilters({ confidence: v as InsightsFilters["confidence"] }))
        }
      />
      <MultiSelect
        label="Sellers"
        options={CONCENTRATION_OPTIONS}
        selected={f.concentration}
        onChange={(v) =>
          dispatch(patchInsightsFilters({ concentration: v as InsightsFilters["concentration"] }))
        }
      />
      <MultiSelect
        label="Trend"
        options={TREND_OPTIONS}
        selected={f.trend}
        width="w-28"
        onChange={(v) => dispatch(patchInsightsFilters({ trend: v as InsightsFilters["trend"] }))}
      />

      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Median/unit (gears)</Label>
        <div className="flex items-center gap-1">
          <Input
            value={f.priceMin}
            inputMode="numeric"
            placeholder="min"
            className="h-9 w-20"
            onChange={(e) => dispatch(patchInsightsFilters({ priceMin: e.target.value }))}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            value={f.priceMax}
            inputMode="numeric"
            placeholder="max"
            className="h-9 w-20"
            onChange={(e) => dispatch(patchInsightsFilters({ priceMax: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Volume</Label>
        <div className="flex items-center gap-1">
          <Input
            value={f.volumeMin}
            inputMode="numeric"
            placeholder="min"
            className="h-9 w-20"
            onChange={(e) => dispatch(patchInsightsFilters({ volumeMin: e.target.value }))}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            value={f.volumeMax}
            inputMode="numeric"
            placeholder="max"
            className="h-9 w-20"
            onChange={(e) => dispatch(patchInsightsFilters({ volumeMax: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Sell-through (%)</Label>
        <div className="flex items-center gap-1">
          <Input
            value={f.sellThroughMin}
            inputMode="numeric"
            placeholder="min"
            className="h-9 w-20"
            onChange={(e) => dispatch(patchInsightsFilters({ sellThroughMin: e.target.value }))}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            value={f.sellThroughMax}
            inputMode="numeric"
            placeholder="max"
            className="h-9 w-20"
            onChange={(e) => dispatch(patchInsightsFilters({ sellThroughMax: e.target.value }))}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer h-9">
        <Checkbox
          checked={f.favoritesOnly}
          disabled={favoritesCount === 0 && !f.favoritesOnly}
          onCheckedChange={(v) => dispatch(patchInsightsFilters({ favoritesOnly: !!v }))}
        />
        <span className="inline-flex items-center gap-1">
          <Star className="size-3.5 fill-amber-400 text-amber-400" />
          Favorites only
          {favoritesCount > 0 ? (
            <span className="text-muted-foreground">({favoritesCount})</span>
          ) : null}
        </span>
      </label>

      <label className="flex items-center gap-2 text-sm cursor-pointer h-9">
        <Checkbox
          checked={f.shortageOnly}
          onCheckedChange={(v) => dispatch(patchInsightsFilters({ shortageOnly: !!v }))}
        />
        Shortages only
      </label>

      <label className="flex items-center gap-2 text-sm cursor-pointer h-9">
        <Checkbox
          checked={f.dealsOnly}
          onCheckedChange={(v) => dispatch(patchInsightsFilters({ dealsOnly: !!v }))}
        />
        Deals available
      </label>

      <label className="flex items-center gap-2 text-sm cursor-pointer h-9">
        <Checkbox
          checked={f.upperBoundUnknownOnly}
          onCheckedChange={(v) => dispatch(patchInsightsFilters({ upperBoundUnknownOnly: !!v }))}
        />
        Unknown upper bound
      </label>

      <ExternalTradeToggle className="h-9" />

      <Button
        variant="ghost"
        size="sm"
        className="h-9 ml-auto"
        disabled={isDefaultInsightsFilters(f)}
        onClick={() => dispatch(resetInsightsFilters())}
      >
        Reset
      </Button>
    </div>
  );
}
