import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { adminDeleteLandmark, adminListLandmarkAudit, type LandmarkAuditEntry } from "@/lib/api";
import { formatTimestamp } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

const COLLAPSED_COUNT = 2;

export function LandmarkAuditFeedCard() {
  const queryClient = useQueryClient();
  const [selectedForDeleteId, setSelectedForDeleteId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-landmark-audit"],
    queryFn: () => adminListLandmarkAudit({ limit: 100 }),
  });

  const deleteMut = useMutation({
    mutationFn: (landmarkId: string) => adminDeleteLandmark(landmarkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-landmark-audit"] });
      queryClient.invalidateQueries({ queryKey: ["admin-landmark-edit-requests"] });
    },
  });

  const allRows = data?.audit ?? [];
  const visibleRows = expanded ? allRows : allRows.slice(0, COLLAPSED_COUNT);
  const hiddenCount = allRows.length - visibleRows.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent audit (latest 100)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && allRows.length === 0 && (
          <p className="text-sm text-muted-foreground">No audit entries yet.</p>
        )}
        {deleteMut.error && (
          <p className="text-xs text-destructive">{(deleteMut.error as Error).message}</p>
        )}
        {visibleRows.length > 0 && (
          <div className="divide-y border rounded-md">
            {visibleRows.map((row) => (
              <AuditRow
                key={row.id}
                row={row}
                onDelete={() => {
                  setSelectedForDeleteId(row.landmark_id);
                }}
                deleting={deleteMut.isPending && deleteMut.variables === row.landmark_id}
              />
            ))}
          </div>
        )}
        {allRows.length > COLLAPSED_COUNT && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <>
                <ChevronUp className="size-4" /> Show less
              </>
            ) : (
              <>
                <ChevronDown className="size-4" /> Show {hiddenCount} more
              </>
            )}
          </Button>
        )}
        <ConfirmDialog
          title="Confirm hard-delete"
          description={`Hard-delete landmark ${selectedForDeleteId}?`}
          open={selectedForDeleteId !== null}
          onCancel={() => setSelectedForDeleteId(null)}
          onConfirm={() => {
            if (selectedForDeleteId) {
              deleteMut.mutate(selectedForDeleteId);
              setSelectedForDeleteId(null);
            }
          }}
          confirmLabel="Delete"
          variant="destructive"
        />
      </CardContent>
    </Card>
  );
}

function AuditRow({
  row,
  onDelete,
  deleting,
}: {
  row: LandmarkAuditEntry;
  onDelete: () => void;
  deleting: boolean;
}) {
  const showDelete = row.action !== "admin_delete" && !row.landmark_id.startsWith("<");
  return (
    <div className="px-3 py-2 text-xs flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="font-mono">
            {row.action}
          </Badge>
          {row.action === "add" && (
            <span>{(row.after_payload as any)?.properties?.label ?? "__missing name"}</span>
          )}
          <span className="text-muted-foreground">{formatTimestamp(row.created_at)}</span>
          {row.actor_display_name && (
            <span>
              by <span className="font-medium">{row.actor_display_name}</span>
            </span>
          )}
        </div>
        <div className="font-mono text-muted-foreground break-all">{row.landmark_id}</div>
      </div>
      {showDelete && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={deleting}
          title="Hard-delete this landmark"
        >
          {deleting ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
        </Button>
      )}
    </div>
  );
}
