import { Check, ChevronDown, Loader2, PawPrint, Send, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { walkLegEdgeRef } from "@/lib/elk-walkable";
import type { RouteResult } from "@/lib/tl-routing";

import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Draft + submission UI for the user's pending elk-walkable contributions.
 * Hidden entirely when the user has nothing pending AND the active route
 * has no attestable walk legs (i.e. the feature would just be visual
 * noise).
 */
export function ElkWalkableDraftSection({
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

/**
 * Sign-in CTA shown to anonymous users in place of the elk-walkable
 * draft section, but only when the active route actually has walk legs
 * an account holder could attest. Keeps the planner panel quiet for
 * pure-TL routes where the feature wouldn't apply anyway.
 */
export function ElkWalkableSignInNotice({ route }: { route: RouteResult }) {
  const { t } = useTranslation();
  const hasAttestableLeg = useMemo(() => {
    for (let i = 0; i < route.legs.length; i++) {
      if (route.legs[i].kind !== "walk") continue;
      if (walkLegEdgeRef(route.legs, i)) return true;
    }
    return false;
  }, [route.legs]);

  if (!hasAttestableLeg) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100">
      <PawPrint className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="flex-1 space-y-1">
        <p className="leading-snug">{t("routePlanner.elk.signInNotice")}</p>
        <NavLink
          to="/account"
          className="inline-block font-medium underline decoration-dotted underline-offset-2 hover:text-emerald-700 dark:hover:text-emerald-200"
        >
          {t("routePlanner.elk.signInCta")}
        </NavLink>
      </div>
    </div>
  );
}
