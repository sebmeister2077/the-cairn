import { useState } from "react";
import { Check, Copy, Trash2, ShieldCheck, Crown } from "lucide-react";
import { type ApiKeyRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/dateFormat";
import { useCopy } from "@/hooks/useCopy";
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
  onEditPermissions,
  onToggleAdmin,
}: {
  record: ApiKeyRecord;
  onRevoke: (key: string) => void;
  /** When provided (admin view), renders a Permissions button opening the granular-permission
   *  editor for this key. */
  onEditPermissions?: (key: string) => void;
  /** When provided (privileged admin view), renders a promote/demote-admin control.
   *  The backend requires the acting admin to have a verified passkey session.
   *  Returns a promise so the dialog can show pending/error state and stay open
   *  on failure (e.g. 403 passkey_enrollment_required / "only remaining admin"). */
  onToggleAdmin?: (key: string, isAdmin: boolean) => Promise<unknown>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [adminConfirmOpen, setAdminConfirmOpen] = useState(false);
  const [adminPending, setAdminPending] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
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
        {record.is_admin && (
          <Badge
            variant="outline"
            className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-300 dark:border-amber-400/40 dark:bg-amber-400/10"
          >
            <Crown className="size-3" /> Admin
          </Badge>
        )}
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
        {!record.revoked && onEditPermissions && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEditPermissions(record.key)}
            title="Edit granular permissions"
          >
            <ShieldCheck className="size-4" />
            Permissions
          </Button>
        )}
        {!record.revoked && onToggleAdmin && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAdminConfirmOpen(true)}
            title={record.is_admin ? "Remove admin access" : "Grant admin access"}
          >
            <Crown className="size-4" />
            {record.is_admin ? "Remove admin" : "Make admin"}
          </Button>
        )}
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
      <Dialog
        open={adminConfirmOpen}
        onOpenChange={(open) => {
          setAdminConfirmOpen(open);
          if (!open) setAdminError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {record.is_admin ? "Remove admin access?" : "Grant admin access?"}
            </DialogTitle>
            <DialogDescription>
              {record.is_admin ? (
                <>
                  This will revoke admin access from{" "}
                  <strong className="text-foreground">{record.name || "this unnamed key"}</strong>.
                  They will lose access to the admin panel.
                </>
              ) : (
                <>
                  This will grant full admin access to{" "}
                  <strong className="text-foreground">{record.name || "this unnamed key"}</strong>.
                  They will be able to manage keys, contributions and settings. Under strict mode
                  they must enrol their own passkey before making changes.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {adminError && <p className="text-sm text-destructive">{adminError}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAdminConfirmOpen(false)}
              disabled={adminPending}
            >
              Cancel
            </Button>
            <Button
              disabled={adminPending}
              onClick={async () => {
                if (!onToggleAdmin) return;
                setAdminError(null);
                setAdminPending(true);
                try {
                  await onToggleAdmin(record.key, !record.is_admin);
                  setAdminConfirmOpen(false);
                } catch (err) {
                  setAdminError(err instanceof Error ? err.message : "Request failed");
                } finally {
                  setAdminPending(false);
                }
              }}
            >
              <Crown className="size-4" />
              {adminPending
                ? "Working…"
                : record.is_admin
                  ? "Remove admin"
                  : "Make admin"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
