import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  BookmarkPlus,
  Check,
  Copy,
  Crosshair,
  Footprints,
  Info,
  Loader2,
  MapPin,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { routeAnalytics, type SavedRouteLeg } from "@/lib/api";
import { tlIdFor, useTLGroupings } from "@/lib/tl-groupings";
import type { RouteLeg, RouteResult } from "@/lib/tl-routing";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  clearRoutePlanner,
  setRouteFocusRequest,
  setRoutePlannerOpen,
  setRouteSelectedIndex,
  setRouteTLPenalty,
  setRouteWalkSpeed,
  swapRouteEndpoints,
} from "@/store/slices/routePlanner";

import { formatDuration } from "@/lib/format-duration";

import { EndpointPicker } from "./EndpointPicker";

/** Format a leg row as a single readable line. */
function describeLeg(leg: RouteLeg, index: number): string {
  if (leg.kind === "walk") {
    return `${index + 1}. Walk ${Math.round(leg.blocks)} blocks (${formatDuration(leg.seconds)})`;
  }
  return `${index + 1}. TL → (${leg.to.x}, ${leg.to.z}) — ${formatDuration(leg.seconds)}`;
}

// Y coordinate baked into generated /waypoint commands. Tops-map endpoints
// are 2D, so we pin Y to a reasonable surface value — players can drag the
// waypoint in-game if it lands inside a hill.
const WAYPOINT_Y = 110;

// Curated palette of CSS colour names that VS's /waypoint command renders
// nicely on the in-game map. Hex inputs also work in-game, but a fixed
// list keeps the picker honest and avoids "why is my pink invisible?".
const WAYPOINT_COLORS = [
  "purple",
  "red",
  "orange",
  "yellow",
  "lime",
  "green",
  "cyan",
  "blue",
  "magenta",
  "pink",
  "brown",
  "white",
  "gray",
  "black",
] as const;

const LS_COLOR_KEY = "routePlanner.waypointColor";
const LS_TEMPLATE_KEY = "routePlanner.waypointLabelTemplate";
const DEFAULT_LABEL_TEMPLATE = "Route {i}/{n} ({x},{z})";

/** Per-waypoint context exposed to label templates. */
interface WaypointContext {
  i: number;
  n: number;
  x: number;
  y: number;
  z: number;
  next_x: number | "";
  next_z: number | "";
  prev_x: number | "";
  prev_z: number | "";
  dest_x: number;
  dest_z: number;
  start_x: number;
  start_z: number;
}

/** Substitute `{placeholder}` tokens in a template, leaving unknown tokens
 *  in place so the user gets a visible hint that they mistyped. */
function renderTemplate(template: string, ctx: WaypointContext): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in ctx) {
      const v = (ctx as unknown as Record<string, number | string>)[key];
      return String(v);
    }
    return match;
  });
}

/** Collapse a route into the chain of unique waypoints worth dropping in
 *  the world: only TL endpoints (entry + exit of each TL hop). Route
 *  start and finish are intentionally excluded — the player already
 *  knows where they're standing and where they're going; what they need
 *  marked on the map are the translocators they have to find. Consecutive
 *  duplicates are dropped so a TL exit immediately followed by another
 *  TL entry at the same coords only produces one waypoint. */
function routeWaypointChain(route: RouteResult): Array<{ x: number; z: number }> {
  const chain: Array<{ x: number; z: number }> = [];
  for (const leg of route.legs) {
    if (leg.kind !== "tl") continue;
    const entry = { x: leg.from.x, z: leg.from.z };
    const last = chain[chain.length - 1];
    if (!last || last.x !== entry.x || last.z !== entry.z) {
      chain.push(entry);
    }
    const exit = { x: leg.to.x, z: leg.to.z };
    const prev = chain[chain.length - 1];
    if (prev.x !== exit.x || prev.z !== exit.z) {
      chain.push(exit);
    }
  }
  return chain;
}

/** Build the multi-line `/waypoint addati` payload the user copies. */
function buildRouteWaypointCommands(route: RouteResult, color: string, template: string): string {
  const chain = routeWaypointChain(route);
  if (chain.length === 0) return "";
  const dest = chain[chain.length - 1];
  const start = chain[0];
  const lines: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    const prev = i > 0 ? chain[i - 1] : null;
    const next = i < chain.length - 1 ? chain[i + 1] : null;
    const label =
      renderTemplate(template, {
        i: i + 1,
        n: chain.length,
        x: p.x,
        y: WAYPOINT_Y,
        z: p.z,
        next_x: next ? next.x : "",
        next_z: next ? next.z : "",
        prev_x: prev ? prev.x : "",
        prev_z: prev ? prev.z : "",
        dest_x: dest.x,
        dest_z: dest.z,
        start_x: start.x,
        start_z: start.z,
      }).trim() || `Route ${i + 1}/${chain.length}`;
    lines.push(`/waypoint addati spiral ${p.x} ${WAYPOINT_Y} ${p.z} false ${color} ${label}`);
  }
  return lines.join("\n");
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for non-secure contexts / older browsers.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
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
  const kNeighbors = useAppSelector((s) => s.routePlanner.kNeighbors);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Waypoint-command preferences are stored in localStorage so the user's
  // chosen colour and label format persist across reloads. Reading inside
  // the initializer keeps it a one-shot — no SSR concerns in this app.
  const [waypointColor, setWaypointColor] = useState<string>(() => {
    if (typeof window === "undefined") return "purple";
    return window.localStorage.getItem(LS_COLOR_KEY) ?? "purple";
  });
  const [labelTemplate, setLabelTemplate] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_LABEL_TEMPLATE;
    return window.localStorage.getItem(LS_TEMPLATE_KEY) ?? DEFAULT_LABEL_TEMPLATE;
  });
  const [waypointCopied, setWaypointCopied] = useState(false);
  const [waypointHelpOpen, setWaypointHelpOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_COLOR_KEY, waypointColor);
    } catch {
      /* quota / disabled storage — non-fatal */
    }
  }, [waypointColor]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_TEMPLATE_KEY, labelTemplate);
    } catch {
      /* quota / disabled storage — non-fatal */
    }
  }, [labelTemplate]);

  // Track the most recently-saved draft grouping so we can show a brief
  // confirmation row beneath the route. Reset whenever the underlying
  // route changes so the success state never goes stale and lies about
  // what the button would currently save.
  const { createGrouping } = useTLGroupings();
  const [savedDraft, setSavedDraft] = useState<{ id: string; name: string } | null>(null);

  // "Save this route for road workers" — sends just the displayed route
  // (endpoints + TL chain + cost numbers) to the analytics endpoint so
  // the map's road maintainers can prioritise tunnel work / signage.
  // No personal data is sent.
  const [analyticsState, setAnalyticsState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

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

  // Clear the "saved" confirmation whenever the displayed route changes —
  // either a different alternate was picked or the planner recomputed. We
  // key on the route reference (and selectedIndex) rather than on a
  // timer so the confirmation stays visible until the user actually moves
  // on.
  //
  // The waypoint-copy indicator is INTENTIONALLY not reset here: the
  // user typically alt-tabs into the game to paste the command, and a
  // disappearing checkmark makes it impossible to remember whether the
  // copy already happened. The indicator persists until the panel
  // unmounts (closing the planner, page reload, etc.).
  useEffect(() => {
    setSavedDraft(null);
    setAnalyticsState("idle");
    setAnalyticsError(null);
  }, [routes, selectedIndex]);

  // Reset the "Sent — thanks!" confirmation after a short cooldown so
  // the row stops shouting at the user but the button itself stays
  // disabled to prevent a double-tap re-send.
  useEffect(() => {
    if (analyticsState !== "sent") return;
    const t = window.setTimeout(() => setAnalyticsState("idle"), 4000);
    return () => window.clearTimeout(t);
  }, [analyticsState]);

  function handleSaveAsDraft() {
    if (!primary) return;
    const tlIds = primary.legs
      .filter((l): l is Extract<RouteLeg, { kind: "tl" }> => l.kind === "tl")
      // Use `tlIdFor(segment)` — NOT the route leg's pre-normalised `tlId`
      // — because groupings match against the map's raw segment
      // orientation. Mixing the two would silently break the highlight.
      .map((l) => tlIdFor(l.segment));
    const destLabel = to ? `(${to.point.x}, ${to.point.z})` : "destination";
    const name = `Route to ${destLabel}`;
    const grouping = createGrouping(name, { tlIds });
    setSavedDraft({ id: grouping.id, name: grouping.name });
  }

  // Preview the rendered first label so the user can sanity-check their
  // template without having to copy + paste into the game.
  const labelPreview = useMemo(() => {
    if (!primary) return null;
    const chain = routeWaypointChain(primary);
    if (chain.length === 0) return null;
    const first = chain[0];
    const next = chain[1] ?? null;
    const dest = chain[chain.length - 1];
    return renderTemplate(labelTemplate, {
      i: 1,
      n: chain.length,
      x: first.x,
      y: WAYPOINT_Y,
      z: first.z,
      next_x: next ? next.x : "",
      next_z: next ? next.z : "",
      prev_x: "",
      prev_z: "",
      dest_x: dest.x,
      dest_z: dest.z,
      start_x: first.x,
      start_z: first.z,
    });
  }, [primary, labelTemplate]);

  const waypointCount = primary ? routeWaypointChain(primary).length : 0;

  async function handleCopyWaypointCommands() {
    if (!primary) return;
    const text = buildRouteWaypointCommands(primary, waypointColor, labelTemplate);
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      setWaypointCopied(true);
    } catch {
      /* clipboard blocked — silently ignore, matches sibling components */
    }
  }

  async function handleSaveForRoadWorkers() {
    if (!primary || !from || !to) return;
    setAnalyticsState("sending");
    setAnalyticsError(null);
    try {
      const legs: SavedRouteLeg[] = primary.legs.map((leg) =>
        leg.kind === "walk"
          ? {
              kind: "walk",
              from: { x: leg.from.x, z: leg.from.z },
              to: { x: leg.to.x, z: leg.to.z },
              seconds: leg.seconds,
              blocks: leg.blocks,
            }
          : {
              kind: "tl",
              from: { x: leg.from.x, z: leg.from.z },
              to: { x: leg.to.x, z: leg.to.z },
              seconds: leg.seconds,
              tlId: leg.tlId,
            },
      );
      await routeAnalytics.save({
        from: { x: from.point.x, z: from.point.z },
        to: { x: to.point.x, z: to.point.z },
        from_label: from.label ?? null,
        to_label: to.label ?? null,
        legs,
        total_seconds: primary.totalSeconds,
        walk_blocks: primary.walkBlocks,
        tl_hops: primary.tlHops,
        walk_speed: walkSpeed,
        tl_penalty_seconds: tlPenaltySeconds,
        k_neighbors: kNeighbors,
      });
      setAnalyticsState("sent");
    } catch (err) {
      setAnalyticsState("error");
      setAnalyticsError(
        err instanceof Error ? err.message : "Could not send route. Please try again.",
      );
    }
  }

  if (!isOpen) return null;

  return (
    <aside
      className="fixed right-3 top-3 bottom-3 z-40 flex w-[min(420px,calc(100vw-1.5rem))] flex-col gap-0 rounded-lg border bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10"
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
                Default 7 (sprint on road). Change based on your needs (elk or no path heavy armor
                journey).
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
                Fixed time cost per hop (charge-up, possible ladder climbing).
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

              {primary && (
                <RouteSummary route={primary} onLocate={(p) => dispatch(setRouteFocusRequest(p))} />
              )}

              {/* Save-as-draft action: turns the current route's TLs into
                  a fresh TL grouping the user can rename / tweak in the
                  Groupings drawer. Disabled for walk-only routes since a
                  grouping with zero TLs would be meaningless. */}
              {primary && (
                <div className="space-y-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1.5"
                    onClick={handleSaveAsDraft}
                    disabled={primary.tlHops === 0}
                    title={
                      primary.tlHops === 0
                        ? "This route has no translocators to save"
                        : "Create a new draft grouping containing this route's TLs"
                    }
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    Save as draft grouping
                  </Button>
                  {savedDraft && (
                    <p className="flex items-center gap-1 px-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                      <Check className="h-3 w-3" />
                      Saved as <span className="font-medium">{savedDraft.name}</span>. Open the
                      Groupings drawer to edit.
                    </p>
                  )}
                </div>
              )}

              {/* Waypoint-command builder: generate the `/waypoint addati`
                  commands a player can paste into chat to drop one
                  waypoint per step in this route. Colour + label format
                  persist in localStorage (see effects above). */}
              {primary && waypointCount > 0 && (
                <div className="space-y-2 rounded-md border bg-muted/30 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <MapPin className="h-3.5 w-3.5 text-purple-500" />
                      Copy /waypoint commands
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {waypointCount} waypoint{waypointCount === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
                    <Label htmlFor="wp-color" className="text-[11px]">
                      Color
                    </Label>
                    <Select value={waypointColor} onValueChange={(v) => v && setWaypointColor(v)}>
                      <SelectTrigger id="wp-color" className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WAYPOINT_COLORS.map((c) => (
                          <SelectItem key={c} value={c} className="text-xs">
                            <span className="flex items-center gap-2">
                              <span
                                className="inline-block h-3 w-3 rounded-full border border-foreground/20"
                                style={{ backgroundColor: c }}
                              />
                              {c}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Label htmlFor="wp-template" className="text-[11px]">
                      Label
                    </Label>
                    <Input
                      id="wp-template"
                      value={labelTemplate}
                      onChange={(e) => setLabelTemplate(e.target.value)}
                      placeholder={DEFAULT_LABEL_TEMPLATE}
                      className="h-7 text-xs font-mono"
                      spellCheck={false}
                    />
                  </div>

                  {labelPreview && (
                    <p className="truncate px-1 text-[10px] text-muted-foreground">
                      Preview: <span className="font-mono text-foreground">{labelPreview}</span>
                    </p>
                  )}

                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="default"
                      className="flex-1 gap-1.5"
                      onClick={handleCopyWaypointCommands}
                    >
                      {waypointCopied ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          Copied {waypointCount} command{waypointCount === 1 ? "" : "s"}
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          Copy {waypointCount} /waypoint command{waypointCount === 1 ? "" : "s"}
                        </>
                      )}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Show available label placeholders"
                      aria-label="Show available label placeholders"
                      onClick={() => setWaypointHelpOpen((v) => !v)}
                    >
                      <Info className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  {waypointHelpOpen && (
                    <div className="space-y-1 rounded border bg-background/60 p-2 text-[10px] leading-snug text-muted-foreground">
                      <p>
                        Use any of these placeholders in the label — unknown ones are left untouched
                        so typos are easy to spot:
                      </p>
                      <ul className="grid grid-cols-2 gap-x-2 font-mono text-foreground">
                        <li>{"{i}"} step #</li>
                        <li>{"{n}"} total steps</li>
                        <li>{"{x}"} this X</li>
                        <li>{"{z}"} this Z</li>
                        <li>
                          {"{y}"} fixed {WAYPOINT_Y}
                        </li>
                        <li>{"{next_x}"} next X</li>
                        <li>{"{next_z}"} next Z</li>
                        <li>{"{prev_x}"} prev X</li>
                        <li>{"{prev_z}"} prev Z</li>
                        <li>{"{dest_x}"} dest X</li>
                        <li>{"{dest_z}"} dest Z</li>
                        <li>{"{start_x}"} start X</li>
                        <li>{"{start_z}"} start Z</li>
                      </ul>
                      <p>
                        Y is fixed at {WAYPOINT_Y} since the tops map is 2D. The first and last
                        waypoints leave <span className="font-mono">{"{prev_*}"}</span> /{" "}
                        <span className="font-mono">{"{next_*}"}</span> empty respectively.
                      </p>
                    </div>
                  )}
                </div>
              )}

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

              {/* "Save this route for road workers" — anonymous analytics
                  ping that helps the map's road maintainers prioritise
                  tunnel work, signage, and shortcuts. No personal data
                  is sent (only the endpoints, the TL chain, and the
                  travel time of this single route). */}
              {primary && (
                <div className="space-y-1 rounded-md border border-sky-200 bg-sky-50 p-2 dark:border-sky-900/50 dark:bg-sky-950/40">
                  <p className="text-[11px] leading-snug text-sky-900 dark:text-sky-100">
                    Saving sends just this route (endpoints, TL hops, travel time) to the map's road
                    maintainers so they can prioritise tunnel work, signage, and shortcuts. No
                    personal data is sent.
                  </p>
                  <Button
                    size="sm"
                    variant="default"
                    className="w-full gap-1.5"
                    onClick={handleSaveForRoadWorkers}
                    disabled={analyticsState === "sending" || analyticsState === "sent"}
                  >
                    {analyticsState === "sending" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : analyticsState === "sent" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    {analyticsState === "sending"
                      ? "Sending…"
                      : analyticsState === "sent"
                        ? "Sent — thanks!"
                        : "Save this route for road workers"}
                  </Button>
                  {analyticsState === "error" && analyticsError && (
                    <p className="px-1 text-[11px] text-red-600 dark:text-red-400">
                      {analyticsError}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Summary card for a single `RouteResult`: totals + per-leg list. */
function RouteSummary({
  route,
  onLocate,
}: {
  route: RouteResult;
  /** Called when the user clicks a leg's locate button. Receives the
   *  world-space point the map should fly to, plus an optional
   *  `spanBlocks` so the viewer can pick a zoom that keeps both leg
   *  endpoints in frame for long TL hops / walks. */
  onLocate: (point: { x: number; z: number; spanBlocks?: number }) => void;
}) {
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
        {route.legs.map((leg, i) => {
          // Aim the camera at the leg's midpoint and report a span the
          // viewer can use to fit both endpoints in view. We pad the raw
          // endpoint distance by ~40% so the leg doesn't kiss the edges,
          // and floor at a small value so trivially-short walks/TLs still
          // get a reasonably close-in zoom rather than over-shooting it.
          const midX = Math.round((leg.from.x + leg.to.x) / 2);
          const midZ = Math.round((leg.from.z + leg.to.z) / 2);
          const dx = leg.to.x - leg.from.x;
          const dz = leg.to.z - leg.from.z;
          const legDistance = Math.hypot(dx, dz);
          const spanBlocks = Math.max(80, legDistance * 1.4);
          return (
            <li
              key={i}
              className={
                leg.kind === "tl"
                  ? "flex items-center gap-1 rounded bg-emerald-50 px-2 py-1 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
                  : "flex items-center gap-1 px-2 py-1 text-muted-foreground"
              }
            >
              <span className="flex-1 truncate">{describeLeg(leg, i)}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-6 w-6 shrink-0 text-current opacity-70 hover:opacity-100"
                onClick={() => onLocate({ x: midX, z: midZ, spanBlocks })}
                title={
                  leg.kind === "tl"
                    ? `Show this TL pair on the map`
                    : `Show this walk segment on the map`
                }
                aria-label="Show on map"
              >
                <Crosshair className="h-3 w-3" />
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
