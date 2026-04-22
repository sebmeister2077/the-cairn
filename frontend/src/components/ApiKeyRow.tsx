import { useState } from "react";
import { Trash2 } from "lucide-react";
import { type ApiKeyRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/components/DateFormatter";

export function KeyRow({
  record,
  onRevoke,
}: {
  record: ApiKeyRecord;
  onRevoke: (key: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

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
      <Badge variant="outline" className="text-blue-600 border-blue-300">
        Contribute
      </Badge>
    ) : (
      <Badge variant="outline">Read</Badge>
    );

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 items-center py-3 border-b last:border-b-0 text-sm">
      <div className="min-w-0">
        <p className="font-medium truncate">{record.name || <span className="text-muted-foreground italic">Unnamed</span>}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Created {fmt(record.created_at)}
          {record.last_used_at && <> · Last used {fmt(record.last_used_at)}</>}
          {record.consume_once && record.bound_identity && (
            <> · Bound to {record.bound_identity}</>
          )}
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
      {!record.revoked ? (
        confirming ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => { onRevoke(record.key); setConfirming(false); }}
            >
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-4" />
            Revoke
          </Button>
        )
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}
