import { type AdminUserListItem, adminUsage, type UsageActorHistory } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

/**
 * Admin per-account activity history: the signed-in `page.view` +
 * advanced-map `layer.*` telemetry for one account, newest first. Read-only.
 */
export function UserHistoryDialog({
  target,
  onClose,
}: {
  target: AdminUserListItem | null;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["actor-history", target?.api_key],
    queryFn: () => adminUsage.actorHistory({ api_key: target!.api_key, limit: 200 }),
    enabled: !!target,
  });

  if (!target) return null;
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Activity history — {target.display_name}</DialogTitle>
          <DialogDescription>
            Pages visited and advanced map-layer changes for this account, newest first. Times in
            UTC.
          </DialogDescription>
        </DialogHeader>
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.isError && <p className="text-sm text-destructive">Failed to load history.</p>}
        {q.data && q.data.events.length === 0 && (
          <p className="text-sm text-muted-foreground">No recorded activity in the last 30 days.</p>
        )}
        {q.data && q.data.events.length > 0 && (
          <div className="max-h-[60vh] overflow-y-auto space-y-1">
            {q.data.events.map((e, i) => (
              <HistoryRow key={`${e.created_at}-${i}`} event={e} />
            ))}
            {q.data.has_more && (
              <p className="text-xs text-muted-foreground pt-2 text-center">
                Showing the most recent {q.data.limit} events.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryRow({ event }: { event: UsageActorHistory["events"][number] }) {
  const when = new Date(event.created_at);
  const meta = event.metadata ?? {};
  return (
    <div className="text-sm border rounded p-2 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant={event.category === "page" ? "secondary" : "outline"}>
            {event.category === "page" ? "Page" : "Layer"}
          </Badge>
          <span className="font-mono text-xs truncate">
            {describeEvent(event.event_type, meta)}
          </span>
        </div>
        {renderMetaDetail(meta)}
      </div>
      <time className="text-xs text-muted-foreground whitespace-nowrap" dateTime={event.created_at}>
        {when.toLocaleString()}
      </time>
    </div>
  );
}

function describeEvent(eventType: string, meta: Record<string, unknown>): string {
  if (eventType === "page.view") return String(meta.path ?? "/");
  if (eventType.startsWith("layer.")) {
    const action = eventType.slice("layer.".length);
    if (action === "snapshot") return "config snapshot";
    const layer = typeof meta.layer === "string" ? meta.layer : "";
    return `${layer} ${action}`.trim();
  }
  return eventType;
}

function renderMetaDetail(meta: Record<string, unknown>) {
  const parts: string[] = [];
  if (typeof meta.ref === "string") parts.push(`ref: ${meta.ref}`);
  if (typeof meta.duration_ms === "number" && meta.duration_ms > 0) {
    parts.push(`active ${Math.round(meta.duration_ms / 1000)}s`);
  }
  const settings = meta.settings;
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    const entries = Object.entries(settings as Record<string, unknown>).slice(0, 6);
    for (const [k, v] of entries) parts.push(`${k}=${String(v)}`);
  }
  if (parts.length === 0) return null;
  return <div className="text-xs text-muted-foreground mt-0.5 break-all">{parts.join(" · ")}</div>;
}
