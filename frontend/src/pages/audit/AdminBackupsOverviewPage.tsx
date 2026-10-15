/**
 * Admin: Backups overview (route: /audit/backups).
 *
 * One place to manage the backup snapshots for the crowd-sourced /
 * upstream data categories that support it:
 *   - Traders (`traders.geojson`)
 *   - Map-features traders (`map-features.traders.json`)
 *   - Map-features rapids (`map-features.rapids.json`)
 *   - Elk-walkable (`elk_walkable.json`)
 *   - Upstream translocators (TOPS `translocators.json`, snapshot-only)
 *
 * For each category an admin can: view existing snapshots, take a snapshot
 * now, revert to a snapshot (where supported), and tune the automatic
 * schedule (weekly / biweekly / monthly) or disable it entirely. Requires the
 * env-var admin key.
 */

import { AdminBackupCategorySection } from "@/components/admin/backup/AdminBackupCategorySection";
import {
  adminCreateElkWalkableSnapshot,
  adminCreateGeojsonBackup,
  adminCreateMapFeaturesRapidsBackup,
  adminCreateMapFeaturesTradersBackup,
  adminCreateTopsTranslocatorsBackup,
  adminGetBackupSchedule,
  adminListElkWalkableSnapshots,
  adminListGeojsonBackups,
  adminListMapFeaturesRapidsBackups,
  adminListMapFeaturesTradersBackups,
  adminListTopsTranslocatorsBackups,
  adminPatchBackupSchedule,
  adminRestoreElkWalkableSnapshot,
  adminRestoreGeojsonBackup,
  adminRestoreMapFeaturesRapidsBackup,
  adminRestoreMapFeaturesTradersBackup,
  type BackupInterval,
  type BackupSchedule,
} from "@/lib/api";
import { formatTimestamp } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const SCHEDULE_KEY = ["admin-backup-schedule"] as const;

export type NormalizedBackup = {
  key: string;
  timestampLabel: string;
  size: number | null;
  kind: string | null;
};

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
          View, create and revert snapshots of the crowd-sourced data categories, and tune how often
          each one is backed up automatically.
        </p>
      </div>

      <AdminBackupCategorySection
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

      <AdminBackupCategorySection
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

      <AdminBackupCategorySection
        title="Map-features rapids"
        description="The merged crowd-sourced rapids list (map-features.rapids.json)."
        scheduleCategory="map_features_rapids"
        schedule={schedule.data}
        scheduleLoading={schedule.isLoading}
        schedulePending={patchSchedule.isPending}
        onIntervalChange={(v) => setInterval("map_features_rapids", v)}
        queryKey="admin-backups-map-features-rapids"
        load={async () => {
          const { backups } = await adminListMapFeaturesRapidsBackups();
          return backups.map<NormalizedBackup>((b) => ({
            key: b.key,
            timestampLabel: formatTimestamp(b.last_modified),
            size: b.size,
            kind: b.kind,
          }));
        }}
        create={() => adminCreateMapFeaturesRapidsBackup()}
        restore={(key) => adminRestoreMapFeaturesRapidsBackup(key)}
      />

      <AdminBackupCategorySection
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

      <AdminBackupCategorySection
        title="Upstream translocators"
        description="Snapshots of the upstream TOPS translocators geojson (translocators.json), kept in case the upstream host goes down. Snapshot-only — no restore."
        scheduleCategory="tops_translocators"
        schedule={schedule.data}
        scheduleLoading={schedule.isLoading}
        schedulePending={patchSchedule.isPending}
        onIntervalChange={(v) => setInterval("tops_translocators", v)}
        queryKey="admin-backups-tops-translocators"
        load={async () => {
          const { backups } = await adminListTopsTranslocatorsBackups();
          return backups.map<NormalizedBackup>((b) => ({
            key: b.key,
            timestampLabel: formatTimestamp(b.last_modified),
            size: b.size,
            kind: b.kind,
          }));
        }}
        create={() => adminCreateTopsTranslocatorsBackup()}
      />
    </div>
  );
}
