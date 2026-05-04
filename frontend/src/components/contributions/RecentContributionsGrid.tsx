import type { HistoryEntry } from "@/models/contributions";
import { ImageOff, Loader2, Undo2, History } from "lucide-react";
import { useState } from "react";
import { MapViewer } from "../MapViewer";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Recent contributions grid
//
// Renders a thumbnail grid of approved/withdrawn contributions whose preview
// PNG is in the history bucket (kept indefinitely — all-time history).
// Clicking a tile expands it inline to a larger view. Anonymous-by-default
// — the contributor is shown only when the viewer has permission to see
// contributor names.
// ---------------------------------------------------------------------------
export function RecentContributionsGridImpl({
  history,
  isAdmin,
  totalCount,
  revertWindowDays,
  onRevert,
}: {
  history: HistoryEntry[];
  isAdmin: boolean;
  totalCount: number;
  revertWindowDays: number;
  onRevert: (id: string) => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  // Two-step revert: clicking the destructive button stages the entry
  // here, which opens a themed ConfirmDialog instead of the browser's
  // native window.confirm() (which feels jarring inside the admin UI
  // and can't be styled per page).
  const [pendingRevert, setPendingRevert] = useState<HistoryEntry | null>(null);
  const opened = openId ? (history.find((h) => h.id === openId) ?? null) : null;

  const requestRevert = (entry: HistoryEntry) => {
    setRevertError(null);
    setPendingRevert(entry);
  };

  async function confirmRevert() {
    if (!pendingRevert) return;
    const entry = pendingRevert;
    setRevertError(null);
    setRevertingId(entry.id);
    try {
      await onRevert(entry.id);
      setOpenId(null);
      setPendingRevert(null);
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : "Revert failed");
      // Keep the dialog open so the operator can read the error and
      // either retry or cancel.
    } finally {
      setRevertingId(null);
    }
  }

  function getMapViewerLegend(opened: HistoryEntry) {
    switch (opened.status) {
      case "withdrawn":
        return "[Withdrawn] · preview retained for transparency";
      case "reverted":
        return `Reverted · originally by ${opened.contributor}`;
      case "orphaned_by_restore":
        return `Orphaned by backup restore · ${opened.contributor}`;
      case "approved":
        return `${opened.contributor} · approved ${
          opened.approved_at ? new Date(opened.approved_at).toLocaleString() : ""
        }`;
      default:
        return `${opened.contributor} · status: ${opened.status}`;
    }
  }

  const pendingTilesNew = pendingRevert?.revert_added_count ?? pendingRevert?.tiles_new ?? 0;
  const pendingTilesReplaced = pendingRevert?.revert_replaced_count ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" />
          Recent Contributions
          <Badge variant="secondary" className="ml-1 font-normal">
            all-time
          </Badge>
        </CardTitle>
        {isAdmin && totalCount > history.length && (
          <p className="text-xs text-muted-foreground">
            Showing {history.length} of {totalCount.toLocaleString()} retained.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {history.map((h) => {
            const isWithdrawn = h.status === "withdrawn";
            const isReverted = h.status === "reverted";
            const isOrphaned = h.status === "orphaned_by_restore";
            const dateStr = h.approved_at ?? h.withdrawn_at ?? "";
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => setOpenId(openId === h.id ? null : h.id)}
                className={
                  "group relative flex flex-col overflow-hidden rounded-md border bg-muted/20 text-left transition-colors hover:border-primary " +
                  (openId === h.id ? "ring-2 ring-primary" : "")
                }
              >
                <div className="aspect-video w-full bg-black/40 flex items-center justify-center overflow-hidden">
                  {h.preview_signed_url ? (
                    <img
                      src={h.preview_signed_url}
                      alt={`Preview of contribution ${h.id}`}
                      loading="lazy"
                      className={
                        "h-full w-full object-cover transition-opacity group-hover:opacity-90 " +
                        (isWithdrawn || isReverted || isOrphaned ? "opacity-60 grayscale" : "")
                      }
                    />
                  ) : (
                    <ImageOff className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-0.5 px-2 py-1.5 text-xs">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="truncate font-medium">
                      {isWithdrawn ? "[Withdrawn]" : h.contributor}
                    </span>
                    {isWithdrawn ? (
                      <Badge variant="outline" className="text-[10px] py-0">
                        withdrawn
                      </Badge>
                    ) : isReverted ? (
                      <Badge variant="outline" className="text-[10px] py-0">
                        reverted
                      </Badge>
                    ) : isOrphaned ? (
                      <Badge variant="outline" className="text-[10px] py-0">
                        orphaned
                      </Badge>
                    ) : h.revert_status === "queued" || h.revert_status === "running" ? (
                      <Badge variant="outline" className="text-[10px] py-0">
                        {h.revert_status === "running" ? "reverting…" : "queued"}
                      </Badge>
                    ) : h.revert_status === "failed" ? (
                      <Badge variant="destructive" className="text-[10px] py-0">
                        revert failed
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground">
                    {!isWithdrawn && typeof h.tiles_new === "number"
                      ? `+${h.tiles_new.toLocaleString()} new chunks`
                      : `${h.tile_count.toLocaleString()} chunks`}
                  </div>
                  <div className="text-muted-foreground">
                    {dateStr ? new Date(dateStr).toLocaleDateString() : "—"}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Click-to-enlarge inline view */}
        {opened && opened.preview_signed_url && (
          <div className="rounded-md border overflow-hidden bg-black/5">
            <MapViewer
              imageUrl={opened.preview_signed_url}
              alt={`Preview of contribution ${opened.id}`}
              height="60vh"
              bordered={false}
              legend={<span className="text-muted-foreground">{getMapViewerLegend(opened)}</span>}
            />
            {isAdmin && (
              <div className="flex flex-col gap-2 border-t bg-muted/20 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                <div className="text-muted-foreground">
                  {opened.status === "approved" ? (
                    opened.revert_status === "queued" ? (
                      <>Queued for revert — worker will pick this up shortly.</>
                    ) : opened.revert_status === "running" ? (
                      <>
                        <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                        Reverting now — this can take a few minutes for large maps.
                      </>
                    ) : opened.revert_status === "failed" ? (
                      <span className="text-destructive">
                        Revert failed
                        {opened.revert_attempts
                          ? ` (after ${opened.revert_attempts} attempts)`
                          : ""}
                        {opened.revert_error ? `: ${opened.revert_error}` : ""}. Click Revert to
                        retry.
                      </span>
                    ) : opened.can_revert ? (
                      <>
                        Revert window: {revertWindowDays}d ·{" "}
                        {(opened.revert_added_count ?? opened.tiles_new ?? 0).toLocaleString()} tile
                        {(opened.revert_added_count ?? opened.tiles_new ?? 0) === 1 ? "" : "s"}{" "}
                        captured
                        {opened.revert_replaced_count
                          ? ` · ${opened.revert_replaced_count.toLocaleString()} overwrites`
                          : ""}
                      </>
                    ) : opened.revert_supported === false ? (
                      <>
                        Revert unavailable — undo data was not captured (file too large or feature
                        flag was off).
                      </>
                    ) : (
                      <>
                        Outside the {revertWindowDays}-day revert window — restore from a backup
                        instead.
                      </>
                    )
                  ) : (
                    <>Status: {opened.status}</>
                  )}
                </div>
                {opened.can_revert && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={revertingId === opened.id}
                    onClick={() => requestRevert(opened)}
                  >
                    {revertingId === opened.id ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Undo2 className="mr-1 h-3 w-3" />
                    )}
                    {opened.revert_status === "failed"
                      ? "Retry revert"
                      : "Revert this contribution"}
                  </Button>
                )}
              </div>
            )}
            {isAdmin && revertError && (
              <div className="border-t bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {revertError}
              </div>
            )}
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={pendingRevert !== null}
        title="Revert this contribution?"
        description={
          pendingRevert ? (
            <>
              {pendingTilesReplaced > 0 ? (
                <>
                  This will restore <strong>{pendingTilesReplaced.toLocaleString()}</strong> chunk
                  {pendingTilesReplaced === 1 ? "" : "s"} to their pre-contribution state and remove{" "}
                  <strong>{pendingTilesNew.toLocaleString()}</strong> chunk
                  {pendingTilesNew === 1 ? "" : "s"} added in the region.
                </>
              ) : (
                <>
                  This will delete <strong>{pendingTilesNew.toLocaleString()}</strong> chunk
                  {pendingTilesNew === 1 ? "" : "s"} added by this contribution. The area returns to{" "}
                  <em>unmapped</em> — not to a previous version.
                </>
              )}
              <br />
              <span className="text-muted-foreground">
                Contribution ID: <span className="font-mono">{pendingRevert.id}</span>
              </span>
              {revertError && (
                <>
                  <br />
                  <span className="text-destructive">{revertError}</span>
                </>
              )}
            </>
          ) : null
        }
        confirmLabel="Revert"
        variant="destructive"
        loading={revertingId !== null}
        onConfirm={confirmRevert}
        onCancel={() => {
          setPendingRevert(null);
          setRevertError(null);
        }}
      />
    </Card>
  );
}
