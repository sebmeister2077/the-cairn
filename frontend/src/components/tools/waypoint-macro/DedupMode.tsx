// Dedup mode: parse a client-chat.log, detect duplicate waypoints under
// user-controlled criteria (max radius + optional same-color / same-icon /
// same-text matching), and let the user choose which member of each duplicate
// group to delete. Emits `/waypoint remove` commands for the flagged ids.

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { FileUpload } from "@/components/FileUpload";
import { cn } from "@/lib/utils";
import { useReduxState } from "@/store/hooks";
import { parseChatLogWaypoints } from "@/lib/tl-parser";
import { buildRemoveByIdsCommands, type WaypointRecord } from "@/lib/waypoint-macro";
import {
  DEFAULT_DEDUP_CONFIG,
  defaultDeletionIds,
  findDuplicateClusters,
  type DedupConfig,
} from "@/lib/waypoint-dedup";

interface DedupModeProps {
  onCommandsChange: (commands: string[]) => void;
}

// Dev-only sample covering every dedup case so admins can exercise the flow
// without a real client-chat.log on hand. The groups below are designed so the
// detection criteria toggles (radius / color / icon / text) each visibly change
// the results:
//
//   ids 0-2  : exact + near triplet, all same color/icon/name ("Home")
//   ids 3-4  : near pair, SAME color & icon but DIFFERENT names (Peat/Copper)
//   ids 5-6  : near pair, SAME name & icon but DIFFERENT colors (Trader)
//   ids 7-8  : EXACT same coordinate, different color & name (stacked markers)
//   ids 9-10 : same name/color/icon but FAR apart (> default radius) — not dupes
//   id  11   : auto-named junk ("770 57560"), unique location — not a dupe
//   id  12   : lone unique waypoint — never a dupe
const SAMPLE_CHAT_LOG = `7.5.2026 11:35:30 [Chat] Welcome to the Official Public Server! @ 0
7.5.2026 11:35:30 [Chat] Your waypoints: @ 0
7.5.2026 11:35:32 [Chat] 0: Home at 2246, 121, 12557 #204EA2 spiral @ 0
7.5.2026 11:35:32 [Chat] 1: Home at 2246, 121, 12557 #204EA2 spiral @ 0
7.5.2026 11:35:32 [Chat] 2: Home at 2248, 121, 12559 #204EA2 spiral @ 0
7.5.2026 11:35:32 [Chat] 3: Peat at 2092, 119, 13129 #5D3D21 pick @ 0
7.5.2026 11:35:32 [Chat] 4: Copper at 2095, 118, 13131 #5D3D21 pick @ 0
7.5.2026 11:35:32 [Chat] 5: Trader at 244, 121, 753 #F9D0DC trader @ 0
7.5.2026 11:35:32 [Chat] 6: Trader at 246, 121, 755 #85C449 trader @ 0
7.5.2026 11:35:32 [Chat] 7: Vault at -1500, 95, 8800 #F15A4A home @ 0
7.5.2026 11:35:32 [Chat] 8: Storage at -1500, 95, 8800 #204EA2 spiral @ 0
7.5.2026 11:35:32 [Chat] 9: Outpost at 5000, 110, 3000 #FFD700 star @ 0
7.5.2026 11:35:32 [Chat] 10: Outpost at 5800, 112, 3600 #FFD700 star @ 0
7.5.2026 11:35:32 [Chat] 11: 770 57560 at -2912, 139, 51371 #204EA2 spiral @ 0
7.5.2026 11:35:32 [Chat] 12: Iron Mine at 880, 40, 65200 #888888 pick @ 0
`;

export function DedupMode({ onCommandsChange }: DedupModeProps) {
  const isAdmin = useReduxState("auth.isAdmin");
  const showDevTools = import.meta.env.DEV && isAdmin;
  const [records, setRecords] = useState<WaypointRecord[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [config, setConfig] = useState<DedupConfig>(DEFAULT_DEDUP_CONFIG);
  // Record ids the user has flagged for deletion.
  const [deleteIds, setDeleteIds] = useState<Set<number>>(new Set());

  async function handleFile(file: File | null) {
    setParseError(null);
    if (!file) {
      setRecords([]);
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseChatLogWaypoints(text);
      const mapped: WaypointRecord[] = parsed.map((p) => ({
        id: p.index,
        name: p.name,
        x: p.x,
        y: p.y,
        z: p.z,
        color: p.color,
        icon: p.icon,
      }));
      setRecords(mapped);
      if (mapped.length === 0) {
        setParseError(
          "No waypoints found. Make sure the file is your client-chat.log captured right after running /waypoint list details on the Official Public Server.",
        );
      }
    } catch {
      setParseError("Could not read the file.");
      setRecords([]);
    }
  }

  const clusters = useMemo(
    () => findDuplicateClusters(records, config),
    [records, config],
  );

  // Whenever the detected clusters change (new file or changed criteria) reset
  // the selection to the sensible default: keep the first member of each group.
  useEffect(() => {
    setDeleteIds(defaultDeletionIds(clusters));
  }, [clusters]);

  const commands = useMemo(
    () => buildRemoveByIdsCommands([...deleteIds]),
    [deleteIds],
  );

  useEffect(() => onCommandsChange(commands), [commands, onCommandsChange]);

  function toggleDelete(id: number) {
    setDeleteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const flaggedCount = deleteIds.size;
  const duplicateMembers = clusters.reduce((sum, c) => sum + c.members.length, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Find &amp; remove duplicates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FileUpload
            id="dedup-chatlog"
            label="client-chat.log"
            accept=".log,.txt"
            onChange={handleFile}
          />
          {showDevTools && (
            <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 p-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  handleFile(
                    new File([SAMPLE_CHAT_LOG], "client-chat.log", { type: "text/plain" }),
                  )
                }
              >
                Simulate upload
              </Button>
              <span className="text-xs text-muted-foreground">
                Dev/admin only — loads a sample with near-duplicates.
              </span>
            </div>
          )}
          {parseError && <p className="text-sm text-amber-600">{parseError}</p>}

          {records.length > 0 && (
            <>
              {/* Detection criteria */}
              <div className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm font-medium">What counts as a duplicate?</p>
                <div className="grid max-w-xs gap-1.5">
                  <Label htmlFor="dedup-radius">Max radius (blocks)</Label>
                  <Input
                    id="dedup-radius"
                    type="number"
                    min={0}
                    value={Number.isFinite(config.maxRadius) ? config.maxRadius : 0}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        maxRadius: Math.max(0, Math.floor(Number(e.target.value))),
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Markers within this distance of each other (X/Z) are grouped together.
                  </p>
                </div>

                <div className="space-y-2">
                  <ToggleRow
                    label="Must have the same color"
                    checked={config.matchColor}
                    onChange={(v) => setConfig((c) => ({ ...c, matchColor: v }))}
                  />
                  <ToggleRow
                    label="Must have the same icon"
                    checked={config.matchIcon}
                    onChange={(v) => setConfig((c) => ({ ...c, matchIcon: v }))}
                  />
                  <ToggleRow
                    label="Must have the same name"
                    checked={config.matchText}
                    onChange={(v) => setConfig((c) => ({ ...c, matchText: v }))}
                  />
                </div>
              </div>

              {/* Summary */}
              <p className="text-sm text-muted-foreground">
                {clusters.length === 0 ? (
                  <>No duplicates found among {records.length} waypoints.</>
                ) : (
                  <>
                    {clusters.length} duplicate group{clusters.length === 1 ? "" : "s"} (
                    {duplicateMembers} waypoints) · <strong>{flaggedCount}</strong> flagged for
                    deletion.
                  </>
                )}
              </p>

              {/* Clusters */}
              <div className="space-y-3">
                {clusters.map((cluster) => {
                  const keptInCluster = cluster.members.filter(
                    (m) => m.id === undefined || !deleteIds.has(m.id),
                  ).length;
                  return (
                    <div
                      key={cluster.id}
                      className="overflow-hidden rounded-lg border border-border"
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
                        <span className="font-medium">
                          {cluster.members.length} duplicates near {cluster.members[0].x},{" "}
                          {cluster.members[0].z}
                        </span>
                        {keptInCluster === 0 && (
                          <span className="text-amber-600">
                            All flagged — nothing kept from this group
                          </span>
                        )}
                      </div>
                      <ul className="divide-y divide-border/60">
                        {cluster.members.map((m) => {
                          const flagged = m.id !== undefined && deleteIds.has(m.id);
                          return (
                            <li
                              key={m.id ?? `${m.x},${m.z}`}
                              className={cn(
                                "flex items-center gap-3 px-3 py-2 text-sm",
                                flagged && "bg-destructive/5",
                              )}
                            >
                              <Checkbox
                                checked={flagged}
                                disabled={m.id === undefined}
                                onCheckedChange={() => m.id !== undefined && toggleDelete(m.id)}
                                aria-label={
                                  flagged
                                    ? `Keep waypoint ${m.name}`
                                    : `Delete waypoint ${m.name}`
                                }
                              />
                              <span className="w-8 shrink-0 tabular-nums text-xs text-muted-foreground">
                                #{m.id ?? "—"}
                              </span>
                              <span
                                className="inline-block size-3 shrink-0 rounded-full ring-1 ring-foreground/20"
                                style={{ backgroundColor: m.color }}
                                title={m.color}
                              />
                              <span
                                className={cn(
                                  "min-w-0 flex-1 truncate",
                                  flagged && "line-through opacity-60",
                                )}
                                title={m.name}
                              >
                                {m.name}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {m.icon}
                              </span>
                              <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                                {m.x}, {m.y ?? "—"}, {m.z}
                              </span>
                              <span
                                className={cn(
                                  "w-14 shrink-0 text-right text-xs font-medium",
                                  flagged ? "text-destructive" : "text-emerald-600",
                                )}
                              >
                                {flagged ? "Delete" : "Keep"}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
