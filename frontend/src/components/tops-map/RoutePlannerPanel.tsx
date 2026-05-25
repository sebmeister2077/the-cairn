import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  Footprints,
  Info,
  Loader2,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RouteLeg, RouteResult } from "@/lib/tl-routing";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  clearRoutePlanner,
  setRoutePlannerOpen,
  setRouteSelectedIndex,
  setRouteTLPenalty,
  setRouteWalkSpeed,
  swapRouteEndpoints,
} from "@/store/slices/routePlanner";

import { EndpointPicker } from "./EndpointPicker";

/** Format seconds as a compact "Xm Ys" string (mins dropped when 0). */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

/** Format a leg row as a single readable line. */
function describeLeg(leg: RouteLeg, index: number): string {
  if (leg.kind === "walk") {
    return `${index + 1}. Walk ${Math.round(leg.blocks)} blocks (${formatDuration(leg.seconds)})`;
  }
  return `${index + 1}. TL → (${leg.to.x}, ${leg.to.z}) — ${formatDuration(leg.seconds)}`;
}

/**
 * Right-anchored floating panel that hosts the full route-planner UX.
 *
 * Deliberately NOT built on the Sheet primitive: Sheet renders a modal
 * backdrop that swallows clicks on the underlying map, which breaks the
 * "Pick on map" interaction. Instead we render a plain absolute-positioned
 * aside so the map stays fully interactive while the panel is open.
 */
export function RoutePlannerPanel() {
  const dispatch = useAppDispatch();
  const isOpen = useAppSelector((s) => s.routePlanner.isOpen);
  const from = useAppSelector((s) => s.routePlanner.from);
  const to = useAppSelector((s) => s.routePlanner.to);
  const routes = useAppSelector((s) => s.routePlanner.routes);
  const selectedIndex = useAppSelector((s) => s.routePlanner.selectedIndex);
  const isComputing = useAppSelector((s) => s.routePlanner.isComputing);
  const error = useAppSelector((s) => s.routePlanner.error);
  const walkSpeed = useAppSelector((s) => s.routePlanner.walkSpeed);
  const tlPenaltySeconds = useAppSelector((s) => s.routePlanner.tlPenaltySeconds);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Stable "primary route exists" flag used in many sub-conditions below.
  const hasRoutes = routes.length > 0;
  const primary: RouteResult | null = hasRoutes ? (routes[selectedIndex] ?? routes[0]) : null;
  const hasAnyState = Boolean(from || to || hasRoutes);

  // Cost delta vs the cheapest alternative — surfaced on each tab so the
  // user can see "+12s" / "+1m 5s" at a glance.
  const deltas = useMemo(() => {
    if (routes.length === 0) return [] as number[];
    const best = routes[0].totalSeconds;
    return routes.map((r) => r.totalSeconds - best);
  }, [routes]);

  if (!isOpen) return null;

  return (
    <aside
      className="fixed right-3 top-3 bottom-3 z-40 flex w-[min(380px,calc(100vw-1.5rem))] flex-col gap-0 rounded-lg border bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10"
      role="dialog"
      aria-label="Route planner"
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-base font-medium leading-none">
            <Sparkles className="h-4 w-4 text-emerald-500" />
            Route planner
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick a start and a destination; the planner finds the fastest translocator chain.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => dispatch(setRoutePlannerOpen(false))}
          aria-label="Close route planner"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <EndpointPicker slot="from" label="From" />

        <div className="flex items-center justify-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={() => dispatch(swapRouteEndpoints())}
            disabled={!from && !to}
            title="Swap From / To"
          >
            <ArrowLeftRight className="h-3 w-3" />
            Swap
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs text-red-600 hover:text-red-700"
            onClick={() => dispatch(clearRoutePlanner())}
            disabled={!hasAnyState}
            title="Clear From, To, and the computed route"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </Button>
        </div>

        <EndpointPicker slot="to" label="To" />

        {/* Settings popover (inline panel — kept simple to avoid pulling
            in another shadcn primitive). Sliders dispatch immediately;
            changing either clears stale routes via the slice. */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            Walk {walkSpeed.toFixed(1)} b/s · TL penalty {tlPenaltySeconds}s
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Settings2 className="h-3 w-3" /> Settings
          </Button>
        </div>

        {settingsOpen && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-3">
            <div className="space-y-1">
              <Label className="flex items-center justify-between text-xs">
                <span>Walk speed</span>
                <span className="font-mono text-muted-foreground">
                  {walkSpeed.toFixed(1)} blocks/s
                </span>
              </Label>
              <Slider
                min={1}
                max={15}
                step={0.5}
                value={walkSpeed}
                onValueChange={(v) => dispatch(setRouteWalkSpeed(v))}
              />
              <p className="text-[10px] text-muted-foreground">
                Default 6 (sprint). Lower if you usually walk loaded.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="flex items-center justify-between text-xs">
                <span>TL penalty</span>
                <span className="font-mono text-muted-foreground">{tlPenaltySeconds}s</span>
              </Label>
              <Slider
                min={0}
                max={60}
                step={1}
                value={tlPenaltySeconds}
                onValueChange={(v) => dispatch(setRouteTLPenalty(v))}
              />
              <p className="text-[10px] text-muted-foreground">
                Fixed time cost per hop (charge-up, render, fall-in).
              </p>
            </div>
          </div>
        )}

        <Separator />

        {/* Results */}
        <div className="space-y-2">
          {!from || !to ? (
            <p className="text-xs text-muted-foreground">Set both endpoints to compute a route.</p>
          ) : isComputing ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Computing routes…
            </div>
          ) : error ? (
            <p className="text-xs text-red-600">{error}</p>
          ) : !hasRoutes ? (
            <p className="text-xs text-muted-foreground">No route found.</p>
          ) : (
            <>
              {/* Alternate-route tabs — only show when more than one. */}
              {routes.length > 1 && (
                <Tabs
                  value={String(selectedIndex)}
                  onValueChange={(v) => dispatch(setRouteSelectedIndex(Number(v)))}
                >
                  <TabsList
                    className="grid w-full"
                    style={{
                      gridTemplateColumns: `repeat(${routes.length}, minmax(0, 1fr))`,
                    }}
                  >
                    {routes.map((r, i) => (
                      <TabsTrigger key={i} value={String(i)} className="text-xs">
                        <span className="flex flex-col leading-tight">
                          <span>#{i + 1}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {i === 0 ? "best" : `+${formatDuration(deltas[i])}`}
                          </span>
                        </span>
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}

              {primary && <RouteSummary route={primary} />}

              {/* "Why only a few green TLs?" — explain that the highlight
                  intentionally shows ONLY the TLs on the chosen route.
                  Surfaces the most common point of confusion right where
                  the user sees the result. */}
              <div className="flex items-start gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  Only the translocators used by this route are highlighted in green. All other TLs
                  stay in their normal colours.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Summary card for a single `RouteResult`: totals + per-leg list. */
function RouteSummary({ route }: { route: RouteResult }) {
  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      {/* Hero ETA — the headline answer to "how long will this take?".
          Kept visually dominant so the user sees the total time first,
          before scanning per-leg details. */}
      <div className="flex items-baseline justify-between gap-2 border-b pb-2">
        <div className="flex flex-col leading-none">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Estimated time
          </span>
          <span className="mt-1 flex items-baseline gap-1.5 font-mono text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
            <Sparkles className="h-4 w-4 self-center text-emerald-500" />
            {formatDuration(route.totalSeconds)}
          </span>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Footprints className="h-3 w-3" />
            {Math.round(route.walkBlocks)} blocks
          </span>
          <span>
            {route.tlHops} TL{route.tlHops === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <ol className="space-y-0.5 text-xs">
        {route.legs.map((leg, i) => (
          <li
            key={i}
            className={
              leg.kind === "tl"
                ? "rounded bg-emerald-50 px-2 py-1 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
                : "px-2 py-1 text-muted-foreground"
            }
          >
            {describeLeg(leg, i)}
          </li>
        ))}
      </ol>
    </div>
  );
}
