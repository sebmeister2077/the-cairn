import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate } from "react-router-dom";
import {
  ArrowLeftRight,
  BookmarkPlus,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  Flag,
  Footprints,
  Info,
  Loader2,
  MapPin,
  PawPrint,
  Pickaxe,
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
import { buildTunnelToolPath, type Block3 } from "@/lib/tunnel-share";
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
import { ReportElkEdgeDialog } from "./ReportElkEdgeDialog";
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
import { FALLBACK_WAYPOINT_Y } from "../RoutePlannerPanel";

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

type TranslateFn = ReturnType<typeof useTranslation>["t"];

/** Tunnel endpoints derived from the TL legs immediately before and
 *  after a walk leg sandwiched between two TLs. Y is taken from the
 *  matching `segment.y1`/`y2` (orientation-aware), falling back to
 *  `FALLBACK_WAYPOINT_Y` when the seeded depth is missing.
 *
 *  Returns null when the walk leg isn't between two TLs (e.g. the
 *  trailing walk to the destination, or the leading walk from the
 *  start) since we have no reliable Y in that case. */
function tunnelEndpointsForWalk(
  legs: ReadonlyArray<RouteLeg>,
  i: number,
): { from: Block3; to: Block3 } | null {
  const leg = legs[i];
  if (!leg || leg.kind !== "walk") return null;
  const prev = legs[i - 1];
  const next = legs[i + 1];
  if (!prev || prev.kind !== "tl") return null;
  if (!next || next.kind !== "tl") return null;

  const prevSeg = prev.segment;
  const nextSeg = next.segment;
  // The walk *starts* at the prev TL's exit (= prev.to). Match against
  // the segment's two endpoints so we read the right Y.
  const fromY =
    prevSeg.x1 === prev.to.x && prevSeg.z1 === prev.to.z
      ? (prevSeg.y1 ?? FALLBACK_WAYPOINT_Y)
      : prevSeg.x2 === prev.to.x && prevSeg.z2 === prev.to.z
        ? (prevSeg.y2 ?? FALLBACK_WAYPOINT_Y)
        : FALLBACK_WAYPOINT_Y;
  // The walk *ends* at the next TL's entry (= next.from).
  const toY =
    nextSeg.x1 === next.from.x && nextSeg.z1 === next.from.z
      ? (nextSeg.y1 ?? FALLBACK_WAYPOINT_Y)
      : nextSeg.x2 === next.from.x && nextSeg.z2 === next.from.z
        ? (nextSeg.y2 ?? FALLBACK_WAYPOINT_Y)
        : FALLBACK_WAYPOINT_Y;
  return {
    from: { x: leg.from.x, y: fromY, z: leg.from.z },
    to: { x: leg.to.x, y: toY, z: leg.to.z },
  };
}

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

/** Summary card for a single `RouteResult`: totals + per-leg list. */
export function RouteSummary({
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
  const navigate = useNavigate();

  // Report-this-edge dialog: only rendered when the user clicks the
  // Flag button on a confirmed walk row. State lives at the summary
  // level so the dialog survives leg-list re-renders.
  const [reportEdge, setReportEdge] = useState<{ key: string; label: string } | null>(null);

  // Track the last leg the user zoomed to so we can softly pulse that
  // row — long routes scroll out of view and users forget which entry
  // they just located. Reset when the underlying route changes so the
  // highlight never refers to a leg from a stale alternative.
  const [locatedIndex, setLocatedIndex] = useState<number | null>(null);
  useEffect(() => {
    setLocatedIndex(null);
  }, [route]);

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
          // For walks sandwiched between two TLs, derive 3D endpoints
          // (with seeded Y when available) for the tunnel-builder tool.
          const tunnelEndpoints =
            leg.kind === "walk" ? tunnelEndpointsForWalk(route.legs, i) : null;
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
            <li key={i} className={cn(rowClass, locatedIndex === i && "route-leg-located")}>
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
              {leg.kind === "walk" &&
                edgeRef &&
                elk &&
                (elkState === "confirmed" || elkState === "confirmed-by-me") && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 text-current opacity-70 hover:opacity-100"
                    onClick={() =>
                      setReportEdge({ key: edgeRef.key, label: describeLeg(leg, i, t) })
                    }
                    title={t("topsMap.reportElkEdge.title")}
                    aria-label={t("topsMap.reportElkEdge.title")}
                  >
                    <Flag className="h-3 w-3" />
                  </Button>
                )}
              {tunnelEndpoints && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 text-current opacity-70 hover:opacity-100"
                  onClick={() =>
                    navigate(buildTunnelToolPath(tunnelEndpoints.from, tunnelEndpoints.to))
                  }
                  title={t("routePlanner.openTunnelTool")}
                  aria-label={t("routePlanner.openTunnelToolAria")}
                >
                  <Pickaxe className="h-3 w-3" />
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-6 w-6 shrink-0 text-current opacity-70 hover:opacity-100"
                onClick={() => {
                  setLocatedIndex(i);
                  onLocate({ x: midX, z: midZ, spanBlocks });
                }}
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

      <ReportElkEdgeDialog
        open={reportEdge != null}
        onOpenChange={(v) => {
          if (!v) setReportEdge(null);
        }}
        edgeKey={reportEdge?.key ?? null}
        edgeLabel={reportEdge?.label}
      />
    </div>
  );
}
