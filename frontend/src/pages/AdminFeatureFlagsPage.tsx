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

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  Power,
  RefreshCw,
  Unlock,
  Upload,
  UserPlus,
  Wrench,
} from "lucide-react";
import {
  adminForceReleaseMapLock,
  adminGetMapLock,
  adminListFeatureFlags,
  adminSetFeatureFlag,
  type FeatureFlag,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";

type IconType = typeof Wrench;

interface OperationalFlagSpec {
  key: string;
  label: string;
  icon: IconType;
  /** What turning the switch ON does. */
  whenOn: string;
  /** What turning the switch OFF does. */
  whenOff: string;
  /** Default value when no row exists in the DB (matches the backend). */
  defaultEnabled: boolean;
  /** Tone shown next to the toggle when the flag is in its "alarm" state. */
  alarmState: "on" | "off";
  alarmText: string;
  /** Optional additional caveat — surfaced in a callout. */
  caveat?: string;
}

const OPERATIONAL_FLAGS: OperationalFlagSpec[] = [
  {
    key: "maintenance_mode",
    label: "Maintenance mode",
    icon: Wrench,
    defaultEnabled: false,
    whenOn:
      "All POST/PUT/PATCH/DELETE requests from non-admin users return HTTP 503. " +
      "Read-only browsing (map viewer, contribution history, public stats) keeps working. " +
      "Admin endpoints (/api/admin/*) and the env-var admin key remain fully writable so you can disable the flag without locking yourself out.",
    whenOff: "Normal operation — writes flow through as usual.",
    alarmState: "on",
    alarmText: "site is in maintenance mode",
    caveat:
      "Use this for short windows (DB migration, R2 maintenance, incident triage). " +
      "Long-running maintenance should also be communicated on the General page.",
  },
  {
    key: "uploads_enabled",
    label: "Map contributions",
    icon: Upload,
    defaultEnabled: true,
    whenOn: "Players with the contribute permission can upload .db files via the Contribute page.",
    whenOff:
      "POST /api/contribute, /contribute/upload-url, and /contribute/complete return HTTP 503 for non-admin callers. " +
      "Approving / rejecting / reverting existing pending contributions still works. " +
      "Admins can still upload (e.g. while backfilling after an incident).",
    alarmState: "off",
    alarmText: "uploads disabled",
    caveat:
      "Flip OFF during a contribution-driven incident (spam wave, disk near full, R2 quota issue). " +
      "Existing pending contributions are not affected — only new submissions.",
  },
  {
    key: "registration_enabled",
    label: "New account registration",
    icon: UserPlus,
    defaultEnabled: true,
    whenOn: "Users with a freshly claimed invite key can complete /api/account/register.",
    whenOff:
      "POST /api/account/register returns HTTP 503. Existing accounts continue to work (login, profile edits, contributions). " +
      "Invite links can still be claimed (a key is issued) but the user cannot create an account row until this is re-enabled.",
    alarmState: "off",
    alarmText: "registration disabled",
    caveat:
      "Useful when a sibling-account / shared-IP wave needs to be triaged before more accounts join. " +
      "Pre-existing static API keys (env-var) bypass registration entirely.",
  },
];

interface ProductFlagSpec {
  key: string;
  title: string;
  help: string;
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
    label: "Contribution workflow",
    description: "Behaviour of the Multiplayer → Contribute review pipeline.",
    flags: [
      {
        key: "match_score",
        title: "Match-percentage scoring",
        help: "Show admins how many tiles in a pending upload overlap the existing combined map.",
      },
      {
        key: "region_overwrite",
        title: "Region-restricted updates",
        help: "Allow contributors to overwrite tiles within a bounding box (admin-only at launch).",
      },
      {
        key: "per_contribution_revert",
        title: "Per-contribution revert",
        help: "Allow admins to undo a single approved contribution within REVERT_WINDOW_DAYS.",
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
        title: "Public 14-day history",
        help: "Expose recently-approved contribution previews to all read-key holders.",
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
];

export function AdminFeatureFlagsPage() {
  const queryClient = useQueryClient();
  const flagsQuery = useQuery({
    queryKey: ["admin-feature-flags"],
    queryFn: adminListFeatureFlags,
  });

  const setFlag = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      adminSetFeatureFlag(key, enabled),
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
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Power className="h-5 w-5" /> Feature Flags
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
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
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Operational kill switches
        </h3>
        <div className="space-y-3">
          {OPERATIONAL_FLAGS.map((spec) => (
            <OperationalFlagCard
              key={spec.key}
              spec={spec}
              flag={flagMap.get(spec.key)}
              pending={setFlag.isPending && setFlag.variables?.key === spec.key}
              onToggle={(enabled) => setFlag.mutate({ key: spec.key, enabled })}
            />
          ))}
        </div>
      </section>

      {/* Map-lock infrastructure (lives next to the kill switches because
          force-releasing the lock is an operational action, not a flag). */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Infrastructure
        </h3>
        <MapLockCard />
      </section>

      {/* Product / experimental flags, grouped by category */}
      {categorizedProductFlags.map((cat) => (
        <section key={cat.id} className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {cat.label}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">{cat.description}</p>
          </div>
          <Card>
            <CardContent className="pt-4 space-y-2">
              {cat.flags.map((spec) => {
                const f = flagMap.get(spec.key);
                if (!f) return null;
                return (
                  <div
                    key={spec.key}
                    className="flex items-start justify-between gap-3 border-b last:border-0 pb-2 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{spec.title}</span>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {spec.key}
                        </Badge>
                        {f.enabled ? (
                          <Badge className="text-[10px]">on</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            off
                          </Badge>
                        )}
                      </div>
                      {spec.help && (
                        <p className="text-xs text-muted-foreground mt-0.5">{spec.help}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Updated {new Date(f.updated_at).toLocaleString()}
                      </p>
                    </div>
                    <Switch
                      checked={f.enabled}
                      disabled={setFlag.isPending && setFlag.variables?.key === spec.key}
                      onCheckedChange={(v) =>
                        setFlag.mutate({ key: spec.key, enabled: Boolean(v) })
                      }
                    />
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

function MapLockCard() {
  const queryClient = useQueryClient();
  const [confirmRelease, setConfirmRelease] = useState(false);

  const lock = useQuery({
    queryKey: ["admin-map-lock"],
    queryFn: adminGetMapLock,
    refetchInterval: 10_000,
  });

  const releaseLock = useMutation({
    mutationFn: adminForceReleaseMapLock,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-map-lock"] }),
  });

  const lockInfo = lock.data?.lock ?? null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {lockInfo ? (
            <Lock className="h-4 w-4 text-amber-600" />
          ) : (
            <Unlock className="h-4 w-4 text-emerald-600" />
          )}
          Map lock
          <HelpTip
            text={
              "Global mutex around the combined map .db. Held briefly during " +
              "approve, revert, and backup-restore so two writers can\u2019t merge into " +
              "stale bytes. Force-release only if you\u2019re sure no worker is mid-write \u2014 " +
              "doing so during a real merge can corrupt the map."
            }
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-2 flex-wrap text-sm">
          <div>
            {lockInfo ? (
              <span>
                Held by <strong>{lockInfo.holder_action}</strong>, expires{" "}
                {new Date(lockInfo.expires_at).toLocaleTimeString()}
              </span>
            ) : (
              <span className="text-muted-foreground">Free — no merge in progress.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => lock.refetch()}
              aria-label="Refresh lock status"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
            {lockInfo && (
              <Button
                size="sm"
                variant="outline"
                disabled={releaseLock.isPending}
                onClick={() => setConfirmRelease(true)}
              >
                Force release
              </Button>
            )}
          </div>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmRelease}
        title="Force-release the map lock?"
        description="Only do this if you\u2019re sure no approve/revert/restore is in progress. Releasing while a worker is still merging can corrupt the combined map."
        confirmLabel="Release lock"
        variant="destructive"
        onCancel={() => setConfirmRelease(false)}
        onConfirm={() => {
          setConfirmRelease(false);
          releaseLock.mutate();
        }}
      />
    </Card>
  );
}

function OperationalFlagCard({
  spec,
  flag,
  pending,
  onToggle,
}: {
  spec: OperationalFlagSpec;
  flag: FeatureFlag | undefined;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const enabled = flag ? flag.enabled : spec.defaultEnabled;
  const inAlarm = (spec.alarmState === "on" && enabled) || (spec.alarmState === "off" && !enabled);
  const Icon = spec.icon;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  // Toggling into alarm state (e.g. enabling maintenance, disabling uploads)
  // is destructive enough that we want a confirmation.
  function handleToggle(next: boolean) {
    const willBeAlarm = (spec.alarmState === "on" && next) || (spec.alarmState === "off" && !next);
    if (willBeAlarm) {
      setPendingValue(next);
      setConfirmOpen(true);
      return;
    }
    onToggle(next);
  }

  return (
    <Card className={inAlarm ? "border-amber-500" : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4" />
            {spec.label}
            <Badge variant="outline" className="font-mono text-[10px]">
              {spec.key}
            </Badge>
          </span>
          <span className="flex items-center gap-2">
            {inAlarm ? (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                {spec.alarmText}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-emerald-600 border-emerald-500/40">
                <CheckCircle2 className="h-3 w-3" />
                normal
              </Badge>
            )}
            <Switch
              checked={enabled}
              disabled={pending}
              onCheckedChange={(v) => handleToggle(Boolean(v))}
            />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid gap-1 sm:grid-cols-2">
          <div className="rounded border p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
              When ON
            </div>
            <p className="text-xs">{spec.whenOn}</p>
          </div>
          <div className="rounded border p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
              When OFF
            </div>
            <p className="text-xs">{spec.whenOff}</p>
          </div>
        </div>
        {spec.caveat && (
          <p className="text-[11px] text-muted-foreground italic flex gap-1">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-amber-600" />
            {spec.caveat}
          </p>
        )}
        {flag && (
          <p className="text-[10px] text-muted-foreground">
            Last changed {new Date(flag.updated_at).toLocaleString()}
            {flag.updated_by_key ? ` by ${flag.updated_by_key.slice(0, 8)}…` : ""}
          </p>
        )}
        {!flag && (
          <p className="text-[10px] text-muted-foreground">
            Default value (no row in DB yet — first toggle creates one).
          </p>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        title={`${pendingValue ? "Enable" : "Disable"} ${spec.label}?`}
        description={
          spec.alarmState === "on" && pendingValue
            ? spec.whenOn
            : spec.alarmState === "off" && !pendingValue
              ? spec.whenOff
              : ""
        }
        confirmLabel={pendingValue ? "Enable" : "Disable"}
        variant="destructive"
        onCancel={() => {
          setConfirmOpen(false);
          setPendingValue(null);
        }}
        onConfirm={() => {
          if (pendingValue !== null) onToggle(pendingValue);
          setConfirmOpen(false);
          setPendingValue(null);
        }}
      />
    </Card>
  );
}
