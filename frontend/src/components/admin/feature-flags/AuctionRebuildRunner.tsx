import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { adminAuctionRebuild } from "@/lib/api";
import { useMutation } from "@tanstack/react-query";
import { Gavel, Loader2 } from "lucide-react";

// Manual trigger for the auction-house processing flow. Hits the admin-only
// POST /admin/auction-rebuild endpoint, which re-merges every contributor's
// raw submissions and republishes the public artifacts. The request blocks
// until the single-flight rebuild finishes, so we just show a spinner and the
// resulting record counts. Safe to call repeatedly.
export function AuctionRebuildRunner() {
  const rebuild = useMutation({
    mutationFn: adminAuctionRebuild,
  });

  const result = rebuild.data?.rebuild;

  return (
    <div className="rounded border p-2 space-y-2 bg-muted/40">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs">
          <p className="font-medium flex items-center gap-1.5">
            <Gavel className="h-3.5 w-3.5" /> Rebuild auction house now
          </p>
          <p className="text-muted-foreground">
            Re-merge every contributor&rsquo;s raw submissions and republish the public auction
            artifacts. Runs single-flight on the server and is safe to call repeatedly.
          </p>
        </div>
        <Button size="sm" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
          {rebuild.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {rebuild.isPending ? "Rebuilding…" : "Rebuild now"}
        </Button>
      </div>

      {rebuild.error && (
        <p className="text-xs text-destructive">{(rebuild.error as Error).message}</p>
      )}

      {result && (
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="text-[10px]">
            {result.auctions} auction(s)
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {result.listings} listing(s)
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {result.items} item(s)
          </Badge>
        </div>
      )}
    </div>
  );
}
