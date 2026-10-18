/**
 * Admin: Merged Auction House audit (route: /audit/auction-house).
 *
 * Read-only moderation visibility over the crowd-sourced Auction House data
 * lifecycle. Every active source (the `VsAuctionExport` mod via
 * `/contribute-auctions` and the VSProxy via `/contribute-auction-events`)
 * uploads snapshots that are N-way merged and republished to the public
 * auction bucket (`listings.json` / `summary.json` / `items.json`).
 *
 * The audit feed records four kinds of events:
 *   - `contribute`       — an accepted upload from a source.
 *   - `rebuild_publish`  — a rebuild merged every source and published.
 *   - `admin_rebuild`    — an admin forced a manual rebuild.
 *   - `admin_revoke`     — an admin revoked / purged a contributor source.
 *
 * The view requires the env-var admin API key.
 */

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { adminListAuctionAudit, type AdminAuctionAuditEntry } from "@/lib/helpers/api";
import { formatTimestamp } from "@/lib/formatting/dateFormat";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

const AUDIT_KEY = ["admin-auction-audit"] as const;
const AUDIT_PAGE_SIZE = 25;

function actionBadgeVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  if (action === "contribute") return "secondary";
  if (action === "rebuild_publish") return "default";
  if (action === "admin_revoke") return "destructive";
  return "outline";
}

export function AdminAuctionPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Auction house</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          The crowd-sourced Auction House data merged from every contributor source and published to
          the public bucket. This feed records accepted contributions, every published rebuild, and
          admin rebuild / source-revoke actions.
        </p>
      </div>
      <AuditCard />
    </div>
  );
}

function AuditCard() {
  const [page, setPage] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: [...AUDIT_KEY, page],
    queryFn: () =>
      adminListAuctionAudit({
        limit: AUDIT_PAGE_SIZE,
        offset: page * AUDIT_PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const rows = data?.audit ?? [];
  const total = data?.total ?? 0;
  const hasNext = (page + 1) * AUDIT_PAGE_SIZE < total;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Recent audit</CardTitle>
        {total > 0 && <span className="text-xs text-muted-foreground">{total} total</span>}
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No audit entries yet.</p>
        )}
        {rows.length > 0 && (
          <div className="divide-y border rounded-md">
            {rows.map((row) => (
              <AuditRow key={row.id} row={row} />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="size-4" /> Prev
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!hasNext}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AuditRow({ row }: { row: AdminAuctionAuditEntry }) {
  return (
    <div className="px-3 py-2 text-xs flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={actionBadgeVariant(row.action)}>{row.action}</Badge>
          {row.actor_display_name && (
            <span className="font-medium truncate">{row.actor_display_name}</span>
          )}
          {row.source_id && (
            <span className="text-muted-foreground truncate font-mono">· {row.source_id}</span>
          )}
          {row.upstream_host && (
            <span className="text-muted-foreground truncate">· {row.upstream_host}</span>
          )}
        </div>
        <div className="text-muted-foreground">
          {row.action === "contribute" && (
            <span>
              {row.accepted ?? "–"} of {row.received ?? "–"} records accepted
            </span>
          )}
          {(row.action === "rebuild_publish" ||
            row.action === "admin_rebuild" ||
            row.action === "admin_revoke") && (
            <span>
              {row.action === "admin_revoke" && row.note ? `${row.note} · ` : ""}
              {row.auctions != null && <>{row.auctions.toLocaleString()} auctions</>}
              {row.listings != null && <> · {row.listings.toLocaleString()} listings</>}
              {row.items != null && <> · {row.items.toLocaleString()} items</>}
            </span>
          )}
          {row.action === "contribute" && row.note && (
            <span className="font-mono break-all"> · {row.note}</span>
          )}
        </div>
      </div>
      <div className="shrink-0 text-muted-foreground whitespace-nowrap">
        {formatTimestamp(row.created_at)}
      </div>
    </div>
  );
}
