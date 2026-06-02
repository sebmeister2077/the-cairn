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
import type {
  RendezvousObjective,
  RendezvousResult,
  RouteLeg,
  RouteResult,
} from "@/lib/tl-routing";
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

type TranslateFn = ReturnType<typeof useTranslation>["t"];

/** Format a leg row as a single readable line. */
function describeLeg(leg: RouteLeg, index: number, t: TranslateFn): string {
  if (leg.kind === "walk") {
    const baseSeconds = leg.seconds - (leg.penaltySeconds ?? 0);
    return t("routePlanner.walkLeg", {
      index: index + 1,
      blocks: Math.round(leg.blocks),
      duration: formatDuration(baseSeconds),
    });
  }
  // Show the TL ENTRY (the endpoint the player walks to and may have to
  // dig down to), not the exit. The exit is reached automatically once
  // they step in, and the entry's depth is what tells them how far
  // below the surface the TL sits. `y1`/`y2` only exist for seeded
  // geojson TLs — user-contributed ones omit them.
  const seg = leg.segment;
  let entryY: number | undefined;
  if (seg.x1 === leg.from.x && seg.z1 === leg.from.z) {
    entryY = seg.y1;
  } else if (seg.x2 === leg.from.x && seg.z2 === leg.from.z) {
    entryY = seg.y2;
  }
  if (typeof entryY === "number") {
    return t("routePlanner.tlLegWithY", {
      index: index + 1,
      x: leg.from.x,
      y: entryY,
      z: leg.from.z,
      duration: formatDuration(leg.seconds),
    });
  }
  return t("routePlanner.tlLeg", {
    index: index + 1,
    x: leg.from.x,
    z: leg.from.z,
    duration: formatDuration(leg.seconds),
  });
}

// Y coordinate used as a fallback when a TL endpoint has no recorded Y
// (user-contributed TLs only carry 2D coordinates). Seeded TLs ship
// `y1`/`y2` and are passed through directly so the in-game waypoint sits
// at the correct depth.
const FALLBACK_WAYPOINT_Y = 110;

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
const DEFAULT_LABEL_TEMPLATE = "Route {i}/{n} ({linked_x},{linked_z})";

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
function renderTemplate(template: string, ctx: WaypointContext): string {
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
function routeWaypointChain(route: RouteResult): RouteWaypoint[] {
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
        y: p.y,
        z: p.z,
        linked_x: p.linked_x,
        linked_z: p.linked_z,
        next_x: next ? next.x : "",
        next_z: next ? next.z : "",
        prev_x: prev ? prev.x : "",
        prev_z: prev ? prev.z : "",
        dest_x: dest.x,
        dest_z: dest.z,
        start_x: start.x,
        start_z: start.z,
      }).trim() || `Route ${i + 1}/${chain.length}`;
    lines.push(`/waypoint addati spiral ${p.x} ${p.y} ${p.z} false ${color} ${label}`);
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

                {/* Save-as-draft action: turns the current route's TLs into
                  a fresh TL grouping the user can rename / tweak in the
                  Groupings drawer. Disabled for walk-only routes since a
                  grouping with zero TLs would be meaningless.
                  Share button sits beside it so both "keep this route"
                  affordances live in the same row. */}
                {primary && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 gap-1.5"
                        onClick={handleSaveAsDraft}
                        disabled={primary.tlHops === 0}
                        title={
                          primary.tlHops === 0
                            ? t("routePlanner.saveDraftNoTls")
                            : t("routePlanner.saveDraftTitle")
                        }
                      >
                        <BookmarkPlus className="h-3.5 w-3.5" />
                        {t("routePlanner.saveDraftButton")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 gap-1.5"
                        onClick={handleCopyShareLink}
                        disabled={!canShare}
                        title={
                          canShare
                            ? t("routePlanner.shareRouteTitle")
                            : t("routePlanner.shareNothingToShare")
                        }
                      >
                        {shareCopied ? (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            {t("routePlanner.copiedShareLink")}
                          </>
                        ) : (
                          <>
                            <Share2 className="h-3.5 w-3.5" />
                            {t("routePlanner.shareRoute")}
                          </>
                        )}
                      </Button>
                    </div>
                    {savedDraft && (
                      <p className="flex items-center gap-1 px-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                        <Check className="h-3 w-3" />
                        {t("routePlanner.savedAs", { name: savedDraft.name })}
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
                        {t("routePlanner.waypointSectionTitle")}
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {t("routePlanner.waypointCount", { count: waypointCount })}
                      </span>
                    </div>

                    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
                      <Label htmlFor="wp-color" className="text-[11px]">
                        {t("routePlanner.color")}
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
                        {t("routePlanner.label")}
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
                        {t("routePlanner.labelPreview")}{" "}
                        <span className="font-mono text-foreground">{labelPreview}</span>
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
                            {t("routePlanner.copiedCommands", { count: waypointCount })}
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            {t("routePlanner.copyCommands", { count: waypointCount })}
                          </>
                        )}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title={t("routePlanner.showLabelPlaceholders")}
                        aria-label={t("routePlanner.showLabelPlaceholders")}
                        onClick={() => setWaypointHelpOpen((v) => !v)}
                      >
                        <Info className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    {waypointHelpOpen && (
                      <div className="space-y-1 rounded border bg-background/60 p-2 text-[10px] leading-snug text-muted-foreground">
                        <p>{t("routePlanner.placeholderHelpIntro")}</p>
                        <ul className="grid grid-cols-2 gap-x-2 font-mono text-foreground">
                          <li>{t("routePlanner.placeholderStepNumber", { token: "{i}" })}</li>
                          <li>{t("routePlanner.placeholderTotalSteps", { token: "{n}" })}</li>
                          <li>{t("routePlanner.placeholderThisX", { token: "{x}" })}</li>
                          <li>{t("routePlanner.placeholderThisZ", { token: "{z}" })}</li>
                          <li>{t("routePlanner.placeholderFixedY", { token: "{y}" })}</li>
                          <li>{t("routePlanner.placeholderLinkedX", { token: "{linked_x}" })}</li>
                          <li>{t("routePlanner.placeholderLinkedZ", { token: "{linked_z}" })}</li>
                          <li>{t("routePlanner.placeholderNextX", { token: "{next_x}" })}</li>
                          <li>{t("routePlanner.placeholderNextZ", { token: "{next_z}" })}</li>
                          <li>{t("routePlanner.placeholderPrevX", { token: "{prev_x}" })}</li>
                          <li>{t("routePlanner.placeholderPrevZ", { token: "{prev_z}" })}</li>
                          <li>{t("routePlanner.placeholderDestX", { token: "{dest_x}" })}</li>
                          <li>{t("routePlanner.placeholderDestZ", { token: "{dest_z}" })}</li>
                          <li>{t("routePlanner.placeholderStartX", { token: "{start_x}" })}</li>
                          <li>{t("routePlanner.placeholderStartZ", { token: "{start_z}" })}</li>
                        </ul>
                        <p>
                          {t("routePlanner.placeholderHelpFooter", {
                            prev: "{prev_*}",
                            next: "{next_*}",
                          })}
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
                  <span>{t("routePlanner.usedTlsOnlyNotice")}</span>
                </div>

                {/* "Save this route for road workers" — anonymous analytics
                  ping that helps the map's road maintainers prioritise
                  tunnel work, signage, and shortcuts. No personal data
                  is sent (only the endpoints, the TL chain, and the
                  travel time of this single route). */}
                {primary && (
                  <div className="space-y-1 rounded-md border border-sky-200 bg-sky-50 p-2 dark:border-sky-900/50 dark:bg-sky-950/40">
                    <p className="text-[11px] leading-snug text-sky-900 dark:text-sky-100">
                      {t("routePlanner.analyticsInfo")}
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
                        ? t("routePlanner.analyticsSending")
                        : analyticsState === "sent"
                          ? t("routePlanner.analyticsSent")
                          : t("routePlanner.analyticsSave")}
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
        )}
      </div>
    </aside>
  );
}

/** Per-walk-leg attestation controls accepted by {@link RouteSummary}. */
interface ElkRouteSummaryProps {
  edges: Record<string, import("@/lib/elk-walkable").ElkWalkableEdge>;
  pendingAttestKeys: ReadonlySet<string>;
  pendingUnattestKeys: ReadonlySet<string>;
  selfUserId: string | null;
  onToggle: (a: EdgeEndpointRef, b: EdgeEndpointRef, state: WalkLegElkState) => void;
}

/** Tailwind classes per elk state — keeps the per-leg row styling in one
 *  place so the legend and the walk rows agree on colour. */
const ELK_STATE_ROW_CLASSES: Record<WalkLegElkState, string> = {
  "not-attestable": "flex items-center gap-1 px-2 py-1 text-muted-foreground",
  unconfirmed: "flex items-center gap-1 rounded px-2 py-1 text-muted-foreground",
  confirmed:
    "flex items-center gap-1 rounded bg-sky-50 px-2 py-1 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100",
  "confirmed-by-me":
    "flex items-center gap-1 rounded bg-sky-100 px-2 py-1 text-sky-900 dark:bg-sky-900/60 dark:text-sky-50",
  "pending-attest":
    "flex items-center gap-1 rounded bg-amber-50 px-2 py-1 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
  "pending-unattest":
    "flex items-center gap-1 rounded bg-red-50 px-2 py-1 text-red-900 line-through decoration-red-700/60 dark:bg-red-950/40 dark:text-red-100",
};

/** Summary card for a single `RouteResult`: totals + per-leg list. */
function RouteSummary({
  route,
  onLocate,
  elk,
}: {
  route: RouteResult;
  /** Called when the user clicks a leg's locate button. Receives the
   *  world-space point the map should fly to, plus an optional
   *  `spanBlocks` so the viewer can pick a zoom that keeps both leg
   *  endpoints in frame for long TL hops / walks. */
  onLocate: (point: { x: number; z: number; spanBlocks?: number }) => void;
  /** Optional elk-walkable attestation hooks. When omitted (e.g. anon
   *  user, contributions disabled), walk rows render with the legacy
   *  muted-foreground style and no toggle. */
  elk?: ElkRouteSummaryProps;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      {/* Hero ETA — the headline answer to "how long will this take?".
          Kept visually dominant so the user sees the total time first,
          before scanning per-leg details. When the route includes
          unverified elk walks we render a range `best – worst` instead
          of pretending the penalty is a certainty. */}
      <div className="flex items-baseline justify-between gap-2 border-b pb-2">
        <div className="flex flex-col leading-none">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("routePlanner.estimatedTime")}
          </span>
          <span className="mt-1 flex items-baseline gap-1.5 font-mono text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
            <Sparkles className="h-4 w-4 self-center text-emerald-500" />
            {route.uncertainSeconds > 0
              ? t("routePlanner.estimatedTimeRange", {
                  best: formatDuration(route.totalSeconds - route.uncertainSeconds),
                  worst: formatDuration(route.totalSeconds),
                })
              : formatDuration(route.totalSeconds)}
          </span>
          {route.uncertainSeconds > 0 && (
            <span className="mt-1 text-[10px] italic text-muted-foreground">
              {t("routePlanner.estimatedTimeRangeCaption")}
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Footprints className="h-3 w-3" />
            {t("routePlanner.walkBlocks", { count: Math.round(route.walkBlocks) })}
          </span>
          <span>{t("routePlanner.tlHops", { count: route.tlHops })}</span>
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
          // Resolve walk-leg → elk edge ref (null when between Start/Dest
          // and a TL, or when surrounding TLs lack stable ids). Drives
          // the row colour AND whether the elk toggle button renders.
          const edgeRef = leg.kind === "walk" && elk ? walkLegEdgeRef(route.legs, i) : null;
          const elkState: WalkLegElkState =
            leg.kind === "walk" && elk
              ? classifyWalkLeg(
                  edgeRef,
                  elk.edges,
                  elk.pendingAttestKeys,
                  elk.pendingUnattestKeys,
                  elk.selfUserId,
                )
              : "not-attestable";
          const rowClass =
            leg.kind === "tl"
              ? "flex items-center gap-1 rounded bg-emerald-50 px-2 py-1 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
              : ELK_STATE_ROW_CLASSES[elkState];
          return (
            <li key={i} className={rowClass}>
              <span className="flex-1 truncate">{describeLeg(leg, i, t)}</span>
              {leg.kind === "walk" && leg.penaltySeconds ? (
                <span
                  className="shrink-0 whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/60 dark:text-amber-50"
                  title={t("routePlanner.estimatedTimeRangeCaption")}
                >
                  {t("routePlanner.walkLegUnverifiedExtra", {
                    duration: formatDuration(leg.penaltySeconds),
                  })}
                </span>
              ) : null}
              {leg.kind === "walk" && edgeRef && elk && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 text-current opacity-80 hover:opacity-100"
                  onClick={() => elk.onToggle(edgeRef.a, edgeRef.b, elkState)}
                  title={
                    elkState === "pending-attest"
                      ? t("routePlanner.elk.cancelAttest")
                      : elkState === "pending-unattest"
                        ? t("routePlanner.elk.cancelUnattest")
                        : elkState === "confirmed-by-me"
                          ? t("routePlanner.elk.removeAttestation")
                          : elkState === "confirmed"
                            ? t("routePlanner.elk.addAttestation")
                            : t("routePlanner.elk.markElkWalkable")
                  }
                  aria-label={t("routePlanner.elk.markElkWalkable")}
                >
                  <PawPrint className="h-3 w-3" />
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-6 w-6 shrink-0 text-current opacity-70 hover:opacity-100"
                onClick={() => onLocate({ x: midX, z: midZ, spanBlocks })}
                title={
                  leg.kind === "tl"
                    ? t("routePlanner.showTlPairOnMap")
                    : t("routePlanner.showWalkSegmentOnMap")
                }
                aria-label={t("routePlanner.showOnMap")}
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

/**
 * Draft + submission UI for the user's pending elk-walkable contributions.
 * Hidden entirely when the user has nothing pending AND the active route
 * has no attestable walk legs (i.e. the feature would just be visual
 * noise).
 */
function ElkWalkableDraftSection({
  route,
  edges,
  pendingAttest,
  pendingUnattest,
  submitStatus,
  canSubmit,
  onSubmit,
  onClear,
  onRemove,
}: {
  route: RouteResult;
  edges: Record<string, import("@/lib/elk-walkable").ElkWalkableEdge>;
  pendingAttest: import("@/lib/elk-walkable").PendingEdgeChange[];
  pendingUnattest: import("@/lib/elk-walkable").PendingEdgeChange[];
  submitStatus: import("@/store/slices/elkWalkable").SubmitStatus;
  canSubmit: boolean;
  onSubmit: () => void;
  onClear: () => void;
  onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();

  // How many of the current route's walk legs are even attestable? If
  // zero AND the draft is empty, hide the section entirely so it doesn't
  // clutter the panel for routes that consist solely of TLs or
  // start/dest walks.
  const hasAttestableLeg = useMemo(() => {
    for (let i = 0; i < route.legs.length; i++) {
      if (route.legs[i].kind !== "walk") continue;
      if (walkLegEdgeRef(route.legs, i)) return true;
    }
    return false;
  }, [route.legs]);

  // Friendlier confirmed count — only this route's edges.
  const confirmedInRoute = useMemo(() => {
    let n = 0;
    for (let i = 0; i < route.legs.length; i++) {
      if (route.legs[i].kind !== "walk") continue;
      const ref = walkLegEdgeRef(route.legs, i);
      if (ref && edges[ref.key]) n++;
    }
    return n;
  }, [route.legs, edges]);

  const pendingCount = pendingAttest.length + pendingUnattest.length;

  // Expanded by default whenever the user has pending items so they can
  // see/manage their draft without an extra click. Otherwise start
  // collapsed — the section is informational at that point and would
  // just take up vertical space on a route the user already understands.
  const [expanded, setExpanded] = useState(pendingCount > 0);

  // Auto-expand the moment a pending item appears (e.g. the user clicked
  // the paw button on a walk leg). We don't auto-collapse when the draft
  // empties because the user might have manually opened the section to
  // read the legend / explanation.
  useEffect(() => {
    if (pendingCount > 0) setExpanded(true);
  }, [pendingCount]);

  if (!hasAttestableLeg && pendingCount === 0) return null;

  const summaryText =
    pendingCount > 0
      ? t("routePlanner.elk.pendingCount", { count: pendingCount })
      : t("routePlanner.elk.confirmedInRoute", { count: confirmedInRoute });

  return (
    <div className="rounded-md border bg-muted/30">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <PawPrint className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        <span className="flex-1 text-xs font-medium">{t("routePlanner.elk.sectionTitle")}</span>
        <span className="text-[10px] text-muted-foreground">{summaryText}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-180",
          )}
        />
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden">
          <div className="space-y-2 border-t px-2 pb-2 pt-2">
            {/* Plain-language intro so first-time users understand what
                the section is for before being shown a legend full of
                colour codes. */}
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("routePlanner.elk.sectionIntro")}{" "}
              <NavLink
                to="/blog/contributing-elk-walkable-roads"
                className="underline decoration-dotted underline-offset-2 hover:text-primary"
              >
                {t("routePlanner.elk.readGuide")}
              </NavLink>
              .
            </p>

            {/* Legend — same colour vocabulary as the per-leg row backgrounds. */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-sky-400" />
                {t("routePlanner.elk.legendConfirmed")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                {t("routePlanner.elk.legendPendingAttest")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" />
                {t("routePlanner.elk.legendUnconfirmed")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
                {t("routePlanner.elk.legendPendingUnattest")}
              </span>
            </div>

            {pendingCount > 0 ? (
              <ul className="space-y-0.5 text-[11px]">
                {pendingAttest.map((p) => (
                  <li
                    key={`a:${p.key}`}
                    className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                  >
                    <span className="flex-1 truncate font-mono">
                      {t("routePlanner.elk.draftItemAttest", {
                        a: `${p.a.tl_id}#${p.a.ep}`,
                        b: `${p.b.tl_id}#${p.b.ep}`,
                      })}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="h-5 w-5 shrink-0 text-current opacity-70 hover:opacity-100"
                      onClick={() => onRemove(p.key)}
                      aria-label={t("routePlanner.elk.removeDraft")}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </li>
                ))}
                {pendingUnattest.map((p) => (
                  <li
                    key={`u:${p.key}`}
                    className="flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-red-900 dark:bg-red-950/40 dark:text-red-100"
                  >
                    <span className="flex-1 truncate font-mono">
                      {t("routePlanner.elk.draftItemUnattest", {
                        a: `${p.a.tl_id}#${p.a.ep}`,
                        b: `${p.b.tl_id}#${p.b.ep}`,
                      })}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="h-5 w-5 shrink-0 text-current opacity-70 hover:opacity-100"
                      onClick={() => onRemove(p.key)}
                      aria-label={t("routePlanner.elk.removeDraft")}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {t("routePlanner.elk.draftEmpty")}
              </p>
            )}

            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="default"
                className="flex-1 gap-1.5"
                disabled={!canSubmit || submitStatus.kind === "submitting"}
                onClick={() => onSubmit()}
              >
                {submitStatus.kind === "submitting" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : submitStatus.kind === "success" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {submitStatus.kind === "submitting"
                  ? t("routePlanner.elk.submittingStatus")
                  : t("routePlanner.elk.submitButton")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={pendingCount === 0 || submitStatus.kind === "submitting"}
                onClick={() => onClear()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("routePlanner.elk.clearButton")}
              </Button>
            </div>

            {submitStatus.kind === "success" && (
              <p className="text-[10px] text-emerald-700 dark:text-emerald-400">
                {t("routePlanner.elk.submitSuccess", { count: submitStatus.appliedCount })}
              </p>
            )}
            {submitStatus.kind === "error" && (
              <p className="text-[10px] text-red-600 dark:text-red-400">
                {t("routePlanner.elk.submitError", { message: submitStatus.message })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Format `Player N` or the original label depending on what the picker
 *  recorded — keeps the per-player ETA list short while still
 *  surfacing whatever the user actually typed in. */
function playerDisplayLabel(p: EndpointPick | null, index: number, t: TranslateFn): string {
  if (!p) return t("routePlanner.playerLabel", { index: index + 1 });
  if (p.label && p.label !== `${p.point.x}, ${p.point.z}`) return p.label;
  return t("routePlanner.playerLabel", { index: index + 1 });
}

/**
 * Rendezvous-mode body. Owns:
 *   - dynamic list of `PlayerPicker` slots (2–8)
 *   - objective toggle (minimax vs minisum)
 *   - meeting-point summary card with per-player ETAs and a focus button
 *   - a single `/waypoint addati` line for the meeting point that the
 *     whole party can paste into chat
 */
function RendezvousSection({
  players,
  objective,
  result,
  isComputing,
  error,
  onCopyShareLink,
  shareCopied,
  canShare,
}: {
  players: Array<EndpointPick | null>;
  objective: RendezvousObjective;
  result: RendezvousResult | null;
  isComputing: boolean;
  error: string | null;
  onCopyShareLink: () => void;
  shareCopied: boolean;
  canShare: boolean;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const filledCount = players.filter((p) => p != null).length;
  const canAdd = players.length < 8;
  const [meetingCopied, setMeetingCopied] = useState(false);

  // Reset the "copied" indicator when the meeting point changes so the
  // checkmark doesn't lie about which point the clipboard holds.
  useEffect(() => {
    setMeetingCopied(false);
  }, [result?.meeting.x, result?.meeting.z]);

  async function handleCopyMeetingWaypoint() {
    if (!result) return;
    const { x, z } = result.meeting;
    const cmd = `/waypoint addati x ${x} ${FALLBACK_WAYPOINT_Y} ${z} true blue ${t("routePlanner.meetingPoint")}`;
    try {
      await copyTextToClipboard(cmd);
      setMeetingCopied(true);
    } catch {
      /* clipboard blocked — silently ignore */
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("routePlanner.rendezvousIntro")}
      </p>

      <div className="space-y-2">
        {players.map((_p, i) => (
          <PlayerPicker key={i} index={i} />
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => dispatch(addRoutePlayer())}
          disabled={!canAdd}
          title={canAdd ? t("routePlanner.addPlayerTitle") : t("routePlanner.maxPlayers")}
        >
          <Plus className="h-3 w-3" /> {t("routePlanner.addPlayer")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs text-red-600 hover:text-red-700"
          onClick={() => dispatch(clearRoutePlanner())}
          title={t("routePlanner.clearPlayersTitle")}
        >
          <Trash2 className="h-3 w-3" /> {t("routePlanner.clear")}
        </Button>
      </div>

      {/* Objective picker — segmented control over a dropdown so both
          options stay visible (only two, and the trade-off matters), and
          a short caption below spells out exactly what the planner will
          optimise for. Avoids the dropdown showing the raw enum value. */}
      <div className="space-y-1">
        <Label className="text-xs">{t("routePlanner.optimizeFor")}</Label>
        <Tabs
          value={objective}
          onValueChange={(v) => v && dispatch(setRendezvousObjective(v as RendezvousObjective))}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="minimax" className="text-xs">
              {t("routePlanner.fairness")}
            </TabsTrigger>
            <TabsTrigger value="minisum" className="text-xs">
              {t("routePlanner.totalTime")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {objective === "minimax"
            ? t("routePlanner.objectiveFairness")
            : t("routePlanner.objectiveTotalTime")}
        </p>
      </div>

      <Separator />

      {/* Results */}
      <div className="space-y-2">
        {filledCount < 2 ? (
          <p className="text-xs text-muted-foreground">{t("routePlanner.atLeastTwoPlayers")}</p>
        ) : isComputing ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {t("routePlanner.findingMeetingPoint")}
          </div>
        ) : error ? (
          <p className="text-xs text-red-600">{error}</p>
        ) : !result ? (
          <p className="text-xs text-muted-foreground">{t("routePlanner.noMeetingPointFound")}</p>
        ) : (
          <>
            <div className="space-y-2 rounded-md border bg-background p-3">
              <div className="flex items-baseline justify-between gap-2 border-b pb-2">
                <div className="flex flex-col leading-none">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("routePlanner.everyonesThereBy")}
                  </span>
                  <span className="mt-1 flex items-baseline gap-1.5 font-mono text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                    <Users className="h-4 w-4 self-center text-emerald-500" />
                    {formatDuration(result.worstSeconds)}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1 text-[10px] text-muted-foreground">
                  <span>
                    {t("routePlanner.totalDuration", {
                      duration: formatDuration(result.totalSeconds),
                    })}
                  </span>
                  <span>
                    {t("routePlanner.meetingAt", { x: result.meeting.x, z: result.meeting.z })}
                  </span>
                </div>
              </div>

              <Button
                size="sm"
                variant="ghost"
                className="w-full gap-1.5"
                onClick={() =>
                  dispatch(
                    setRouteFocusRequest({
                      x: result.meeting.x,
                      z: result.meeting.z,
                      spanBlocks: 400,
                    }),
                  )
                }
              >
                <Crosshair className="h-3.5 w-3.5" /> {t("routePlanner.showMeetingPointOnMap")}
              </Button>

              <ol className="space-y-0.5 text-xs">
                {result.perPlayer.map((leg, i) => {
                  // Map each per-player result back to whatever label the
                  // picker recorded (e.g. "Favorite home"). Position
                  // order in `result.perPlayer` matches the filtered
                  // (non-null) `players` order.
                  const filled = players.filter((p): p is EndpointPick => p != null);
                  const label = playerDisplayLabel(filled[i] ?? null, i, t);
                  const midX = Math.round((leg.player.x + result.meeting.x) / 2);
                  const midZ = Math.round((leg.player.z + result.meeting.z) / 2);
                  const dx = result.meeting.x - leg.player.x;
                  const dz = result.meeting.z - leg.player.z;
                  const span = Math.max(200, Math.hypot(dx, dz) * 1.4);
                  return (
                    <li key={i} className="flex items-center gap-1 px-2 py-1 text-muted-foreground">
                      <span className="flex-1 truncate">
                        <span className="font-medium text-foreground">
                          {t("routePlanner.playerRouteDuration", {
                            label,
                            duration: formatDuration(leg.route.totalSeconds),
                          })}
                        </span>
                        {leg.route.tlHops > 0 && (
                          <span className="ml-1 text-[10px]">
                            ({t("routePlanner.tlHops", { count: leg.route.tlHops })})
                          </span>
                        )}
                      </span>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="h-6 w-6 shrink-0 opacity-70 hover:opacity-100"
                        onClick={() =>
                          dispatch(setRouteFocusRequest({ x: midX, z: midZ, spanBlocks: span }))
                        }
                        title={t("routePlanner.showPlayerRouteOnMap")}
                        aria-label={t("routePlanner.showOnMap")}
                      >
                        <Crosshair className="h-3 w-3" />
                      </Button>
                    </li>
                  );
                })}
              </ol>
            </div>

            <Button
              size="sm"
              variant="default"
              className="w-full gap-1.5"
              onClick={handleCopyMeetingWaypoint}
            >
              {meetingCopied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {t("routePlanner.copiedMeetingWaypoint")}
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  {t("routePlanner.copyMeetingWaypoint")}
                </>
              )}
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1.5"
              onClick={onCopyShareLink}
              disabled={!canShare}
              title={t("routePlanner.shareRendezvousTitle")}
            >
              {shareCopied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {t("routePlanner.copiedShareLink")}
                </>
              ) : (
                <>
                  <Share2 className="h-3.5 w-3.5" />
                  {t("routePlanner.shareRendezvous")}
                </>
              )}
            </Button>

            <div className="flex items-start gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{t("routePlanner.meetingTlsNotice")}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
