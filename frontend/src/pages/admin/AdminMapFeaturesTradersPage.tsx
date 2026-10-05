/**
 * Admin: Merged map-features traders list (route: /audit/map-features-traders).
 *
 * The crowd-sourced `map-features.traders.json` is rebuilt from every
 * `/contribute-map-features` upload and published to the public map-features
 * bucket. This page is read-only moderation visibility:
 *   1. Audit feed — every contribution + every published rebuild.
 *   2. Biweekly backup snapshots — list + manual "Snapshot now".
 *
 * There is no revert: the merged data is authoritative and only grows from
 * contributor uploads. Both views require the env-var admin API key.
 */

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  adminListMapFeaturesTradersAudit,
  type AdminMapFeaturesTradersAuditEntry,
} from "@/lib/api";
import { formatTimestamp } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

const AUDIT_KEY = ["admin-map-features-traders-audit"] as const;
const AUDIT_PAGE_SIZE = 25;

function actionBadgeVariant(
  action: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (action === "contribute") return "secondary";
  if (action === "rebuild_publish") return "default";
  return "outline";
}

export function AdminMapFeaturesTradersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Map-features traders</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          The crowd-sourced traders list (<code>map-features.traders.json</code>) merged from
          every contributor upload. Audit every change here; manage snapshots from the Backups
          tab.
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
      adminListMapFeaturesTradersAudit({
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
        {total > 0 && (
          <span className="text-xs text-muted-foreground">{total} total</span>
        )}
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

function AuditRow({ row }: { row: AdminMapFeaturesTradersAuditEntry }) {
  return (
    <div className="px-3 py-2 text-xs flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <Badge variant={actionBadgeVariant(row.action)}>{row.action}</Badge>
          {row.actor_display_name && (
            <span className="font-medium truncate">{row.actor_display_name}</span>
          )}
          {row.upstream_host && (
            <span className="text-muted-foreground truncate">· {row.upstream_host}</span>
          )}
        </div>
        <div className="text-muted-foreground">
          {row.action === "contribute" && (
            <span>
              traders accepted {row.traders_accepted ?? "–"} / received{" "}
              {row.traders_received ?? "–"}
              {row.total_accepted != null && <> · total accepted {row.total_accepted}</>}
            </span>
          )}
          {row.action === "rebuild_publish" && (
            <span>
              published {row.traders_accepted ?? "–"} traders
              {row.published_version && (
                <> · v<span className="font-mono">{row.published_version.slice(0, 12)}</span></>
              )}
            </span>
          )}
          {row.action !== "contribute" && row.action !== "rebuild_publish" && row.note && (
            <span className="font-mono break-all">{row.note}</span>
          )}
        </div>
      </div>
      <div className="shrink-0 text-muted-foreground whitespace-nowrap">
        {formatTimestamp(row.created_at)}
      </div>
    </div>
  );
}
