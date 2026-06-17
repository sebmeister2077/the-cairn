// Import mode: pull waypoints from the landmarks / traders / translocators
// overlays, filter them, optionally recolor them, exclude individual rows,
// and generate ADD (addati) commands.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  useLandmarksOverlay,
  useTradersOverlay,
  useTranslocatorsOverlay,
} from "@/hooks/useOverlayData";
import {
  TRADER_TYPES,
  TRADER_TYPE_COLORS,
  TRADER_TYPE_LABELS,
  type TraderType,
} from "@/lib/trader-types";
import { buildAddCommands, DEFAULT_WAYPOINT_Y, type WaypointRecord } from "@/lib/waypoint-macro";
import { WaypointRecordTable } from "./WaypointRecordTable";

type ImportSource = "landmarks" | "traders" | "translocators";

/** A record paired with a stable key so rows can be individually excluded. */
interface KeyedRecord {
  key: string;
  record: WaypointRecord;
}

interface ImportModeProps {
  onCommandsChange: (commands: string[]) => void;
}

const SOURCE_DEFAULT_ICON: Record<ImportSource, string> = {
  landmarks: "star",
  traders: "trader",
  translocators: "spiral",
};

const SOURCE_DEFAULT_COLOR: Record<ImportSource, string> = {
  landmarks: "#FFD700",
  traders: "#F9D0DC",
  translocators: "#204EA2",
};

export function ImportMode({ onCommandsChange }: ImportModeProps) {
  const [source, setSource] = useState<ImportSource>("landmarks");
  const [defaultY, setDefaultY] = useState<number>(DEFAULT_WAYPOINT_Y);

  // Source-specific filters.
  const [nameSearch, setNameSearch] = useState("");
  const [traderTypes, setTraderTypes] = useState<Set<TraderType>>(new Set());

  // Color override.
  const [applyColor, setApplyColor] = useState(false);
  const [overrideColor, setOverrideColor] = useState("#FFFFFF");
  // Debounced copy used for the (expensive) recolor of the whole list so
  // dragging the color picker stays smooth.
  const [debouncedColor, setDebouncedColor] = useState(overrideColor);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedColor(overrideColor), 150);
    return () => window.clearTimeout(id);
  }, [overrideColor]);

  // Per-row exclusions (keyed). Reset when the source changes.
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());

  const landmarks = useLandmarksOverlay();
  const traders = useTradersOverlay();
  const translocators = useTranslocatorsOverlay();

  const active =
    source === "landmarks" ? landmarks : source === "traders" ? traders : translocators;
  const isLoading = active.isLoading;
  const isError = active.isError;

  function changeSource(next: ImportSource) {
    if (next === source) return;
    setSource(next);
    setNameSearch("");
    setTraderTypes(new Set());
    setExcludedKeys(new Set());
  }

  function toggleTraderType(tt: TraderType) {
    setTraderTypes((prev) => {
      const next = new Set(prev);
      if (next.has(tt)) next.delete(tt);
      else next.add(tt);
      return next;
    });
  }

  function toggleExclude(key: string) {
    setExcludedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Build the keyed records for the active source, applying source-specific
  // filters. Color override is applied here too so the preview reflects it.
  const keyed = useMemo<KeyedRecord[]>(() => {
    const icon = SOURCE_DEFAULT_ICON[source];
    const fallback = SOURCE_DEFAULT_COLOR[source];
    const needle = nameSearch.trim().toLowerCase();
    const recolor = (c: string) => (applyColor ? debouncedColor : c);

    if (source === "landmarks") {
      return (landmarks.data?.data ?? [])
        .map(
          (m, i): KeyedRecord => ({
            key: `landmark-${i}`,
            record: {
              name: m.label ?? "Landmark",
              x: m.x,
              z: m.z,
              color: recolor(m.color ?? fallback),
              icon,
            },
          }),
        )
        .filter((kr) => !needle || kr.record.name.toLowerCase().includes(needle));
    }

    if (source === "traders") {
      return (traders.data?.data ?? [])
        .filter((m) => traderTypes.size === 0 || traderTypes.has(m.trader_type))
        .map(
          (m, i): KeyedRecord => ({
            key: `trader-${i}`,
            record: {
              name: m.label ?? TRADER_TYPE_LABELS[m.trader_type],
              x: m.x,
              z: m.z,
              color: recolor(m.color ?? TRADER_TYPE_COLORS[m.trader_type] ?? fallback),
              icon,
            },
          }),
        );
    }

    // Translocators: each segment yields two endpoint waypoints.
    const out: KeyedRecord[] = [];
    (translocators.data?.data ?? []).forEach((seg, i) => {
      out.push({
        key: `tl-${i}-a`,
        record: {
          name: `TL ${seg.x2} ${seg.z2}`,
          x: seg.x1,
          y: seg.y1,
          z: seg.z1,
          color: recolor(fallback),
          icon,
        },
      });
      out.push({
        key: `tl-${i}-b`,
        record: {
          name: `TL ${seg.x1} ${seg.z1}`,
          x: seg.x2,
          y: seg.y2,
          z: seg.z2,
          color: recolor(fallback),
          icon,
        },
      });
    });
    return needle ? out.filter((kr) => kr.record.name.toLowerCase().includes(needle)) : out;
  }, [
    source,
    nameSearch,
    traderTypes,
    applyColor,
    debouncedColor,
    landmarks.data,
    traders.data,
    translocators.data,
  ]);

  const filteredRecords = useMemo(() => keyed.map((kr) => kr.record), [keyed]);
  const includedRecords = useMemo(
    () => keyed.filter((kr) => !excludedKeys.has(kr.key)).map((kr) => kr.record),
    [keyed, excludedKeys],
  );

  const commands = useMemo(
    () => (includedRecords.length === 0 ? [] : buildAddCommands(includedRecords, defaultY)),
    [includedRecords, defaultY],
  );

  useEffect(() => onCommandsChange(commands), [commands, onCommandsChange]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import from map data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label>Source</Label>
              <Select value={source} onValueChange={(v) => v && changeSource(v as ImportSource)}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="landmarks">Landmarks</SelectItem>
                  <SelectItem value="traders">Traders</SelectItem>
                  <SelectItem value="translocators">Translocators</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="default-y">Default Y (depth)</Label>
              <Input
                id="default-y"
                type="number"
                className="w-28"
                value={Number.isFinite(defaultY) ? defaultY : ""}
                onChange={(e) => setDefaultY(Number(e.target.value))}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Map data has no Y coordinate for most markers, so the default above is used when one is
            missing. Translocators contribute a waypoint at each endpoint.
          </p>

          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading {source}…
            </div>
          )}
          {isError && <p className="text-sm text-red-500">Failed to load {source}.</p>}

          {!isLoading && !isError && (
            <>
              {/* Source-specific filters */}
              {(source === "landmarks" || source === "translocators") && (
                <div className="grid max-w-sm gap-1.5">
                  <Label htmlFor="name-search">Search by name</Label>
                  <Input
                    id="name-search"
                    value={nameSearch}
                    placeholder="Type to filter…"
                    onChange={(e) => setNameSearch(e.target.value)}
                  />
                </div>
              )}

              {source === "traders" && (
                <div className="space-y-1.5">
                  <Label>Trader types</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {TRADER_TYPES.map((tt) => {
                      const selected = traderTypes.has(tt);
                      return (
                        <Button
                          key={tt}
                          type="button"
                          size="sm"
                          variant={selected ? "default" : "outline"}
                          onClick={() => toggleTraderType(tt)}
                        >
                          <span
                            className="mr-1.5 inline-block size-2.5 rounded-full ring-1 ring-foreground/20"
                            style={{ backgroundColor: TRADER_TYPE_COLORS[tt] }}
                          />
                          {TRADER_TYPE_LABELS[tt]}
                        </Button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {traderTypes.size === 0
                      ? "All trader types included."
                      : `${traderTypes.size} type(s) selected.`}
                  </p>
                </div>
              )}

              {/* Color manipulation */}
              <div className="space-y-1.5">
                <Label>Color</Label>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name="import-color-mode"
                      checked={!applyColor}
                      onChange={() => setApplyColor(false)}
                    />
                    Keep source color
                  </label>
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name="import-color-mode"
                      checked={applyColor}
                      onChange={() => setApplyColor(true)}
                    />
                    Apply one color
                  </label>
                  <div className={cn("flex items-center gap-2", !applyColor && "opacity-40")}>
                    <input
                      type="color"
                      className="size-8 cursor-pointer rounded border border-border bg-transparent"
                      value={/^#[0-9A-Fa-f]{6}$/.test(overrideColor) ? overrideColor : "#FFFFFF"}
                      disabled={!applyColor}
                      onChange={(e) => setOverrideColor(e.target.value)}
                      aria-label="Override color"
                    />
                    <Input
                      className="w-28"
                      value={overrideColor}
                      disabled={!applyColor}
                      placeholder="#FFFFFF"
                      onChange={(e) => setOverrideColor(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <p className="text-sm text-muted-foreground">
                {includedRecords.length} of {filteredRecords.length} markers included
                {excludedKeys.size > 0 && ` (${excludedKeys.size} excluded)`}.
              </p>
              <WaypointRecordTable
                records={filteredRecords}
                rowKey={(_, i) => keyed[i]?.key ?? String(i)}
                excludedKeys={excludedKeys}
                onToggleExclude={toggleExclude}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
