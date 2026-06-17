// Upload mode: parse a client-chat.log, filter waypoints, and generate either
// ADD (re-add) or REMOVE commands.

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileUpload } from "@/components/FileUpload";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { parseChatLogWaypoints } from "@/lib/tl-parser";
import { applyFilters, type WaypointFilter } from "@/lib/waypoint-filters";
import {
  buildAddCommands,
  buildRemoveByIdsCommands,
  type WaypointRecord,
} from "@/lib/waypoint-macro";
import { FilterEditor } from "./FilterEditor";
import { WaypointRecordTable } from "./WaypointRecordTable";

type UploadOperation = "add" | "remove";

interface UploadModeProps {
  onCommandsChange: (commands: string[]) => void;
}

export function UploadMode({ onCommandsChange }: UploadModeProps) {
  const [records, setRecords] = useState<WaypointRecord[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [filters, setFilters] = useState<WaypointFilter[]>([]);
  const [operation, setOperation] = useState<UploadOperation>("remove");

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

  const filtered = useMemo(() => applyFilters(records, filters), [records, filters]);

  const commands = useMemo(() => {
    if (filtered.length === 0) return [];
    return operation === "add"
      ? buildAddCommands(filtered)
      : buildRemoveByIdsCommands(
          filtered.map((r) => r.id).filter((id): id is number => id !== undefined),
        );
  }, [filtered, operation]);

  // Push the generated commands up to the page whenever they change.
  useEffect(() => onCommandsChange(commands), [commands, onCommandsChange]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload chat log</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FileUpload
            id="chatlog"
            label="client-chat.log"
            accept=".log,.txt"
            onChange={handleFile}
          />
          {parseError && <p className="text-sm text-amber-600">{parseError}</p>}

          {records.length > 0 && (
            <>
              <div className="grid max-w-xs gap-1.5">
                <Label>Operation</Label>
                <Select
                  value={operation}
                  onValueChange={(v) => v && setOperation(v as UploadOperation)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="remove">Remove these waypoints</SelectItem>
                    <SelectItem value="add">Re-add these waypoints</SelectItem>
                  </SelectContent>
                </Select>
                {operation === "remove" && (
                  <p className="text-xs text-muted-foreground">
                    Removals are ordered highest-id first so ids don't shift mid-macro.
                  </p>
                )}
              </div>

              <FilterEditor filters={filters} onChange={setFilters} allowIcon />

              <p className="text-sm text-muted-foreground">
                {filtered.length} of {records.length} waypoints selected.
              </p>
              <WaypointRecordTable records={filtered} showId />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
