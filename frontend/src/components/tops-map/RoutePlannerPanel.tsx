import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import {
  ArrowLeftRight,
  BookmarkPlus,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  Footprints,
  Info,
  Loader2,
  MapPin,
  PawPrint,
  Plus,
  Send,
  Settings2,
  Share2,
  Sparkles,
  Trash2,
  Users,
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getMyAccountSafe, routeAnalytics, type SavedRouteLeg } from "@/lib/api";
import { buildRouteShareUrl } from "@/lib/route-share";
import { tlIdFor, useTLGroupings } from "@/lib/tl-groupings";

import { useTLRendezvous } from "@/hooks/useTLRendezvous";
import { useElkWalkable, useElkWalkableSubmit } from "@/hooks/useElkWalkable";
import {
  classifyWalkLeg,
  walkLegEdgeRef,
  type EdgeEndpointRef,
  type WalkLegElkState,
} from "@/lib/elk-walkable";
import { useAppDispatch, useAppSelector, useReduxState } from "@/store/hooks";
import {
  addRoutePlayer,
  clearRoutePlanner,
  setRendezvousObjective,
  setRouteElkFriendlyOnly,
  setRouteFocusRequest,
  setRoutePlannerMode,
  setRoutePlannerOpen,
  setRouteSelectedIndex,
  setRouteTLPenalty,
  setRouteWalkSpeed,
  swapRouteEndpoints,
  type EndpointPick,
} from "@/store/slices/routePlanner";
import {
  clearElkDraft,
  removeElkPending,
  toggleElkPendingAttest,
  toggleElkPendingUnattest,
} from "@/store/slices/elkWalkable";

import { formatDuration } from "@/lib/format-duration";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { EndpointPicker } from "./EndpointPicker";
import { PlayerPicker } from "./PlayerPicker";
import { RendezvousSection } from "./routeplanner/RendezvousSection";
import { copyTextToClipboard } from "@/lib/component-helpers/copyToClipboard";
import {
  ElkWalkableDraftSection,
  ElkWalkableSignInNotice,
} from "./routeplanner/ElkWalkableSection";
import { RouteSummary } from "./routeplanner/RouteSummary";
import { RouteDraftTLGroupingSection } from "./routeplanner/RouteDraftTLGroupingSection";
import {
  DEFAULT_LABEL_TEMPLATE,
  RoutePlannerCommandBuilder,
} from "./routeplanner/RoutePlannerCommandBuilder";
import { SaveRouteForRoadWorkersSection } from "./routeplanner/SaveRouteForRoadWorkersSection";
import type { RouteLeg, RouteResult } from "@/lib/tl-routing";

// Y coordinate used as a fallback when a TL endpoint has no recorded Y
// (user-contributed TLs only carry 2D coordinates). Seeded TLs ship
// `y1`/`y2` and are passed through directly so the in-game waypoint sits
// at the correct depth.
export const FALLBACK_WAYPOINT_Y = 110;

const LS_TEMPLATE_KEY = "routePlanner.waypointLabelTemplate";

/** Per-waypoint context exposed to label templates. */
interface WaypointContext {
  i: number;
  n: number;
  x: number;
  y: number;
  z: number;
  /** Coordinates of the OTHER end of the TL this waypoint sits on —
   *  i.e. where stepping into this TL will take the player. Same as
   *  `x`/`z` if this waypoint has no linked endpoint (shouldn't happen
   *  in practice since chain entries are only emitted for TL hops). */
  linked_x: number;
  linked_z: number;
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
export function renderTemplate(template: string, ctx: WaypointContext): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in ctx) {
      const v = (ctx as unknown as Record<string, number | string>)[key];
      return String(v);
    }
    return match;
  });
}

/** A single waypoint candidate — a TL endpoint plus the coordinates of
 *  the TL's OTHER end (so label templates can show "goes to (x,z)"). */
interface RouteWaypoint {
  x: number;
  z: number;
  y: number;
  linked_x: number;
  linked_z: number;
}

/** Collapse a route into the chain of unique waypoints worth dropping in
 *  the world: only TL endpoints (entry + exit of each TL hop). Route
 *  start and finish are intentionally excluded — the player already
 *  knows where they're standing and where they're going; what they need
 *  marked on the map are the translocators they have to find. Consecutive
 *  duplicates are dropped so a TL exit immediately followed by another
 *  TL entry at the same coords only produces one waypoint. When that
 *  collapse happens we overwrite the previous waypoint's linked endpoint
 *  with the NEXT TL's exit so the label reflects where the player will
 *  travel from this point, not where they just came from. */
export function routeWaypointChain(route: RouteResult): RouteWaypoint[] {
  const chain: RouteWaypoint[] = [];
  for (const leg of route.legs) {
    if (leg.kind !== "tl") continue;
    const seg = leg.segment;
    // Map `from`/`to` back to the seg's (x1,y1,z1)/(x2,y2,z2) pair so we
    // can pull the correct Y for each endpoint. User-contributed TLs omit
    // y1/y2 — fall back to a reasonable surface value in that case.
    const fromIs1 = seg.x1 === leg.from.x && seg.z1 === leg.from.z;
    const fromY = (fromIs1 ? seg.y1 : seg.y2) ?? FALLBACK_WAYPOINT_Y;
    const toY = (fromIs1 ? seg.y2 : seg.y1) ?? FALLBACK_WAYPOINT_Y;
    const entry: RouteWaypoint = {
      x: leg.from.x,
      z: leg.from.z,
      y: fromY,
      linked_x: leg.to.x,
      linked_z: leg.to.z,
    };
    const last = chain[chain.length - 1];
    if (!last || last.x !== entry.x || last.z !== entry.z) {
      chain.push(entry);
    } else {
      // Same physical spot — swap the previous TL's outgoing-link for this
      // new TL's so the label tells the player where THIS TL goes next.
      chain[chain.length - 1] = entry;
    }
    const exit: RouteWaypoint = {
      x: leg.to.x,
      z: leg.to.z,
      y: toY,
      linked_x: leg.from.x,
      linked_z: leg.from.z,
    };
    const prev = chain[chain.length - 1];
    if (prev.x !== exit.x || prev.z !== exit.z) {
      chain.push(exit);
    }
  }
  return chain;
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
  const { t } = useTranslation();
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
  const mode = useAppSelector((s) => s.routePlanner.mode);
  const players = useAppSelector((s) => s.routePlanner.players);
  const rendezvousObjective = useAppSelector((s) => s.routePlanner.rendezvousObjective);
  const elkFriendlyOnly = useAppSelector((s) => s.routePlanner.elkFriendlyOnly);

  // Elk-walkable: load the server snapshot once and read the local draft.
  useElkWalkable();
  const elkEdges = useAppSelector((s) => s.elkWalkable.edges);
  const elkPendingAttest = useAppSelector((s) => s.elkWalkable.pendingAttest);
  const elkPendingUnattest = useAppSelector((s) => s.elkWalkable.pendingUnattest);
  const elkSubmitStatus = useAppSelector((s) => s.elkWalkable.submit);
  const elkPendingAttestKeys = useMemo(
    () => new Set(elkPendingAttest.map((p) => p.key)),
    [elkPendingAttest],
  );
  const elkPendingUnattestKeys = useMemo(
    () => new Set(elkPendingUnattest.map((p) => p.key)),
    [elkPendingUnattest],
  );
  const elkSubmit = useElkWalkableSubmit();

  // Self user id is used to label "already confirmed by me" walk legs so
  // the user can tell their own contributions apart from the community's.
  const apiKey = useReduxState("auth.apiKey");
  const accountMeQuery = useQuery({
    queryKey: ["account-me", apiKey ?? ""],
    queryFn: getMyAccountSafe,
    staleTime: 60_000,
    retry: false,
  });
  const selfUserId = accountMeQuery.data?.user?.id ?? null;
  const isLoggedIn = Boolean(accountMeQuery.data?.user);

  // Drives the rendezvous worker; the hook is a no-op while `mode === "route"`.
  const {
    result: rendezvousResult,
    isComputing: rendezvousIsComputing,
    error: rendezvousError,
  } = useTLRendezvous();

  const [settingsOpen, setSettingsOpen] = useState(false);

  const [labelTemplate, setLabelTemplate] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_LABEL_TEMPLATE;
    return window.localStorage.getItem(LS_TEMPLATE_KEY) ?? DEFAULT_LABEL_TEMPLATE;
  });
  // Share-link feedback. Local 2s timer rather than a hook so it lines
  // up with the sibling waypoint/meeting copy indicators.
  const [shareCopied, setShareCopied] = useState(false);
  useEffect(() => {
    if (!shareCopied) return;
    const id = window.setTimeout(() => setShareCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [shareCopied]);

  async function handleCopyShareLink() {
    const url = buildRouteShareUrl({
      mode,
      from,
      to,
      walkSpeed,
      tlPenaltySeconds,
      kNeighbors,
      players,
      rendezvousObjective,
    });
    if (!url) return;
    try {
      await copyTextToClipboard(url);
      setShareCopied(true);
    } catch {
      /* clipboard blocked — silently ignore */
    }
  }

  // Whether there's anything meaningful to share for the current mode.
  const canShare = mode === "route" ? Boolean(from || to) : players.some((p) => p != null);

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
    const destLabel = to ? `(${to.point.x}, ${to.point.z})` : t("routePlanner.destinationFallback");
    const name = t("routePlanner.routeTo", { destination: destLabel });
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
      y: first.y,
      z: first.z,
      linked_x: first.linked_x,
      linked_z: first.linked_z,
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
        err instanceof Error ? err.message : t("routePlanner.analyticsErrorFallback"),
      );
    }
  }

  if (!isOpen) return null;

  return (
    <aside
      className="fixed right-3 top-3 bottom-3 z-40 flex w-[min(420px,calc(100vw-1.5rem))] flex-col gap-0 rounded-lg border bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10"
      role="dialog"
      aria-label={t("routePlanner.panelAriaLabel")}
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-base font-medium leading-none">
            <Sparkles className="h-4 w-4 text-emerald-500" />
            {t("routePlanner.title")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("routePlanner.description")}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => dispatch(setRoutePlannerOpen(false))}
          aria-label={t("routePlanner.close")}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {/* Mode tabs — toggles between solo route planning and the
            rendezvous (meeting-point) variant. The rendezvous code path
            doesn't share endpoints with route mode (separate `players`
            list), so switching modes only clears `pickMode` and lets
            each side keep its own inputs. */}
        <Tabs
          value={mode}
          onValueChange={(v) => dispatch(setRoutePlannerMode(v as "route" | "rendezvous"))}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="route" className="gap-1.5 text-xs">
              <Sparkles className="h-3 w-3" /> {t("routePlanner.routeTab")}
            </TabsTrigger>
            <TabsTrigger value="rendezvous" className="gap-1.5 text-xs">
              <Users className="h-3 w-3" /> {t("routePlanner.rendezvousTab")}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === "route" && (
          <>
            <EndpointPicker slot="from" label={t("routePlanner.from")} />

            <div className="flex items-center justify-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                onClick={() => dispatch(swapRouteEndpoints())}
                disabled={!from && !to}
                title={t("routePlanner.swapTitle")}
              >
                <ArrowLeftRight className="h-3 w-3" />
                {t("routePlanner.swap")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-red-600 hover:text-red-700"
                onClick={() => dispatch(clearRoutePlanner())}
                disabled={!hasAnyState}
                title={t("routePlanner.clearRouteTitle")}
              >
                <Trash2 className="h-3 w-3" />
                {t("routePlanner.clear")}
              </Button>
            </div>

            <EndpointPicker slot="to" label={t("routePlanner.to")} />
          </>
        )}

        {mode === "rendezvous" && (
          <RendezvousSection
            players={players}
            objective={rendezvousObjective}
            result={rendezvousResult}
            isComputing={rendezvousIsComputing}
            error={rendezvousError}
            onCopyShareLink={handleCopyShareLink}
            shareCopied={shareCopied}
            canShare={canShare}
          />
        )}

        {/* Settings popover (inline panel — kept simple to avoid pulling
            in another shadcn primitive). Sliders dispatch immediately;
            changing either clears stale routes via the slice. */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            {t("routePlanner.settingsSummary", {
              walkSpeed: walkSpeed.toFixed(1),
              penalty: tlPenaltySeconds,
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
          >
            <Settings2 className="h-3 w-3" /> {t("routePlanner.settings")}
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform duration-200",
                settingsOpen && "rotate-180",
              )}
            />
          </Button>
        </div>

        <div
          data-open={settingsOpen}
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            settingsOpen ? "grid-rows-[1fr]" : "mt-0! grid-rows-[0fr]",
          )}
          aria-hidden={!settingsOpen}
        >
          <div className="overflow-hidden">
            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              <div className="space-y-1">
                <Label className="flex items-center justify-between text-xs">
                  <span>{t("routePlanner.walkSpeed")}</span>
                  <span className="font-mono text-muted-foreground">
                    {t("routePlanner.walkSpeedValue", { value: walkSpeed.toFixed(1) })}
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
                  {t("routePlanner.walkSpeedHelp")}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="flex items-center justify-between text-xs">
                  <span>{t("routePlanner.tlPenalty")}</span>
                  <span className="font-mono text-muted-foreground">
                    {t("routePlanner.tlPenaltyValue", { value: tlPenaltySeconds })}
                  </span>
                </Label>
                <Slider
                  min={0}
                  max={60}
                  step={1}
                  value={tlPenaltySeconds}
                  onValueChange={(v) => dispatch(setRouteTLPenalty(v))}
                />
                <p className="text-[10px] text-muted-foreground">
                  {t("routePlanner.tlPenaltyHelp")}
                </p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="elk-friendly-only" className="flex items-center gap-1.5 text-xs">
                    <PawPrint className="h-3 w-3 text-emerald-600" />
                    {t("routePlanner.elk.elkFriendlyOnly")}
                  </Label>
                  <Switch
                    id="elk-friendly-only"
                    checked={elkFriendlyOnly}
                    onCheckedChange={(v) => dispatch(setRouteElkFriendlyOnly(Boolean(v)))}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t("routePlanner.elk.elkFriendlyOnlyHelp")}
                </p>
              </div>
            </div>
          </div>
        </div>

        <Separator />

        {/* Results */}
        {mode === "route" && (
          <div className="space-y-2">
            {!from || !to ? (
              <p className="text-xs text-muted-foreground">
                {t("routePlanner.setEndpointsPrompt")}
              </p>
            ) : isComputing ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t("routePlanner.computingRoutes")}
              </div>
            ) : error ? (
              <p className="text-xs text-red-600">{error}</p>
            ) : !hasRoutes ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t("routePlanner.noRouteFound")}</p>
                {elkFriendlyOnly && (
                  <div className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
                    <PawPrint className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{t("routePlanner.elk.noRouteHintElkOnly")}</span>
                  </div>
                )}
              </div>
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
                            <span>{t("routePlanner.routeAlternative", { index: i + 1 })}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {i === 0
                                ? t("routePlanner.best")
                                : t("routePlanner.deltaDuration", {
                                    duration: formatDuration(deltas[i]),
                                  })}
                            </span>
                          </span>
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                )}

                {primary && (
                  <RouteSummary
                    route={primary}
                    onLocate={(p) => dispatch(setRouteFocusRequest(p))}
                    elk={
                      isLoggedIn
                        ? {
                            edges: elkEdges,
                            pendingAttestKeys: elkPendingAttestKeys,
                            pendingUnattestKeys: elkPendingUnattestKeys,
                            selfUserId,
                            // Dispatch attest vs unattest based on the leg's
                            // current state. "confirmed-by-me" and
                            // "pending-unattest" target the unattest list so
                            // the user can actually remove their own
                            // confirmation; everything else toggles attest.
                            onToggle: (a, b, state) => {
                              if (state === "confirmed-by-me" || state === "pending-unattest") {
                                dispatch(toggleElkPendingUnattest({ a, b }));
                              } else {
                                dispatch(toggleElkPendingAttest({ a, b }));
                              }
                            },
                          }
                        : undefined
                    }
                  />
                )}

                {primary && isLoggedIn && (
                  <ElkWalkableDraftSection
                    route={primary}
                    edges={elkEdges}
                    pendingAttest={elkPendingAttest}
                    pendingUnattest={elkPendingUnattest}
                    submitStatus={elkSubmitStatus}
                    canSubmit={elkSubmit.canSubmit}
                    onSubmit={() => elkSubmit.submit()}
                    onClear={() => dispatch(clearElkDraft())}
                    onRemove={(key) => dispatch(removeElkPending(key))}
                  />
                )}

                {primary && !isLoggedIn && <ElkWalkableSignInNotice route={primary} />}

                {/* Save-as-draft action: turns the current route's TLs into
                  a fresh TL grouping the user can rename / tweak in the
                  Groupings drawer. Disabled for walk-only routes since a
                  grouping with zero TLs would be meaningless.
                  Share button sits beside it so both "keep this route"
                  affordances live in the same row. */}
                {primary && (
                  <RouteDraftTLGroupingSection
                    primary={primary}
                    handleSaveAsDraft={handleSaveAsDraft}
                    handleCopyShareLink={handleCopyShareLink}
                    canShare={canShare}
                    shareCopied={shareCopied}
                    savedDraft={savedDraft}
                  />
                )}

                {/* Waypoint-command builder: generate the `/waypoint addati`
                  commands a player can paste into chat to drop one
                  waypoint per step in this route. Colour + label format
                  persist in localStorage (see effects above). */}
                {primary && waypointCount > 0 && (
                  <RoutePlannerCommandBuilder
                    primary={primary}
                    waypointCount={waypointCount}
                    labelTemplate={labelTemplate}
                    setLabelTemplate={setLabelTemplate}
                    labelPreview={labelPreview}
                  />
                )}

                {/* "Why only a few green TLs?" — explain that the highlight
                  intentionally shows ONLY the TLs on the chosen route.
                  Surfaces the most common point of confusion right where
                  the user sees the result. */}
                <div className="flex items-start gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{t("routePlanner.usedTlsOnlyNotice")}</span>
                </div>

                {/* "Save this route for road workers" — anonymous analytics
                  ping that helps the map's road maintainers prioritise
                  tunnel work, signage, and shortcuts. No personal data
                  is sent (only the endpoints, the TL chain, and the
                  travel time of this single route). */}
                {primary && (
                  <SaveRouteForRoadWorkersSection
                    analyticsState={analyticsState}
                    analyticsError={analyticsError}
                    handleSaveForRoadWorkers={handleSaveForRoadWorkers}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
