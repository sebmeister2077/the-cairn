import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Crosshair, Loader2, Trash2, X } from "lucide-react";
import { TRADER_TYPE_COLORS, TRADER_TYPE_LABELS, isTraderType } from "@/lib/trader-types";
import type { AdminTraderInArea } from "@/lib/api";
import type { AdminTraderAreaTool } from "@/hooks/useAdminTraderAreaTool";

function formatWhen(iso: string | null): string {
  if (!iso) return "unknown date";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function MethodBadge({ source }: { source: AdminTraderInArea["source"] }) {
  const label = source === "chatlog" ? "chat-log" : source === "manual" ? "manual" : "unknown";
  const cls =
    source === "chatlog"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : source === "manual"
        ? "bg-sky-500/15 text-sky-700 dark:text-sky-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>
  );
}

interface Props {
  tool: AdminTraderAreaTool;
}

/**
 * Admin-only floating panel (fullscreen map): pick a location, review the
 * traders inside the selected area — with who added each, when, and by which
 * method (manual vs chat-log) — then bulk-remove the selected ones behind a
 * confirmation dialog.
 */
export function AdminTraderAreaPanel({ tool }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const selectedCount = tool.selectedIds.size;

  const handleConfirm = async () => {
    try {
      await tool.deleteSelected();
    } finally {
      setConfirmOpen(false);
    }
  };

  return (
    <div className="pointer-events-auto absolute left-3 top-28 z-30 flex w-[min(92vw,22rem)] flex-col gap-3 rounded-md border bg-background/95 p-3 shadow-lg backdrop-blur sm:left-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Remove traders in area</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={tool.close}
          aria-label="Close area tool"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant={tool.picking ? "default" : "outline"}
          size="sm"
          onClick={tool.picking ? tool.cancelPicking : tool.startPicking}
        >
          <Crosshair className="mr-1 size-4" />
          {tool.picking ? "Click the map…" : tool.center ? "Re-pick location" : "Pick location"}
        </Button>
        {tool.center && (
          <span className="text-xs text-muted-foreground">
            {tool.center.x}, {tool.center.z}
          </span>
        )}
      </div>

      {tool.center && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Radius</span>
            <span>{tool.radius} blocks</span>
          </div>
          <div className="flex items-center gap-3">
            <Slider
              value={tool.radius}
              min={25}
              max={2000}
              step={25}
              onValueChange={(v) => tool.setRadius(v)}
              className="flex-1"
            />
            <Input
              type="number"
              value={tool.radius}
              min={25}
              max={5000}
              step={25}
              onChange={(e) => tool.setRadius(Number(e.target.value))}
              className="h-8 w-20 shrink-0"
            />
          </div>
        </div>
      )}

      {tool.center && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {tool.isFetching ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" /> Loading…
              </span>
            ) : tool.isError ? (
              <span className="text-destructive">Failed to load traders</span>
            ) : (
              `${tool.traders.length} trader${tool.traders.length === 1 ? "" : "s"} in area`
            )}
          </span>
          {tool.traders.length > 0 && (
            <div className="flex gap-2">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={tool.selectAll}
              >
                All
              </button>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={tool.clearSelection}
              >
                None
              </button>
            </div>
          )}
        </div>
      )}

      {tool.traders.length > 0 && (
        <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto overscroll-contain pr-1">
          {tool.traders.map((t) => {
            const type = isTraderType(t.trader_type) ? t.trader_type : null;
            const color = type ? TRADER_TYPE_COLORS[type] : "#22d3ee";
            const typeLabel = type ? TRADER_TYPE_LABELS[type] : "Trader";
            return (
              <li
                key={t.trader_id}
                className="flex items-start gap-2 rounded border bg-card/50 p-2 text-xs"
              >
                <Checkbox
                  checked={tool.selectedIds.has(t.trader_id)}
                  onCheckedChange={() => tool.toggleId(t.trader_id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="truncate font-medium">{t.label || typeLabel}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {t.x}, {t.z}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                    <span className="truncate">by {t.actor_display_name || "unknown"}</span>
                    <span>·</span>
                    <span>{formatWhen(t.created_at)}</span>
                    <MethodBadge source={t.source} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {tool.lastDeletedCount != null && (
        <p className="text-xs text-green-600 dark:text-green-400">
          Removed {tool.lastDeletedCount} trader
          {tool.lastDeletedCount === 1 ? "" : "s"}.
        </p>
      )}

      <Button
        variant="destructive"
        size="sm"
        disabled={selectedCount === 0 || tool.isDeleting}
        onClick={() => setConfirmOpen(true)}
      >
        {tool.isDeleting ? (
          <Loader2 className="mr-1 size-4 animate-spin" />
        ) : (
          <Trash2 className="mr-1 size-4" />
        )}
        Remove {selectedCount} selected
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        title={`Remove ${selectedCount} trader${selectedCount === 1 ? "" : "s"}?`}
        description="This permanently removes the selected traders from the map. An audit entry is recorded for each. This cannot be undone."
        confirmLabel="Remove"
        variant="destructive"
        loading={tool.isDeleting}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
