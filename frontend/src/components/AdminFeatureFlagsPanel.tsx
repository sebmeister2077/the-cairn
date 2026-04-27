/**
 * Admin-only panel for toggling feature flags (Phase 0b).
 *
 * Renders inside ContributePage so all contribution-related admin controls
 * stay on a single page (per the plan's "single source of truth" note).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Flag, Lock, Unlock, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import {
  adminListFeatureFlags,
  adminSetFeatureFlag,
  adminGetMapLock,
  adminForceReleaseMapLock,
  type FeatureFlag,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { useState } from "react";

const FLAG_LABELS: Record<string, { title: string; help: string }> = {
  match_score: {
    title: "Match-percentage scoring",
    help: "Show admins how many tiles in a pending upload overlap the existing combined map.",
  },
  region_overwrite: {
    title: "Region-restricted updates",
    help: "Allow contributors to overwrite tiles within a bounding box (admin-only at launch).",
  },
  public_history: {
    title: "Public 14-day history",
    help: "Expose recently-approved contribution previews to all read-key holders.",
  },
  weekly_backups: {
    title: "Weekly backups",
    help: "Snapshot the combined map .db once a week (ISO weeks).",
  },
  per_contribution_revert: {
    title: "Per-contribution revert",
    help: "Allow admins to undo a single approved contribution within 14 days.",
  },
  backup_restore: {
    title: "Backup restore",
    help: "Allow admins to restore the combined map from a weekly snapshot (TOTP-gated).",
  },
};

export function AdminFeatureFlagsPanel() {
  const queryClient = useQueryClient();
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [open, setOpen] = useState(false);

  const flags = useQuery({
    queryKey: ["admin-feature-flags"],
    queryFn: adminListFeatureFlags,
  });

  const lock = useQuery({
    queryKey: ["admin-map-lock"],
    queryFn: adminGetMapLock,
    refetchInterval: 10_000,
  });

  const setFlag = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      adminSetFeatureFlag(key, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-feature-flags"] }),
  });

  const releaseLock = useMutation({
    mutationFn: adminForceReleaseMapLock,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-map-lock"] }),
  });

  const lockInfo = lock.data?.lock ?? null;

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <CardTitle className="flex items-center gap-2 text-base">
            <Flag className="h-4 w-4" />
            Admin: Feature Flags
          </CardTitle>
          {!open && lockInfo && (
            <Badge variant="outline" className="ml-2 gap-1 text-[10px]">
              <Lock className="h-3 w-3 text-amber-600" /> map locked
            </Badge>
          )}
        </button>
      </CardHeader>
      {open && (
      <CardContent className="space-y-4">
        <div className="border rounded p-3 space-y-2 bg-muted/30">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              {lockInfo ? (
                <>
                  <Lock className="h-4 w-4 text-amber-600" />
                  <span>
                    Map lock held by <strong>{lockInfo.holder_action}</strong>, expires{" "}
                    {new Date(lockInfo.expires_at).toLocaleTimeString()}
                  </span>
                </>
              ) : (
                <>
                  <Unlock className="h-4 w-4 text-emerald-600" />
                  <span>Map lock free</span>
                </>
              )}
              <HelpTip
                text={
                  "The map lock is a global mutex around the combined map .db. " +
                  "It is held briefly during approve, revert, and backup-restore so two " +
                  "writers can't merge into stale bytes. 'Free' means no merge is in progress. " +
                  "Force-release only if you're sure no worker is mid-write \u2014 doing so " +
                  "during a real merge can corrupt the map."
                }
              />
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
        </div>

        {flags.isLoading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading flags…
          </div>
        )}
        {flags.data && (
          <div className="space-y-2">
            {flags.data.flags.map((f) => (
              <FlagRow
                key={f.key}
                flag={f}
                onToggle={(enabled) => setFlag.mutate({ key: f.key, enabled })}
                pending={setFlag.isPending && setFlag.variables?.key === f.key}
              />
            ))}
          </div>
        )}
      </CardContent>
      )}

      <ConfirmDialog
        open={confirmRelease}
        title="Force-release the map lock?"
        description="Only do this if you're sure no approve/revert/restore is in progress. Releasing while a worker is still merging can corrupt the combined map."
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

function FlagRow({
  flag,
  onToggle,
  pending,
}: {
  flag: FeatureFlag;
  onToggle: (enabled: boolean) => void;
  pending: boolean;
}) {
  const label = FLAG_LABELS[flag.key] ?? { title: flag.key, help: "" };
  return (
    <div className="flex items-start justify-between gap-3 border-b last:border-0 pb-2 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{label.title}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {flag.key}
          </Badge>
          {flag.enabled ? (
            <Badge className="text-[10px]">on</Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">
              off
            </Badge>
          )}
        </div>
        {label.help && (
          <p className="text-xs text-muted-foreground mt-0.5">{label.help}</p>
        )}
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Updated {new Date(flag.updated_at).toLocaleString()}
        </p>
      </div>
      <Switch
        checked={flag.enabled}
        disabled={pending}
        onCheckedChange={(v) => onToggle(Boolean(v))}
      />
    </div>
  );
}
