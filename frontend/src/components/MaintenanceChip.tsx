import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { listActiveMaintenanceNotices, type MaintenanceNotice } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // refresh notice list every 5 minutes

interface MaintenanceChipProps {
  /** Component identifier whose active notice should be displayed. */
  component: string;
  className?: string;
}

/**
 * Public-facing chip that surfaces an admin-set maintenance window.
 *
 * Renders nothing when no notice is active for ``component``. Otherwise
 * shows a wrench badge with a live, self-updating countdown:
 *   • "Maintenance — fix in 12h 5m"
 *   • "Maintenance — fix in 4m"
 *   • "Maintenance — overdue by 12m" (when the ETA has passed)
 *
 * Hovering reveals the admin-supplied message (if any) and the absolute
 * timestamps for ETA and start via a native title tooltip.
 */
export function MaintenanceChip({ component, className }: MaintenanceChipProps) {
  const { data } = useQuery({
    queryKey: ["maintenance-notices"],
    queryFn: listActiveMaintenanceNotices,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 30 * 1000,
  });

  const notice = useMemo<MaintenanceNotice | undefined>(
    () => data?.notices.find((n) => n.component === component && n.active),
    [data, component],
  );

  // Tick every 30s so the human-readable countdown stays fresh
  // without re-rendering on every animation frame.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!notice) return;
    const id = window.setInterval(() => setNow((v) => v + 1), 30 * 1000);
    return () => window.clearInterval(id);
  }, [notice]);

  if (!notice) return null;

  const etaMs = notice.eta_at ? new Date(notice.eta_at).getTime() : null;
  const startedMs = new Date(notice.started_at).getTime();
  const nowMs = Date.now();

  let label = "Maintenance";
  let overdue = false;
  if (etaMs != null && Number.isFinite(etaMs)) {
    const diff = etaMs - nowMs;
    if (diff > 0) {
      label = `Maintenance — fix in ${formatDuration(diff)}`;
    } else {
      overdue = true;
      label = `Maintenance — overdue by ${formatDuration(-diff)}`;
    }
  }

  const tooltipParts: string[] = [];
  if (notice.message) tooltipParts.push(notice.message);
  if (etaMs != null) tooltipParts.push(`ETA: ${new Date(etaMs).toLocaleString()}`);
  tooltipParts.push(`Started: ${new Date(startedMs).toLocaleString()}`);
  const title = tooltipParts.join("\n");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className={cn(
              "gap-1 border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300 cursor-help",
              overdue && "border-destructive/50 bg-destructive/10 text-destructive",
              className,
            )}
          >
            <Wrench className="size-3" />
            {label}
          </Badge>
        }
      />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Human-readable duration. Always positive — caller decides the prefix.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days >= 1) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours >= 1) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes >= 1) return `${minutes}m`;
  return "<1m";
}
