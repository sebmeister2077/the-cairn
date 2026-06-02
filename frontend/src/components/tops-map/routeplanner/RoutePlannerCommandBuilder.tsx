import { Check, Copy, Info, MapPin } from "lucide-react";

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

import { useTranslation } from "@/lib/i18n";
import { useEffect, useState } from "react";
import type { RouteResult } from "@/lib/tl-routing";
import { renderTemplate, routeWaypointChain } from "../RoutePlannerPanel";
import { copyTextToClipboard } from "@/lib/component-helpers/copyToClipboard";

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

export const DEFAULT_LABEL_TEMPLATE = "Route {i}/{n} ({linked_x},{linked_z})";

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

export function RoutePlannerCommandBuilder({
  primary,
  waypointCount,
  labelTemplate,
  setLabelTemplate,
  labelPreview,
}: {
  primary: RouteResult;
  waypointCount: number;
  labelTemplate: string;
  setLabelTemplate: (template: string) => void;
  labelPreview: string | null;
}) {
  const [waypointCopied, setWaypointCopied] = useState(false);
  const [waypointHelpOpen, setWaypointHelpOpen] = useState(false);
  // Waypoint-command preferences are stored in localStorage so the user's
  // chosen colour and label format persist across reloads. Reading inside
  // the initializer keeps it a one-shot — no SSR concerns in this app.
  const [waypointColor, setWaypointColor] = useState<string>(() => {
    if (typeof window === "undefined") return "purple";
    return window.localStorage.getItem(LS_COLOR_KEY) ?? "purple";
  });
  const { t } = useTranslation();

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_COLOR_KEY, waypointColor);
    } catch {
      /* quota / disabled storage — non-fatal */
    }
  }, [waypointColor]);

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

  return (
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
  );
}
