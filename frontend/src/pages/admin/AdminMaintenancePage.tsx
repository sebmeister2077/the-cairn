/**
 * Admin: Maintenance notices (route: /manage/maintenance).
 *
 * Lets the on-call admin pin a "Maintenance" chip on a public-facing
 * component (e.g. the TOPS Map Viewer) and pick a target ETA. The chip
 * stays up — and shows a live countdown — until the admin turns it off
 * here, even if the original ETA has elapsed.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, Loader2, Power, PowerOff, Wrench } from "lucide-react";

import {
  adminClearMaintenanceNotice,
  adminListMaintenanceNotices,
  adminUpsertMaintenanceNotice,
  type KnownMaintenanceComponent,
  type MaintenanceNotice,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const QUICK_DURATIONS_HOURS: { label: string; hours: number }[] = [
  { label: "30 min", hours: 0.5 },
  { label: "1 hr", hours: 1 },
  { label: "4 hr", hours: 4 },
  { label: "8 hr", hours: 8 },
  { label: "12 hr", hours: 12 },
  { label: "24 hr", hours: 24 },
  { label: "2 days", hours: 48 },
];

export function AdminMaintenancePage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-maintenance-notices"],
    queryFn: adminListMaintenanceNotices,
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Maintenance notices</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Pin a maintenance chip to a public component while you fix it. Visitors see a live
          countdown until you turn it off.
        </p>
      </div>

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {data && (
        <div className="space-y-3">
          {data.known_components.map((comp) => {
            const notice = data.notices.find((n) => n.component === comp.id);
            return (
              <ComponentNoticeCard
                key={comp.id}
                component={comp}
                notice={notice}
                onChanged={() =>
                  queryClient.invalidateQueries({
                    queryKey: ["admin-maintenance-notices"],
                  })
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ComponentNoticeCardProps {
  component: KnownMaintenanceComponent;
  notice: MaintenanceNotice | undefined;
  onChanged: () => void;
}

function ComponentNoticeCard({ component, notice, onChanged }: ComponentNoticeCardProps) {
  const queryClient = useQueryClient();
  const isActive = !!notice?.active;

  // Editable form state — seeded from the notice (when one exists) so the
  // admin can tweak the message / extend the ETA without re-typing.
  const [message, setMessage] = useState(notice?.message ?? "");
  const [etaInput, setEtaInput] = useState<string>(() => toDatetimeLocal(notice?.eta_at ?? null));
  // Tick so the "fix in / overdue by" line stays fresh while admin lingers.
  const [, setTick] = useState(0);
  const [showConfirmOffFor, setShowConfirmOffFor] = useState<KnownMaintenanceComponent | null>(
    null,
  );
  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), 30 * 1000);
    return () => window.clearInterval(id);
  }, []);

  // Reseed form when the underlying notice changes (e.g. after a save).
  useEffect(() => {
    setMessage(notice?.message ?? "");
    setEtaInput(toDatetimeLocal(notice?.eta_at ?? null));
  }, [notice?.eta_at, notice?.message, notice?.active]);

  const upsertMut = useMutation({
    mutationFn: (body: Parameters<typeof adminUpsertMaintenanceNotice>[1]) =>
      adminUpsertMaintenanceNotice(component.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-maintenance-notices"] });
      // Public chip pollers should also pick this up sooner than their poll.
      queryClient.invalidateQueries({ queryKey: ["maintenance-notices"] });
      onChanged();
    },
  });

  const clearMut = useMutation({
    mutationFn: () => adminClearMaintenanceNotice(component.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-maintenance-notices"] });
      queryClient.invalidateQueries({ queryKey: ["maintenance-notices"] });
      onChanged();
      setShowConfirmOffFor(null);
    },
  });

  const countdown = useMemo(() => {
    if (!notice?.eta_at) return null;
    const diff = new Date(notice.eta_at).getTime() - Date.now();
    return diff;
  }, [notice?.eta_at]);

  const busy = upsertMut.isPending || clearMut.isPending;

  function handleQuickDuration(hours: number) {
    upsertMut.mutate({
      active: true,
      message: message.trim(),
      duration_hours: hours,
    });
  }

  function handleSaveCustom() {
    if (!etaInput) return;
    const eta = new Date(etaInput);
    if (Number.isNaN(eta.getTime())) return;
    upsertMut.mutate({
      active: true,
      message: message.trim(),
      eta_at: eta.toISOString(),
    });
  }

  function handleUpdateMessageOnly() {
    if (!notice?.eta_at) return;
    upsertMut.mutate({
      active: true,
      message: message.trim(),
      eta_at: notice.eta_at,
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wrench className="size-4" />
            {component.label}
          </CardTitle>
          <p className="text-xs text-muted-foreground font-mono">{component.id}</p>
        </div>
        {isActive ? (
          <Badge
            variant="outline"
            className="border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          >
            <Power className="size-3" />
            Active
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            <PowerOff className="size-3" />
            Off
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {isActive && notice && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm space-y-1">
            <div className="flex items-center gap-2 font-medium">
              <Clock className="size-3.5" />
              {countdown == null
                ? "No ETA set"
                : countdown > 0
                  ? `Fix expected in ${formatDuration(countdown)}`
                  : `Overdue by ${formatDuration(-countdown)}`}
            </div>
            {notice.eta_at && (
              <div className="text-xs text-muted-foreground">
                ETA: {new Date(notice.eta_at).toLocaleString()}
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              Started: {new Date(notice.started_at).toLocaleString()}
            </div>
            {notice.message && (
              <div className="text-xs text-muted-foreground italic">
                &ldquo;{notice.message}&rdquo;
              </div>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={`msg-${component.id}`}>Public message (optional)</Label>
          <Input
            id={`msg-${component.id}`}
            placeholder="e.g. Rebuilding TOPS map after data import"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={busy}
            maxLength={200}
          />
        </div>

        <div className="space-y-2">
          <Label>Maintenance for</Label>
          <div className="flex flex-wrap gap-2">
            {QUICK_DURATIONS_HOURS.map((opt) => (
              <Button
                key={opt.hours}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => handleQuickDuration(opt.hours)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Quick durations are computed from <em>now</em>. Use the custom ETA below to extend an
            active window without resetting the start time.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`eta-${component.id}`}>Custom ETA</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={`eta-${component.id}`}
              type="datetime-local"
              value={etaInput}
              onChange={(e) => setEtaInput(e.target.value)}
              disabled={busy}
              className="max-w-xs"
            />
            <Button type="button" size="sm" onClick={handleSaveCustom} disabled={busy || !etaInput}>
              {upsertMut.isPending ? (
                <Loader2 className="size-3.5 mr-1 animate-spin" />
              ) : (
                <CheckCircle2 className="size-3.5 mr-1" />
              )}
              {isActive ? "Update ETA" : "Turn on with this ETA"}
            </Button>
            {isActive && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleUpdateMessageOnly}
                disabled={busy}
              >
                Save message only
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-3">
          <p className="text-xs text-muted-foreground">
            {isActive
              ? "Visitors currently see the maintenance chip on this component."
              : "No chip is shown to visitors right now."}
          </p>
          {isActive && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => setShowConfirmOffFor(component)}
            >
              {clearMut.isPending ? (
                <Loader2 className="size-3.5 mr-1 animate-spin" />
              ) : (
                <PowerOff className="size-3.5 mr-1" />
              )}
              Turn off
            </Button>
          )}
        </div>
        <ConfirmDialog
          open={Boolean(showConfirmOffFor)}
          title="Turn off?"
          loading={clearMut.isPending}
          description={`Turn off maintenance for ${showConfirmOffFor?.label}?`}
          onConfirm={() => clearMut.mutate()}
          onCancel={() => setShowConfirmOffFor(null)}
        />

        {(upsertMut.error || clearMut.error) && (
          <p className="text-xs text-destructive">
            {((upsertMut.error || clearMut.error) as Error).message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Format a duration in ms to a compact "1d 4h" / "12h 5m" / "5m" string. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days >= 1) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours >= 1) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes >= 1) return `${minutes}m`;
  return "<1m";
}

/**
 * Convert an ISO timestamp (or null) to the local-time string format
 * accepted by ``<input type="datetime-local">`` (YYYY-MM-DDTHH:mm).
 */
function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
