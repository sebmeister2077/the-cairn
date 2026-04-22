import { useState } from "react";
import { Check, Link, Trash2 } from "lucide-react";
import { type InviteLinkRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCopy } from "@/components/useCopy";
import { fmt } from "@/components/DateFormatter";

export function InviteLinkRow({
  record,
  onRevoke,
}: {
  record: InviteLinkRecord;
  onRevoke: (token: string) => void;
}) {
  const { copied, copy } = useCopy();
  const [confirming, setConfirming] = useState(false);

  const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(record.token)}`;

  const isExpired = record.expires_at ? new Date(record.expires_at) < new Date() : false;
  const isExhausted = record.max_uses !== null && record.use_count >= record.max_uses;

  const statusBadge = record.revoked ? (
    <Badge variant="destructive">Revoked</Badge>
  ) : isExpired ? (
    <Badge variant="secondary">Expired</Badge>
  ) : isExhausted ? (
    <Badge variant="secondary">Exhausted</Badge>
  ) : (
    <Badge variant="default" className="bg-emerald-500 text-white hover:bg-emerald-500">Active</Badge>
  );

  const permBadge =
    record.permissions === "contribute" ? (
      <Badge variant="outline" className="text-blue-600 border-blue-300">Contribute</Badge>
    ) : (
      <Badge variant="outline">Read</Badge>
    );

  const usageText = record.max_uses !== null
    ? `${record.use_count} / ${record.max_uses} used`
    : `${record.use_count} used`;

  const expiryText = record.expires_at
    ? `Expires ${fmt(record.expires_at)}`
    : "No expiry";

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-3 items-center py-3 border-b last:border-b-0 text-sm">
      <div className="min-w-0">
        <p className="font-medium truncate">{record.name || <span className="text-muted-foreground italic">Unnamed</span>}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {usageText} · {expiryText} · Created {fmt(record.created_at)}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {permBadge}
      </div>
      <div>{statusBadge}</div>
      {!record.revoked && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => copy(inviteUrl, record.token)}
          className="shrink-0"
        >
          {copied === record.token ? (
            <Check className="size-4 text-emerald-500" />
          ) : (
            <Link className="size-4" />
          )}
          Copy Link
        </Button>
      )}
      {record.revoked && <span />}
      <div className="w-px h-5 bg-border" />
      {!record.revoked ? (
        confirming ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => { onRevoke(record.token); setConfirming(false); }}
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
