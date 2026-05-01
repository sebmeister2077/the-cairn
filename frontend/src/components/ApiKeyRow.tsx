import { useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { type ApiKeyRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/components/DateFormatter";
import { useCopy } from "@/components/useCopy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function KeyRow({
  record,
  onRevoke,
}: {
  record: ApiKeyRecord;
  onRevoke: (key: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { copied, copy } = useCopy();
  const isCopied = copied === record.key;

  const statusBadge = record.revoked ? (
    <Badge variant="destructive">Revoked</Badge>
  ) : record.consume_once && record.bound_identity ? (
    <Badge variant="secondary">Bound</Badge>
  ) : (
    <Badge variant="default" className="bg-emerald-500 text-white hover:bg-emerald-500">
      Active
    </Badge>
  );

  const permBadge =
    record.permissions === "contribute" ? (
      <Badge
        variant="outline"
        className="text-blue-700 border-blue-300 bg-blue-50 dark:text-blue-300 dark:border-blue-400/40 dark:bg-blue-400/10"
      >
        Contribute
      </Badge>
    ) : (
      <Badge variant="outline">Read</Badge>
    );

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 items-center py-3 border-b last:border-b-0 text-sm">
      <div className="min-w-0">
        <p className="font-medium truncate">
          {record.name || <span className="text-muted-foreground italic">Unnamed</span>}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Created {fmt(record.created_at)}
          {record.last_used_at && <> · Last used {fmt(record.last_used_at)}</>}
          {" · "}
          {record.usage_count.toLocaleString()} {record.usage_count === 1 ? "use" : "uses"}
          {record.display_name && <> · {record.display_name}</>}
          {record.in_game_name && <> · IGN {record.in_game_name}</>}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {permBadge}
        {record.consume_once && (
          <Badge variant="outline" className="text-amber-600 border-amber-300">
            Once
          </Badge>
        )}
      </div>
      <div>{statusBadge}</div>
      <div className="w-px h-5 bg-border" />
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => copy(record.key, record.key)}
          title="Copy API key"
        >
          {isCopied ? (
            <>
              <Check className="size-4 text-emerald-600" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-4" />
              Copy
            </>
          )}
        </Button>
        {!record.revoked ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="size-4" />
            Revoke
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key?</DialogTitle>
            <DialogDescription>
              This will immediately revoke{" "}
              <strong className="text-foreground">{record.name || "this unnamed key"}</strong>. Any
              client using it will stop working. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onRevoke(record.key);
                setConfirmOpen(false);
              }}
            >
              <Trash2 className="size-4" />
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
