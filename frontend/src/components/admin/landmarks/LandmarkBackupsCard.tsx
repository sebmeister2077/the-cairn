import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  adminListGeojsonBackups,
  adminCreateGeojsonBackup,
  adminRestoreGeojsonBackup,
  type GeojsonBackupEntry,
} from "@/lib/api";
import { formatBytes, formatTimestamp } from "@/lib/utils";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import { useState, useMemo } from "react";

export function LandmarkBackupsCard() {
  const queryClient = useQueryClient();
  const [selectedForRestoreId, setSelectedForRestoreId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-landmark-backups"],
    queryFn: adminListGeojsonBackups,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-landmark-backups"] });
  };

  const createMut = useMutation({
    mutationFn: (asset: "landmarks" | "translocators") => adminCreateGeojsonBackup(asset),
    onSuccess: invalidate,
  });

  const restoreMut = useMutation({
    mutationFn: ({ asset, key }: { asset: "landmarks" | "translocators"; key: string }) =>
      adminRestoreGeojsonBackup(asset, key),
    onSuccess: () => {
      setSelectedForRestoreId(null);
      invalidate();
    },
  });

  const grouped = useMemo(() => {
    const out = {
      landmarks: [] as GeojsonBackupEntry[],
      translocators: [] as GeojsonBackupEntry[],
    };
    for (const b of data?.backups ?? []) out[b.asset].push(b);
    return out;
  }, [data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Geojson backups</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {(["landmarks", "translocators"] as const).map((asset) => (
          <div key={asset} className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold capitalize">{asset}</h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() => createMut.mutate(asset)}
                disabled={createMut.isPending}
              >
                {createMut.isPending && createMut.variables === asset ? (
                  <Loader2 className="size-3 animate-spin mr-1" />
                ) : null}
                Snapshot now
              </Button>
            </div>
            {createMut.error && createMut.variables === asset && (
              <p className="text-xs text-destructive">{(createMut.error as Error).message}</p>
            )}
            {grouped[asset].length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No backups yet.</p>
            ) : (
              <div className="border rounded-md divide-y">
                {grouped[asset].map((b) => (
                  <div
                    key={b.key}
                    className="px-3 py-2 text-xs flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="font-mono break-all">{b.key.replace(/^backups\//, "")}</div>
                      <div className="text-muted-foreground">
                        <Badge variant="outline" className="mr-1">
                          {b.kind}
                        </Badge>
                        {formatBytes(b.size)} · {formatTimestamp(b.last_modified)}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSelectedForRestoreId(b.key);
                      }}
                      disabled={restoreMut.isPending}
                      title="Restore this snapshot over the live file"
                    >
                      {restoreMut.isPending && restoreMut.variables?.key === b.key ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3" />
                      )}
                    </Button>

                    <ConfirmDialog
                      title="Confirm restore"
                      description={`Restore ${asset} from ${b.key}? This overwrites the live file.`}
                      open={selectedForRestoreId === b.key}
                      onCancel={() => setSelectedForRestoreId(null)}
                      onConfirm={() => {
                        restoreMut.mutate({ asset, key: b.key });
                      }}
                      loading={restoreMut.isPending && restoreMut.variables?.key === b.key}
                      confirmLabel="Restore"
                      variant="destructive"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {restoreMut.error && (
          <p className="text-xs text-destructive">{(restoreMut.error as Error).message}</p>
        )}
      </CardContent>
    </Card>
  );
}
