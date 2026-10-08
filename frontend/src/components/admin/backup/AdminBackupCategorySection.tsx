import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectItem,
  SelectContent,
} from "@/components/ui/select";
import type { BackupSchedule, BackupInterval } from "@/lib/api";
import type { NormalizedBackup } from "@/pages/admin/AdminBackupsOverviewPage";
import { formatBytes } from "@/lib/utils";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Camera, HistoryIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const INTERVAL_OPTIONS: { value: BackupInterval; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "monthly", label: "Monthly" },
  { value: "disabled", label: "Disabled" },
];

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

export function AdminBackupCategorySection({
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
            value={interval ?? null}
            onValueChange={(v) => onIntervalChange(v as BackupInterval)}
            disabled={scheduleLoading || schedulePending || !schedule}
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue placeholder={scheduleLoading ? "Loading…" : "Interval"}>
                {(value) =>
                  INTERVAL_OPTIONS.find((opt) => opt.value === value)?.label ?? "Interval"
                }
              </SelectValue>
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
            This overwrites the live file with the selected snapshot. The current state is captured
            as a new restore point first, so the action is reversible.
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
