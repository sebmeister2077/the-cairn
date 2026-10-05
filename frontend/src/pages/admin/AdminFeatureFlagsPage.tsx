/**
 * Admin: Feature Flags page (route: /manage/feature-flags).
 *
 * Hosts the operational kill switches — maintenance_mode, uploads_enabled,
 * registration_enabled — with rich descriptions so the on-call admin
 * understands the blast radius before flipping anything. Less critical
 * product flags are listed below as a single read/write table.
 *
 * For the longer reference, see ../../docs/users/feature-flags.md.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDateFormat } from "@/hooks/useDateFormat";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Info,
  Loader2,
  Lock,
  Power,
  RefreshCw,
  Unlock,
  Upload,
  UserPlus,
  Wrench,
  Archive,
} from "lucide-react";
import {
  adminForceReleaseMapLock,
  adminGetHeavyComputeStatus,
  adminGetMapLock,
  adminListFeatureFlags,
  adminRunHeavyComputeNow,
  adminSetFeatureFlag,
  type FeatureFlag,
  type HeavyComputeStatus,
} from "@/lib/api";
import { CompressionSettingsPanel } from "@/components/admin/CompressionSettingsPanel";
import { RegionOverwriteSettingsPanel } from "@/components/admin/RegionOverwriteSettingsPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { QUOTA_FLAGS, QuotaFlagRow } from "@/components/admin/feature-flags/AdminQuotaFlagRow";
import { MapLockCard } from "@/components/admin/feature-flags/MapLockCard";
import {
  OPERATIONAL_FLAGS,
  OperationalFlagCard,
} from "@/components/admin/feature-flags/OperationalFlagCard";
import { HeavyComputeRunner } from "@/components/admin/feature-flags/HeavyComputeRunner";

interface ProductFlagSpec {
  key: string;
  title: string;
  help: string;
}

/**
 * Consistent heading treatment shared by every section on this page so the
 * eyebrow label + optional description keep the same spacing and hierarchy.
 */
function SectionHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

interface FlagCategory {
  id: string;
  label: string;
  description: string;
  flags: ProductFlagSpec[];
}

// Product / experimental flags grouped by domain. Any flag returned by the
// API that isn't listed here falls into a synthesized "Other" category so
// new flags don't disappear from the UI before the labels are added.
const PRODUCT_FLAG_CATEGORIES: FlagCategory[] = [
  {
    id: "contribution",
    label: "Map Contribution workflow",
    description: "Behaviour of the Multiplayer → Contribute Map review pipeline.",
    flags: [
      {
        key: "match_score",
        title: "Match-percentage scoring",
        help: "Show admins how many chunks in a pending upload overlap the existing combined map.",
      },
      {
        key: "region_overwrite",
        title: "Region-restricted updates",
        help: "Allow contributors to overwrite chunks within a bounding box (admin-only at launch).",
      },
      {
        key: "per_contribution_revert",
        title: "Per-contribution revert",
        help: "Allow admins to undo a single approved contribution within REVERT_WINDOW_DAYS.",
      },
      {
        key: "auto_regen_after_approval",
        title: "Auto map-cache regen after approval",
        help: "When ON, approving (or reverting) a contribution automatically kicks generate_map_levels for the chunks intersecting the contributed area. Turn OFF on a small server that cannot afford the rerender — an admin must then trigger regeneration manually from the TOPS map admin panel.",
      },
    ],
  },
  {
    id: "history-backups",
    label: "History & backups",
    description: "Public history feed and the weekly snapshot / restore pipeline.",
    flags: [
      {
        key: "public_history",
        title: "Public history",
        help: "Expose approved contribution previews to all read-key holders.",
      },
      {
        key: "weekly_backups",
        title: "Weekly backups",
        help: "Snapshot the combined map .db once per ISO week.",
      },
      {
        key: "backup_restore",
        title: "Backup restore",
        help: "Allow admins to restore the combined map from a weekly snapshot (TOTP-gated).",
      },
    ],
  },
  {
    id: "waypoints",
    label: "Waypoints: landmarks, translocators & traders",
    description:
      "User-editable map markers — landmark additions and the chat-log / screenshot translocator contribution paths.",
    flags: [
      {
        key: "landmark_additions_enabled",
        title: "Landmark additions",
        help: "ON = non-admin accounts can POST /api/landmarks to add a new landmark to the live geojson. OFF = the endpoint returns 503 for non-admins (admins always bypass). Existing rename / edit-request flow is unaffected — only NEW additions are gated.",
      },
      {
        key: "translocator_contributions",
        title: "Translocator contributions (chat log)",
        help: "ON = POST /api/contribute-tls accepts client-chat.log batches and merges them live into translocators.geojson. OFF = the endpoint returns 503 and the Contribute TLs page degrades gracefully. Non-admin callers are additionally rate-limited to 3 submissions per 24h.",
      },
      {
        key: "manual_translocators",
        title: "Translocator contributions (manual entry)",
        help: "ON = POST /api/contribute-tls/manual accepts typed TL pairs and merges them live into translocators.geojson without admin review. OFF = the endpoint returns 503 and the Manual entry tab surfaces a disabled message. Non-admin callers are rate-limited by translocators_manual_daily_cap (default 15/24h).",
      },
      {
        key: "translocator_screenshot_contributions",
        title: "Translocator contributions (screenshots)",
        help: "ON = POST /api/contribute-tls/screenshots/* accepts uploads and queues OCR + minimap analysis. OFF = those endpoints return 404 and the frontend tab hides the form. Independent of the chat-log flag above.",
      },
      {
        key: "traders_chatlog_contributions",
        title: "Trader contributions (chat log)",
        help: "ON = POST /api/contribute-traders accepts client-chat.log batches and merges them into pending contributions for admin review. OFF = the endpoint returns 503 and the Contribute Traders page degrades gracefully. Non-admin callers are additionally rate-limited to 3 submissions per 24h.",
      },
      {
        key: "traders_manual_contributions",
        title: "Trader contributions (manual form)",
        help: "ON = POST /api/contribute-traders/manual accepts admin-submitted batches of trader waypoints (e.g. from a spreadsheet) and merges them into pending contributions for review. OFF = the endpoint returns 503 and the frontend tab hides the form.",
      },
      {
        key: "traders_viewer",
        title: "Trader viewer",
        help: "ON = the public map viewer shows chat-log-contributed traders in a distinct style (e.g. different icon or color) so users can easily see which traders were contributed by the community vs. hand-curated by admins. OFF = all traders look the same on the map regardless of source.",
      },
      {
        key: "per_traders_revert",
        title: "Per-contribution revert for traders",
        help: "Allow admins to undo a single approved trader contribution within REVERT_WINDOW_DAYS, without reverting other contributions that touched the same area. This is a more surgical alternative to the global per_contribution_revert flag for the specific case of traders, where a single bad batch can be reverted without disturbing other pending or approved contributions.",
      },
    ],
  },
  {
    id: "grouping-library",
    label: "TL grouping library",
    description:
      "Community sharing of TOPS-map translocator groupings (publish / browse / fork / subscribe). Numeric caps live in the Quotas & rate limits section above.",
    flags: [
      {
        key: "grouping_library_enabled",
        title: "Grouping library",
        help: "ON = the community grouping library endpoints are live and the TOPS map exposes Browse / Publish UI. OFF = all /api/groupings/library endpoints return 404 and the frontend hides the library buttons. Numeric caps (publish daily cap, max TLs, max tags) are configured in the Quotas & rate limits section.",
      },
    ],
  },
  {
    id: "trader-claims",
    label: "Trader claim overlays",
    description:
      "Community overlays that annotate the static trader-claim boxes — which claim holds which trader type, and which claims are empty (no trader inside). Manual submissions are capped by trader_claims_manual_daily_cap / trader_claim_empty_manual_daily_cap.",
    flags: [
      {
        key: "trader_claims_viewer",
        title: "Trader claim types — viewer",
        help: "ON = GET /api/trader-claim-types returns a presigned URL to the merged claim-type overlay (which static claim box holds which trader type) so the map can show the layer. OFF = the endpoint reports the overlay as disabled and the map hides the claim-type layer.",
      },
      {
        key: "trader_claims_manual",
        title: "Trader claim types — manual marking",
        help: "ON = logged-in users can POST /api/trader-claim-types to manually mark a claim box's trader type (their guess). Rate-limited by trader_claims_manual_daily_cap (default 30/day). A manual guess only fills a claim that has no authoritative value yet. OFF = the endpoint returns 503.",
      },
      {
        key: "trader_claims_authoritative",
        title: "Trader claim types — authoritative publish",
        help: "ON = the VSProxy (admin key, or a key with the trader_claims_publish permission) can POST /api/trader-claim-types/authoritative to publish claim types derived from the in-game trader entity code. Authoritative values always win over manual guesses. OFF = the endpoint returns 503.",
      },
      {
        key: "trader_claim_empty_viewer",
        title: "Empty trader claims — viewer",
        help: "ON = GET /api/trader-claim-empty returns a presigned URL to the \u201cno-trader claim\u201d overlay (claim boxes known to contain no actual trader) so the map can show the layer. OFF = the endpoint reports the overlay as disabled and the map hides the empty-claim layer.",
      },
      {
        key: "trader_claim_empty_manual",
        title: "Empty trader claims — manual marking",
        help: "ON = logged-in users can POST /api/trader-claim-empty to mark a claim box as empty (no trader inside). Rate-limited by trader_claim_empty_manual_daily_cap (default 30/day). OFF = the endpoint returns 503.",
      },
      {
        key: "trader_claim_empty_authoritative",
        title: "Empty trader claims — authoritative publish",
        help: "ON = the VSProxy (admin key, or a key with the map-features publish permission) can POST /api/trader-claim-empty/authoritative to publish empty-claim markings derived from an actual scan of the claim volume. Always wins over manual markings. OFF = the endpoint returns 503.",
      },
    ],
  },
  {
    id: "elk-walkable",
    label: "Elk-walkable routes",
    description:
      "Elk-accessible walkable edges between translocators used by the Route Planner, plus the moderation queue for wrongly attested edges. The per-user submission cap is elk_walkable_daily_cap.",
    flags: [
      {
        key: "elk_walkable_contributions",
        title: "Elk-walkable contributions",
        help: "ON = users can POST /api/elk-walkable/submit to attest elk-accessible walkable edges between translocators, and the Route-Planner draft UI is enabled. Rate-limited by elk_walkable_daily_cap (default 10 per 24h). OFF = submissions are rejected and the draft UI is hidden.",
      },
      {
        key: "elk_walkable_reports_enabled",
        title: "Elk-walkable reports",
        help: "ON = users can flag a confirmed elk-walkable edge as wrongly attested, feeding an admin moderation queue (post-moderation, so the edge stays live until a reviewer acts). OFF = the reporting endpoint and UI are disabled.",
      },
    ],
  },
  {
    id: "marketplace",
    label: "Orders marketplace",
    description:
      "Community buy/sell marketplace (Market → Orders), independent of the static Auction House capture data.",
    flags: [
      {
        key: "orders_enabled",
        title: "Orders marketplace",
        help: "ON = the community Orders marketplace is live: account holders can post buy/sell orders, negotiate via requests / counter-offers, and log fills. OFF = all /api/orders/* endpoints return 404 and the frontend hides the Orders UI.",
      },
    ],
  },
];

export function AdminFeatureFlagsPage() {
  const queryClient = useQueryClient();
  const { formatDate } = useDateFormat();
  const flagsQuery = useQuery({
    queryKey: ["admin-feature-flags"],
    queryFn: adminListFeatureFlags,
  });

  const setFlag = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      adminSetFeatureFlag(key, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-feature-flags"] }),
  });

  const setQuota = useMutation({
    mutationFn: ({ key, value_int }: { key: string; value_int: number | null }) =>
      adminSetFeatureFlag(key, { value_int }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-feature-flags"] }),
  });

  const flagMap = useMemo(() => {
    const map = new Map<string, FeatureFlag>();
    flagsQuery.data?.flags.forEach((f) => map.set(f.key, f));
    return map;
  }, [flagsQuery.data]);

  // Build the categorized product-flag view. Any flag returned by the API
  // that isn't classified above lands in a synthesized "Other" group so new
  // backend flags remain reachable from the UI before labels are added.
  const categorizedProductFlags = useMemo(() => {
    const known = new Set<string>();
    OPERATIONAL_FLAGS.forEach((f) => known.add(f.key));
    PRODUCT_FLAG_CATEGORIES.forEach((c) => c.flags.forEach((f) => known.add(f.key)));
    QUOTA_FLAGS.forEach((f) => known.add(f.key));
    const unknown: ProductFlagSpec[] = (flagsQuery.data?.flags ?? [])
      .filter((f) => !known.has(f.key))
      .map((f) => ({ key: f.key, title: f.key, help: "" }));
    const cats = PRODUCT_FLAG_CATEGORIES.map((c) => ({
      ...c,
      flags: c.flags.filter((f) => flagMap.has(f.key)),
    })).filter((c) => c.flags.length > 0);
    if (unknown.length > 0) {
      cats.push({
        id: "other",
        label: "Other",
        description: "Flags returned by the API that aren’t categorized in the frontend yet.",
        flags: unknown,
      });
    }
    return cats;
  }, [flagMap, flagsQuery.data]);

  return (
    <div className="space-y-8">
      <div className="space-y-1 border-b pb-4">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Power className="h-5 w-5" /> Feature Flags
        </h2>
        <p className="text-sm text-muted-foreground">
          Runtime kill switches. Changes take effect within ~30 seconds (the in-process flag cache
          TTL). For the full reference, see{" "}
          <span className="font-mono">docs/users/feature-flags.md</span>.
        </p>
      </div>

      {flagsQuery.isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {flagsQuery.error && (
        <p className="text-sm text-destructive">{(flagsQuery.error as Error).message}</p>
      )}

      {/* Operational kill switches */}
      <section className="space-y-3">
        <SectionHeader title="Operational kill switches" />
        <div className="space-y-3">
          {OPERATIONAL_FLAGS.map((spec) => {
            const flag = flagMap.get(spec.key);
            const enabled = flag?.enabled ?? spec.defaultEnabled;
            let extra: ReactNode | undefined;
            if (spec.key === "heavy_compute_enabled") {
              extra = <HeavyComputeRunner />;
            } else if (spec.key === "compress_artefacts" && enabled) {
              extra = <CompressionSettingsPanel />;
            }
            return (
              <OperationalFlagCard
                key={spec.key}
                spec={spec}
                flag={flag}
                pending={setFlag.isPending && setFlag.variables?.key === spec.key}
                onToggle={(en) => setFlag.mutate({ key: spec.key, enabled: en })}
                extra={extra}
              />
            );
          })}
        </div>
      </section>

      {/* Map-lock infrastructure (lives next to the kill switches because
          force-releasing the lock is an operational action, not a flag). */}
      <section className="space-y-3">
        <SectionHeader title="Infrastructure" />
        <MapLockCard />
      </section>

      {/* Per-user quotas & rate limits (numeric) */}
      <section className="space-y-3">
        <SectionHeader
          title="Quotas & rate limits"
          description="Numeric caps applied to non-admin contributions. Leave blank (Reset) to use the built-in default. Admins always bypass these caps. Changes propagate within ~30s."
        />
        <Card>
          <CardContent className="pt-4 space-y-1">
            {QUOTA_FLAGS.map((spec) => {
              const f = flagMap.get(spec.key);
              const current = f?.value_int ?? null;
              const isPending = setQuota.isPending && setQuota.variables?.key === spec.key;
              return (
                <QuotaFlagRow
                  key={spec.key}
                  spec={spec}
                  current={current}
                  updatedAt={f?.updated_at}
                  pending={isPending}
                  onSave={(value_int) => setQuota.mutate({ key: spec.key, value_int })}
                />
              );
            })}
          </CardContent>
        </Card>
      </section>

      {/* Product / experimental flags, grouped by category */}
      {categorizedProductFlags.map((cat) => (
        <section key={cat.id} className="space-y-3">
          <SectionHeader title={cat.label} description={cat.description} />
          <Card>
            <CardContent className="pt-4 space-y-1">
              {cat.flags.map((spec) => {
                const f = flagMap.get(spec.key);
                if (!f) return null;
                return (
                  <div
                    key={spec.key}
                    className="flex flex-col gap-3 border-b border-border/60 py-3 first:pt-0 last:border-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{spec.title}</span>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {spec.key}
                          </Badge>
                          {f.enabled ? (
                            <Badge
                              variant="outline"
                              className="gap-1 text-[10px] text-emerald-600 border-emerald-500/40"
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              on
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px]">
                              off
                            </Badge>
                          )}
                        </div>
                        {spec.help && (
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {spec.help}
                          </p>
                        )}
                        <p className="text-[10px] text-muted-foreground">
                          Updated {formatDate(new Date(f.updated_at))}
                        </p>
                      </div>
                      <Switch
                        className="mt-0.5"
                        checked={f.enabled}
                        disabled={setFlag.isPending && setFlag.variables?.key === spec.key}
                        onCheckedChange={(v) =>
                          setFlag.mutate({ key: spec.key, enabled: Boolean(v) })
                        }
                      />
                    </div>
                    {/* Inline settings panel for flags that have one. Only
                        shown while the flag is ON to avoid surfacing knobs
                        for a disabled feature. */}
                    {spec.key === "region_overwrite" && f.enabled && (
                      <RegionOverwriteSettingsPanel />
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}
