/**
 * Admin: Backups overview (route: /audit/backups).
 *
 * One place to manage the backup snapshots for the three crowd-sourced data
 * categories that support it:
 *   - Traders (`traders.geojson`)
 *   - Map-features traders (`map-features.traders.json`)
 *   - Elk-walkable (`elk_walkable.json`)
 *
 * For each category an admin can: view existing snapshots, take a snapshot
 * now, revert to a snapshot, and tune the automatic schedule (weekly /
 * biweekly / monthly) or disable it entirely. Requires the env-var admin key.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminGetBackupSchedule,
  adminPatchBackupSchedule,
  adminListGeojsonBackups,
  adminCreateGeojsonBackup,
  adminRestoreGeojsonBackup,
  adminListMapFeaturesTradersBackups,
  adminCreateMapFeaturesTradersBackup,
  adminRestoreMapFeaturesTradersBackup,
  adminListElkWalkableSnapshots,
  adminCreateElkWalkableSnapshot,
  adminRestoreElkWalkableSnapshot,
  type BackupInterval,
  type BackupSchedule,
} from "@/lib/api";
import { formatBytes, formatTimestamp } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Camera, History as HistoryIcon, Loader2 } from "lucide-react";

const SCHEDULE_KEY = ["admin-backup-schedule"] as const;

const INTERVAL_OPTIONS: { value: BackupInterval; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "monthly", label: "Monthly" },
  { value: "disabled", label: "Disabled" },
];

interface NormalizedBackup {
  key: string;
  timestampLabel: string;
  size: number | null;
  kind: string | null;
}

/** Best-effort human timestamp for an elk-walkable snapshot key, whose name
 *  embeds a filename-safe ISO timestamp (colons stripped). */
function elkSnapshotTimestamp(key: string): string {
  const m = key.match(/(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return "—";
  return `${m[1]} ${m[2]}:${m[3]}:${m[4]} UTC`;
}

export function AdminBackupsOverviewPage() {
  const queryClient = useQueryClient();

  const schedule = useQuery({
    queryKey: SCHEDULE_KEY,
    queryFn: adminGetBackupSchedule,
    retry: false,
  });

  const patchSchedule = useMutation({
    mutationFn: (patch: Partial<BackupSchedule>) => adminPatchBackupSchedule(patch),
    onSuccess: (next) => queryClient.setQueryData(SCHEDULE_KEY, next),
  });

  const setInterval = (category: keyof BackupSchedule, value: BackupInterval) =>
    patchSchedule.mutate({ [category]: value });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Backups</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          View, create and revert snapshots of the crowd-sourced data categories, and tune how
          often each one is backed up automatically.
        </p>
      </div>

      <BackupCategorySection
        title="Traders"
        description="User-contributed traders (traders.geojson)."
        scheduleCategory="traders"
        schedule={schedule.data}
        scheduleLoading={schedule.isLoading}
        schedulePending={patchSchedule.isPending}
        onIntervalChange={(v) => setInterval("traders", v)}
        queryKey="admin-backups-traders"
        load={async () => {
          const { backups } = await adminListGeojsonBackups();
          return backups
            .filter((b) => b.asset === "traders")
            .map<NormalizedBackup>((b) => ({
              key: b.key,
              timestampLabel: formatTimestamp(b.last_modified),
              size: b.size,
              kind: b.kind,
            }));
        }}
        create={() => adminCreateGeojsonBackup("traders")}
        restore={(key) => adminRestoreGeojsonBackup("traders", key)}
      />

      <BackupCategorySection
        title="Map-features traders"
        description="The merged crowd-sourced traders list (map-features.traders.json)."
        scheduleCategory="map_features_traders"
        schedule={schedule.data}
        scheduleLoading={schedule.isLoading}
        schedulePending={patchSchedule.isPending}
        onIntervalChange={(v) => setInterval("map_features_traders", v)}
        queryKey="admin-backups-map-features-traders"
        load={async () => {
          const { backups } = await adminListMapFeaturesTradersBackups();
          return backups.map<NormalizedBackup>((b) => ({
            key: b.key,
            timestampLabel: formatTimestamp(b.last_modified),
            size: b.size,
            kind: b.kind,
          }));
        }}
        create={() => adminCreateMapFeaturesTradersBackup()}
        restore={(key) => adminRestoreMapFeaturesTradersBackup(key)}
      />

      <BackupCategorySection
        title="Elk-walkable"
        description="Walkable translocator edges (elk_walkable.json)."
        scheduleCategory="elk_walkable"
        schedule={schedule.data}
        scheduleLoading={schedule.isLoading}
        schedulePending={patchSchedule.isPending}
        onIntervalChange={(v) => setInterval("elk_walkable", v)}
        queryKey="admin-backups-elk-walkable"
        load={async () => {
          const { snapshots } = await adminListElkWalkableSnapshots(200);
          return snapshots.map<NormalizedBackup>((s) => ({
            key: s.key,
            timestampLabel: elkSnapshotTimestamp(s.key),
            size: null,
            kind: null,
          }));
        }}
        create={() => adminCreateElkWalkableSnapshot()}
        restore={(key) => adminRestoreElkWalkableSnapshot(key)}
      />
    </div>
  );
}

interface BackupCategorySectionProps {
  title: string;
  description: string;
  scheduleCategory: keyof BackupSchedule;
  schedule: BackupSchedule | undefined;
  scheduleLoading: boolean;
  schedulePending: boolean;
  onIntervalChange: (value: BackupInterval) => void;
  queryKey: string;
  load: () => Promise<NormalizedBackup[]>;
  create: () => Promise<unknown>;
  restore: (key: string) => Promise<unknown>;
}

function BackupCategorySection({
  title,
  description,
  scheduleCategory,
  schedule,
  scheduleLoading,
  schedulePending,
  onIntervalChange,
  queryKey,
  load,
  create,
  restore,
}: BackupCategorySectionProps) {
  const queryClient = useQueryClient();
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);

  const backups = useQuery({
    queryKey: [queryKey],
    queryFn: load,
    retry: false,
  });

  const createMut = useMutation({
    mutationFn: create,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [queryKey] }),
  });

  const restoreMut = useMutation({
    mutationFn: (key: string) => restore(key),
    onSuccess: () => {
      setRestoreTarget(null);
      queryClient.invalidateQueries({ queryKey: [queryKey] });
    },
  });

  const rows = backups.data ?? [];
  const interval = schedule?.[scheduleCategory];

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">Auto-backup</span>
          <Select
            value={interval}
            onValueChange={(v) => onIntervalChange(v as BackupInterval)}
            disabled={scheduleLoading || schedulePending || !schedule}
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue placeholder={scheduleLoading ? "Loading…" : "Interval"} />
            </SelectTrigger>
            <SelectContent>
              {INTERVAL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {rows.length} snapshot{rows.length === 1 ? "" : "s"}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending}
          >
            {createMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Camera className="size-4" />
            )}
            Snapshot now
          </Button>
        </div>

        {createMut.error && (
          <p className="text-xs text-destructive">{(createMut.error as Error).message}</p>
        )}
        {restoreMut.error && (
          <p className="text-xs text-destructive">{(restoreMut.error as Error).message}</p>
        )}

        {backups.isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {backups.error && (
          <p className="text-sm text-destructive">{(backups.error as Error).message}</p>
        )}
        {backups.data && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No snapshots yet.</p>
        )}

        {rows.length > 0 && (
          <div className="divide-y border rounded-md">
            {rows.map((b) => (
              <div
                key={b.key}
                className="px-3 py-2 text-xs flex items-center justify-between gap-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium whitespace-nowrap">{b.timestampLabel}</span>
                    {b.kind && (
                      <Badge variant={b.kind === "manual" ? "secondary" : "outline"}>
                        {b.kind}
                      </Badge>
                    )}
                    {b.size != null && (
                      <span className="text-muted-foreground">{formatBytes(b.size)}</span>
                    )}
                  </div>
                  <div className="font-mono text-muted-foreground break-all">{b.key}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => setRestoreTarget(b.key)}
                  disabled={restoreMut.isPending}
                  title="Revert the live file to this snapshot"
                >
                  <HistoryIcon className="size-3" /> Revert
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={restoreTarget !== null}
        title={`Revert ${title}?`}
        description={
          <>
            This overwrites the live file with the selected snapshot. The current state is
            captured as a new restore point first, so the action is reversible.
          </>
        }
        confirmLabel="Revert"
        variant="destructive"
        loading={restoreMut.isPending}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => {
          if (restoreTarget) restoreMut.mutate(restoreTarget);
        }}
      />
    </Card>
  );
}
