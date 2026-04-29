import { type AdminUserListItem, adminGetSiblings } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export function SiblingsDialog({
  target,
  onClose,
}: {
  target: AdminUserListItem | null;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["siblings", target?.api_key],
    queryFn: () => adminGetSiblings(target!.api_key),
    enabled: !!target,
  });

  if (!target) return null;
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sibling accounts of {target.display_name}</DialogTitle>
          <DialogDescription>
            Accounts whose API key is bound to the same IP hash.
          </DialogDescription>
        </DialogHeader>
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.data && q.data.siblings.length === 0 && (
          <p className="text-sm text-muted-foreground">No siblings.</p>
        )}
        <div className="space-y-2">
          {q.data?.siblings.map((s) => (
            <div
              key={s.api_key}
              className="text-sm border rounded p-2 flex items-center justify-between"
            >
              <div>
                <div className="font-mono">{s.display_name}</div>
                {s.in_game_name && (
                  <div className="text-xs text-muted-foreground">In-game: {s.in_game_name}</div>
                )}
              </div>
              <div className="flex gap-1">
                {s.deleted_at && <Badge variant="outline">Deleted</Badge>}
                {s.genesis_for_ip && <Badge variant="secondary">Genesis</Badge>}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
