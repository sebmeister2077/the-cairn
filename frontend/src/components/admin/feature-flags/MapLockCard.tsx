import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { adminGetMapLock, adminForceReleaseMapLock } from "@/lib/api";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Unlock, RefreshCw, Lock } from "lucide-react";
import { useState } from "react";

export function MapLockCard() {
  const queryClient = useQueryClient();
  const [confirmRelease, setConfirmRelease] = useState(false);

  const lock = useQuery({
    queryKey: ["admin-map-lock"],
    queryFn: adminGetMapLock,
    refetchInterval: 10_000,
  });

  const releaseLock = useMutation({
    mutationFn: adminForceReleaseMapLock,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-map-lock"] }),
  });

  const lockInfo = lock.data?.lock ?? null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {lockInfo ? (
            <Lock className="h-4 w-4 text-amber-600" />
          ) : (
            <Unlock className="h-4 w-4 text-emerald-600" />
          )}
          Map lock
          <HelpTip
            text={
              "Global mutex around the combined map .db. Held briefly during " +
              "approve, revert, and backup-restore so two writers can\u2019t merge into " +
              "stale bytes. Force-release only if you\u2019re sure no worker is mid-write \u2014 " +
              "doing so during a real merge can corrupt the map."
            }
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-2 flex-wrap text-sm">
          <div>
            {lockInfo ? (
              <span>
                Held by <strong>{lockInfo.holder_action}</strong>, expires{" "}
                {new Date(lockInfo.expires_at).toLocaleTimeString()}
              </span>
            ) : (
              <span className="text-muted-foreground">Free — no merge in progress.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => lock.refetch()}
              aria-label="Refresh lock status"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
            {lockInfo && (
              <Button
                size="sm"
                variant="outline"
                disabled={releaseLock.isPending}
                onClick={() => setConfirmRelease(true)}
              >
                Force release
              </Button>
            )}
          </div>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmRelease}
        title="Force-release the map lock?"
        description="Only do this if you\u2019re sure no approve/revert/restore is in progress. Releasing while a worker is still merging can corrupt the combined map."
        confirmLabel="Release lock"
        variant="destructive"
        onCancel={() => setConfirmRelease(false)}
        onConfirm={() => {
          setConfirmRelease(false);
          releaseLock.mutate();
        }}
      />
    </Card>
  );
}
