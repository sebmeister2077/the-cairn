import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useState, useEffect } from "react";

export interface QuotaFlagSpec {
  key: string;
  label: string;
  help: string;
  unit: string;
  defaultValue: number;
  min: number;
  max: number;
}

export const QUOTA_FLAGS: QuotaFlagSpec[] = [
  {
    key: "traders_chatlog_daily_cap",
    label: "Trader chat-log daily cap",
    help: "Per-user max approved trader chat-log submissions per rolling 24h window. Admins bypass.",
    unit: "per 24h",
    defaultValue: 1,
    min: 0,
    max: 50,
  },
  {
    key: "traders_manual_daily_cap",
    label: "Trader manual-form daily cap",
    help: "Per-user max approved manual trader submissions per rolling 24h window. Admins bypass.",
    unit: "per 24h",
    defaultValue: 15,
    min: 0,
    max: 500,
  },
  {
    key: "traders_max_batch",
    label: "Trader batch size cap",
    help: "Max number of trader waypoints accepted in a single POST.",
    unit: "items",
    defaultValue: 200,
    min: 1,
    max: 2000,
  },
  {
    key: "traders_dedupe_radius",
    label: "Trader dedupe radius",
    help: "Two trader waypoints within this radius (blocks) are treated as duplicates.",
    unit: "blocks",
    defaultValue: 60,
    min: 1,
    max: 1000,
  },
  {
    key: "translocators_chatlog_daily_cap",
    label: "Translocator chat-log daily cap",
    help: "Per-API-key max translocator chat-log submissions per rolling 24h window (in-memory).",
    unit: "per 24h",
    defaultValue: 3,
    min: 0,
    max: 100,
  },
  {
    key: "translocators_manual_daily_cap",
    label: "Translocator manual-entry daily cap",
    help: "Per-API-key max manual translocator submissions per rolling 24h window. Admins bypass.",
    unit: "per 24h",
    defaultValue: 15,
    min: 0,
    max: 500,
  },
  {
    key: "translocators_max_batch",
    label: "Translocator batch size cap",
    help: "Max number of translocator segments accepted in a single POST.",
    unit: "items",
    defaultValue: 200,
    min: 1,
    max: 2000,
  },
  {
    key: "translocators_dedupe_radius",
    label: "Translocator dedupe radius",
    help: "Two translocator endpoints within this radius (blocks) are treated as overlapping.",
    unit: "blocks",
    defaultValue: 200,
    min: 1,
    max: 2000,
  },
  {
    key: "translocator_screenshots_max_pending",
    label: "Translocator screenshot pending cap",
    help: "Per-user max pending translocator screenshot requests awaiting review.",
    unit: "pending",
    defaultValue: 90,
    min: 1,
    max: 1000,
  },
  {
    key: "map_contribution_cooldown_days",
    label: "Map contribution cooldown",
    help: "Days a non-admin user must wait after an approved map contribution before submitting another.",
    unit: "days",
    defaultValue: 7,
    min: 0,
    max: 365,
  },
];
export function QuotaFlagRow({
  spec,
  current,
  updatedAt,
  pending,
  onSave,
}: {
  spec: QuotaFlagSpec;
  current: number | null;
  updatedAt: string | undefined;
  pending: boolean;
  onSave: (value_int: number | null) => void;
}) {
  const [draft, setDraft] = useState<string>(current === null ? "" : String(current));

  // Resync draft when the canonical value changes (e.g. after a successful
  // mutation or a refetch), without clobbering an in-progress edit.
  useEffect(() => {
    setDraft(current === null ? "" : String(current));
  }, [current]);

  const placeholder = String(spec.defaultValue);
  const usingDefault = current === null;

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (!usingDefault) onSave(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return;
    if (parsed < spec.min || parsed > spec.max) return;
    if (parsed === current) return;
    onSave(parsed);
  };

  return (
    <div className="flex flex-col gap-1 border-b last:border-0 pb-3 last:pb-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-sm">{spec.label}</span>
        <Badge variant="outline" className="font-mono text-[10px]">
          {spec.key}
        </Badge>
        {usingDefault ? (
          <Badge variant="secondary" className="text-[10px]">
            default ({spec.defaultValue} {spec.unit})
          </Badge>
        ) : (
          <Badge className="text-[10px]">
            {current} {spec.unit}
          </Badge>
        )}
      </div>
      {spec.help && <p className="text-xs text-muted-foreground">{spec.help}</p>}
      <div className="flex items-center gap-2 mt-1">
        <input
          type="number"
          min={spec.min}
          max={spec.max}
          step={1}
          inputMode="numeric"
          value={draft}
          placeholder={placeholder}
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="h-8 w-28 rounded border bg-background px-2 text-sm"
        />
        <span className="text-xs text-muted-foreground">{spec.unit}</span>
        <span className="text-[10px] text-muted-foreground">
          (min {spec.min}, max {spec.max})
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || usingDefault}
          onClick={() => onSave(null)}
        >
          Reset to default
        </Button>
        {pending && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>
      {updatedAt && (
        <p className="text-[10px] text-muted-foreground">
          Updated {new Date(updatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
