import { Check, Copy, Crosshair, Info, Loader2, Plus, Share2, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RendezvousObjective, RendezvousResult } from "@/lib/tl-routing";
import { useAppDispatch } from "@/store/hooks";
import {
  addRoutePlayer,
  clearRoutePlanner,
  setRendezvousObjective,
  setRouteFocusRequest,
  type EndpointPick,
} from "@/store/slices/routePlanner";

import { formatDuration } from "@/lib/format-duration";
import { useTranslation } from "@/lib/i18n";

import { copyTextToClipboard } from "@/lib/component-helpers/copyToClipboard";
import { PlayerPicker } from "../PlayerPicker";
import { FALLBACK_WAYPOINT_Y } from "../RoutePlannerPanel";

type TranslateFn = ReturnType<typeof useTranslation>["t"];

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
export function RendezvousSection({
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
