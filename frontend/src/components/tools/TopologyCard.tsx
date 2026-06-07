// Topology + cost-metric controls. Drives `solveHub` / `solveTour`
// in the parent. For `pairs` topology with ≥3 endpoints, also exposes
// per-pair toggles so the user can drop unwanted edges.

import { useMemo } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n";
import {
  COST_METRICS,
  MULTI_TUNNEL_SOFT_CAP,
  TOPOLOGIES,
  pairwiseEdgeKeys,
  type CostMetric,
  type EdgeKey,
  type TLEndpoint,
  type Topology,
} from "@/lib/tunnel-multi";
import type { Block3 } from "@/lib/tunnel-share";

import { BlockEditor } from "./BlockEditor";

interface TopologyCardProps {
  endpoints: TLEndpoint[];
  topology: Topology;
  costMetric: CostMetric;
  enabledPairs: ReadonlySet<EdgeKey>;
  junction: Block3 | null;
  /** When non-null, the hub is locked at this user-picked coordinate.
   *  When null, `junction` reflects the optimiser's solution. */
  hubOverride: Block3 | null;
  tourOrder: ReadonlyArray<string> | null;
  onChangeTopology: (next: Topology) => void;
  onChangeCostMetric: (next: CostMetric) => void;
  onTogglePair: (key: EdgeKey) => void;
  onEnableAllPairs: () => void;
  onChangeHubOverride: (next: Block3 | null) => void;
}

export function TopologyCard({
  endpoints,
  topology,
  costMetric,
  enabledPairs,
  junction,
  hubOverride,
  tourOrder,
  onChangeTopology,
  onChangeCostMetric,
  onTogglePair,
  onEnableAllPairs,
  onChangeHubOverride,
}: TopologyCardProps) {
  const { t } = useTranslation();
  const byId = useMemo(() => new Map(endpoints.map((e) => [e.id, e])), [endpoints]);

  const overCap = endpoints.length > MULTI_TUNNEL_SOFT_CAP;
  const showApproxBanner = overCap && (topology === "hub" || topology === "tour");

  const labelOf = (ep: TLEndpoint, idx: number) =>
    ep.label?.trim() || t("tools.tunnel.endpointDefaultLabel", { index: idx + 1 });

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <h2 className="text-sm font-semibold">{t("tools.tunnel.sectionTopology")}</h2>

      <fieldset className="space-y-1">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("tools.tunnel.topologyLabel")}
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {TOPOLOGIES.map((tp) => (
            <label
              key={tp}
              className="flex cursor-pointer items-center justify-center gap-1 rounded border bg-background px-2 py-1.5 text-xs hover:bg-muted has-checked:border-primary has-checked:bg-primary/10"
            >
              <input
                type="radio"
                name="tunnel-topology"
                value={tp}
                checked={topology === tp}
                onChange={() => onChangeTopology(tp)}
                className="sr-only"
              />
              <span className="font-medium">{t(`tools.tunnel.topologies.${tp}`)}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] h-8 text-muted-foreground">
          {t(`tools.tunnel.topologyHints.${topology}`)}
        </p>
      </fieldset>

      <div className="space-y-1">
        <Label
          htmlFor="tunnel-cost-metric"
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {t("tools.tunnel.costMetricLabel")}
        </Label>
        <Select value={costMetric} onValueChange={(v) => onChangeCostMetric(v as CostMetric)}>
          <SelectTrigger id="tunnel-cost-metric" size="sm" className="w-full">
            <SelectValue>{t(`tools.tunnel.costMetrics.${costMetric}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {COST_METRICS.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`tools.tunnel.costMetrics.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">
          {t(`tools.tunnel.costMetricHints.${costMetric}`)}
        </p>
      </div>

      {showApproxBanner && (
        <div className="rounded border border-amber-500/30 bg-amber-50/80 px-2 py-1.5 text-[10px] text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
          {t("tools.tunnel.approximationBanner", { cap: MULTI_TUNNEL_SOFT_CAP })}
        </div>
      )}

      {topology === "hub" && (
        <div className="space-y-2 rounded border bg-muted/30 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("tools.tunnel.junctionLabel")}
            </span>
            {hubOverride == null ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                <Sparkles className="h-2.5 w-2.5" />
                {t("tools.tunnel.junctionAuto")}
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChangeHubOverride(null)}
                className="h-6 px-2 text-[10px]"
              >
                <Sparkles className="mr-1 h-2.5 w-2.5" />
                {t("tools.tunnel.junctionResetAuto")}
              </Button>
            )}
          </div>
          {junction ? (
            <>
              <BlockEditor
                idPrefix="tunnel-hub"
                label=""
                value={junction}
                onChange={(next) => onChangeHubOverride(next)}
              />
              <p className="text-[10px] text-muted-foreground">
                {hubOverride == null
                  ? t("tools.tunnel.junctionHintAuto")
                  : t("tools.tunnel.junctionHintManual")}
              </p>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">{t("tools.tunnel.junctionNone")}</div>
          )}
        </div>
      )}

      {topology === "tour" && tourOrder && tourOrder.length > 0 && (
        <div className="space-y-1 rounded border bg-muted/30 p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("tools.tunnel.tourOrderLabel")}
          </div>
          <ol className="space-y-0.5 text-xs">
            {tourOrder.map((id, i) => {
              const ep = byId.get(id);
              if (!ep) return null;
              const idx = endpoints.findIndex((e) => e.id === id);
              return (
                <li key={id} className="flex items-center gap-1.5">
                  <span className="font-mono text-muted-foreground">{i + 1}.</span>
                  <span className="font-medium">{labelOf(ep, idx)}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    ({ep.coord.x}, {ep.coord.y}, {ep.coord.z})
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {topology === "pairs" && endpoints.length >= 3 && (
        <PairToggles
          endpoints={endpoints}
          enabledPairs={enabledPairs}
          onTogglePair={onTogglePair}
          onEnableAllPairs={onEnableAllPairs}
          labelOf={labelOf}
        />
      )}
    </div>
  );
}

interface PairTogglesProps {
  endpoints: TLEndpoint[];
  enabledPairs: ReadonlySet<EdgeKey>;
  onTogglePair: (key: EdgeKey) => void;
  onEnableAllPairs: () => void;
  labelOf: (ep: TLEndpoint, idx: number) => string;
}

function PairToggles({
  endpoints,
  enabledPairs,
  onTogglePair,
  onEnableAllPairs,
  labelOf,
}: PairTogglesProps) {
  const { t } = useTranslation();
  const byId = useMemo(() => new Map(endpoints.map((e) => [e.id, e])), [endpoints]);
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    endpoints.forEach((e, i) => m.set(e.id, i));
    return m;
  }, [endpoints]);

  const allKeys = useMemo(() => pairwiseEdgeKeys(endpoints), [endpoints]);
  const allEnabled = allKeys.length > 0 && allKeys.every((k) => enabledPairs.has(k));

  return (
    <div className="space-y-1.5 rounded border bg-muted/30 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("tools.tunnel.pairTogglesLabel")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onEnableAllPairs}
          disabled={allEnabled}
          className="h-6 px-2 text-[10px]"
        >
          {t("tools.tunnel.pairTogglesEnableAll")}
        </Button>
      </div>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {allKeys.map((k) => {
          const [a, b] = k.split("|");
          const epA = byId.get(a);
          const epB = byId.get(b);
          if (!epA || !epB) return null;
          const aLabel = labelOf(epA, indexById.get(a) ?? 0);
          const bLabel = labelOf(epB, indexById.get(b) ?? 0);
          const checked = enabledPairs.has(k);
          return (
            <li key={k}>
              <label className="flex cursor-pointer items-center gap-1.5 rounded border bg-background px-2 py-1 text-xs hover:bg-muted">
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => onTogglePair(k)}
                  className="h-3.5 w-3.5"
                />
                <span className="truncate">
                  {aLabel} ↔ {bLabel}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
