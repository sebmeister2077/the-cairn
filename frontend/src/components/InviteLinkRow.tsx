import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Link, Trash2, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { listInviteLinkKeys, type InviteLinkKeyRecord, type InviteLinkRecord } from "@/lib/api";
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
  const [expanded, setExpanded] = useState(false);

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

  const usageText =
    record.max_uses !== null
      ? `${record.use_count} / ${record.max_uses} used`
      : `${record.use_count} used`;

  const expiryText = record.expires_at ? `Expires ${fmt(record.expires_at)}` : "No expiry";

  const issuedKeys = useQuery<InviteLinkKeyRecord[]>({
    queryKey: ["admin-invite-link-keys", record.token],
    queryFn: () => listInviteLinkKeys(record.token),
    enabled: expanded,
  });

  const canExpand = record.use_count > 0;

  return (
    <div className="border-b last:border-b-0">
      <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] gap-x-3 items-center py-3 text-sm">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 shrink-0"
          onClick={() => setExpanded((v) => !v)}
          disabled={!canExpand}
          title={canExpand ? "Show users who claimed this link" : "No claims yet"}
          aria-label="Toggle issued keys"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </Button>
        <div className="min-w-0">
          <p className="font-medium truncate">
            {record.name || <span className="text-muted-foreground italic">Unnamed</span>}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {usageText} · {expiryText} · Created {fmt(record.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">{permBadge}</div>
        <div>{statusBadge}</div>
        {!record.revoked ? (
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
        ) : (
          <span />
        )}
        <div className="w-px h-5 bg-border" />
        {!record.revoked ? (
          confirming ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  onRevoke(record.token);
                  setConfirming(false);
                }}
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
      {expanded && (
        <IssuedKeysPanel
          loading={issuedKeys.isLoading}
          error={issuedKeys.error as Error | null}
          rows={issuedKeys.data ?? []}
        />
      )}
    </div>
  );
}

function IssuedKeysPanel({
  loading,
  error,
  rows,
}: {
  loading: boolean;
  error: Error | null;
  rows: InviteLinkKeyRecord[];
}) {
  return (
    <div className="ml-9 mb-3 mr-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-2">
        <Users className="size-3.5" />
        <span className="font-medium">Issued keys &amp; users</span>
      </div>
      {loading && <p className="text-muted-foreground italic">Loading…</p>}
      {error && <p className="text-destructive">Failed to load: {error.message}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="text-muted-foreground italic">No keys recorded.</p>
      )}
      {!loading && !error && rows.length > 0 && (
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-1.5 items-center">
          <div className="text-muted-foreground font-medium">User / key name</div>
          <div className="text-muted-foreground font-medium">Created</div>
          <div className="text-muted-foreground font-medium">Last used</div>
          <div className="text-muted-foreground font-medium">Status</div>
          {rows.map((r) => (
            <KeyRowEntry key={r.key} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function KeyRowEntry({ row }: { row: InviteLinkKeyRecord }) {
  const status = row.revoked ? (
    <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
      Revoked
    </Badge>
  ) : row.user_deleted_at ? (
    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
      Deleted
    </Badge>
  ) : (
    <Badge
      variant="default"
      className="bg-emerald-500 text-white hover:bg-emerald-500 text-[10px] px-1.5 py-0"
    >
      Active
    </Badge>
  );

  return (
    <>
      <div className="min-w-0">
        {row.display_name ? (
          <span className="font-medium">{row.display_name}</span>
        ) : (
          <span className="italic text-muted-foreground">No account</span>
        )}
        {row.in_game_name && (
          <span className="text-muted-foreground"> · IGN {row.in_game_name}</span>
        )}
        <span className="text-muted-foreground"> · {row.name || "unnamed key"}</span>
      </div>
      <div className="text-muted-foreground whitespace-nowrap">{fmt(row.created_at)}</div>
      <div className="text-muted-foreground whitespace-nowrap">
        {row.last_used_at ? fmt(row.last_used_at) : "—"}
      </div>
      <div>{status}</div>
    </>
  );
}
