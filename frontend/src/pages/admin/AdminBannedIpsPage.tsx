import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { adminListIpBans, adminUnbanIp, type IpBan } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function AdminBannedIpsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-ip-bans"],
    queryFn: () => adminListIpBans(null),
  });

  const unbanMut = useMutation({
    mutationFn: (hash: string) => adminUnbanIp(hash),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-ip-bans"] }),
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Banned IPs</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Active IP bans. Hashes are HMAC-SHA256 of the original IP.
        </p>
      </div>

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {data && data.bans.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">No active bans.</p>
      )}

      <div className="space-y-2">
        {data?.bans.map((b: IpBan) => (
          <Card key={b.ip_hash}>
            <CardContent className="py-3 flex items-start justify-between gap-2">
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="destructive">{b.reason_code}</Badge>
                  <span className="text-xs text-muted-foreground">
                    Until {new Date(b.expires_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="text-sm">{b.reason}</div>
                {b.admin_notes && (
                  <div className="text-xs text-muted-foreground italic">{b.admin_notes}</div>
                )}
                <div className="text-[10px] font-mono text-muted-foreground break-all">{b.ip_hash}</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (confirm("Lift this ban?")) unbanMut.mutate(b.ip_hash);
                }}
              >
                Unban
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
