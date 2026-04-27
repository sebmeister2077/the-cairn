import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Search } from "lucide-react";
import {
  adminListUsers,
  adminGetUserStats,
  adminGetSiblings,
  adminBanPreview,
  adminBanUser,
  adminRekeyUser,
  adminReactivateUser,
  adminSoftDeleteUser,
  adminRegenerateName,
  adminListFlags,
  adminResolveFlag,
  adminGetKeyPermissions,
  adminSetKeyPermission,
  type AdminUserListItem,
  type AdminUserStats,
  type BanReasonCode,
  type UserFlag,
  type KeyPermission,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HelpTip } from "@/components/ui/help-tip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

const REASONS: { value: BanReasonCode; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "impersonation", label: "Impersonation" },
  { value: "abuse", label: "Abuse" },
  { value: "harassment", label: "Harassment" },
  { value: "duplicate_account", label: "Duplicate account" },
  { value: "provocative_name", label: "Provocative name" },
  { value: "other", label: "Other" },
];

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("joined_at");
  const [filterFlagged, setFilterFlagged] = useState(false);
  const [filterBanned, setFilterBanned] = useState(false);
  const [filterGenesis, setFilterGenesis] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(true);

  const [banTarget, setBanTarget] = useState<AdminUserListItem | null>(null);
  const [siblingTarget, setSiblingTarget] = useState<AdminUserListItem | null>(null);
  const [flagsTarget, setFlagsTarget] = useState<AdminUserListItem | null>(null);
  const [permsTarget, setPermsTarget] = useState<AdminUserListItem | null>(null);
  const [rekeyResult, setRekeyResult] = useState<{ user: string; key: string } | null>(null);
  const [rekeyConfirm, setRekeyConfirm] = useState<AdminUserListItem | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AdminUserListItem | null>(null);

  const stats = useQuery<{ stats: AdminUserStats; cached: boolean }>({
    queryKey: ["admin-user-stats"],
    queryFn: () => adminGetUserStats(false),
  });

  const refreshStats = useMutation({
    mutationFn: () => adminGetUserStats(true),
    onSuccess: (data) => queryClient.setQueryData(["admin-user-stats"], data),
  });

  const users = useQuery({
    queryKey: ["admin-users", q, sort, filterFlagged, filterBanned, filterGenesis, includeDeleted],
    queryFn: () =>
      adminListUsers({
        q,
        sort,
        flagged: filterFlagged,
        banned: filterBanned,
        genesis: filterGenesis,
        include_deleted: includeDeleted,
        limit: 50,
      }),
  });

  const regenMut = useMutation({
    mutationFn: (key: string) => adminRegenerateName(key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  const reactMut = useMutation({
    mutationFn: (key: string) => adminReactivateUser(key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (key: string) => adminSoftDeleteUser(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-user-stats"] });
    },
  });
  const rekeyMut = useMutation({
    mutationFn: (key: string) => adminRekeyUser(key),
    onSuccess: (data, oldKey) => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setRekeyResult({ user: oldKey, key: data.new_api_key });
    },
  });

  const s = stats.data?.stats;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Users</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            View, edit and moderate accounts.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refreshStats.mutate()}>
          <RefreshCw className={refreshStats.isPending ? "size-3 animate-spin" : "size-3"} />
          Refresh stats
        </Button>
      </div>

      {s && (
        <Card>
          <CardContent className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 py-3 text-sm">
            <Stat label="Total" value={s.total} />
            <Stat label="Active" value={s.active} />
            <Stat label="Active 7d" value={s.active_last_7_days} />
            <Stat label="Hireable" value={s.hireable} />
            <Stat label="Flagged" value={s.flagged} className="text-amber-600" />
            <Stat label="Banned IPs" value={s.banned} className="text-destructive" />
            <Stat label="Deleted" value={s.deleted} className="text-muted-foreground" />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-50">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search display name or in-game name…"
                className="pl-7"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-sm"
            >
              <option value="joined_at">Newest first</option>
              <option value="last_login_at">Recently active</option>
              <option value="is_hireable">Hireable first</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            <FilterToggle label="Flagged" value={filterFlagged} onChange={setFilterFlagged} />
            <FilterToggle label="Banned" value={filterBanned} onChange={setFilterBanned} />
            <span className="inline-flex items-center">
              <FilterToggle label="Genesis only" value={filterGenesis} onChange={setFilterGenesis} />
              <HelpTip text="Genesis = the first (earliest) account ever created from a given IP address. Subsequent accounts on the same IP are flagged 'shared_ip' and are NOT genesis. Useful for spotting alts." />
            </span>
            <FilterToggle label="Include deleted" value={includeDeleted} onChange={setIncludeDeleted} />
          </div>
        </CardContent>
      </Card>

      {users.isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {users.error && (
        <p className="text-sm text-destructive">{(users.error as Error).message}</p>
      )}

      {users.data?.users && users.data.users.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">No users match.</p>
      )}

      <div className="space-y-2">
        {users.data?.users.map((u) => (
          <Card key={u.api_key}>
            <CardContent className="py-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm">{u.display_name}</span>
                    {u.genesis_for_ip && <Badge variant="secondary">Genesis</Badge>}
                    {u.is_hireable && <Badge>Hireable</Badge>}
                    {u.flag_count > 0 && (
                      <Badge
                        variant="destructive"
                        className="cursor-pointer"
                        onClick={() => setFlagsTarget(u)}
                        title="View flags"
                      >
                        {u.flag_count} flag{u.flag_count > 1 ? "s" : ""}
                      </Badge>
                    )}
                    {u.is_banned && <Badge variant="destructive">IP banned</Badge>}
                    {u.deleted_at && <Badge variant="outline">Deleted</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {u.in_game_name && <>In-game: <span className="font-mono">{u.in_game_name}</span> · </>}
                    Joined {new Date(u.joined_at).toLocaleDateString()}
                    {u.last_used_at && <> · Last seen {new Date(u.last_used_at).toLocaleDateString()}</>}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono break-all">
                    {u.api_key.slice(0, 8)}…{u.api_key.slice(-4)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" onClick={() => setSiblingTarget(u)}>Siblings</Button>
                  {u.flag_count > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setFlagsTarget(u)}>
                      Flags ({u.flag_count})
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => regenMut.mutate(u.api_key)}>Regen name</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPermsTarget(u)}
                  >
                    Permissions
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRekeyConfirm(u)}
                  >
                    Re-key
                  </Button>
                  {u.deleted_at ? (
                    <Button size="sm" variant="outline" onClick={() => reactMut.mutate(u.api_key)}>
                      Reactivate
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeleteConfirm(u)}
                    >
                      Delete
                    </Button>
                  )}
                  <Button size="sm" variant="destructive" onClick={() => setBanTarget(u)}>
                    Ban IP
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <BanDialog target={banTarget} onClose={() => setBanTarget(null)} onDone={() => {
        queryClient.invalidateQueries({ queryKey: ["admin-users"] });
        queryClient.invalidateQueries({ queryKey: ["admin-user-stats"] });
      }} />

      <SiblingsDialog target={siblingTarget} onClose={() => setSiblingTarget(null)} />

      <FlagsDialog
        target={flagsTarget}
        onClose={() => setFlagsTarget(null)}
        onResolved={() => {
          queryClient.invalidateQueries({ queryKey: ["admin-users"] });
          queryClient.invalidateQueries({ queryKey: ["admin-user-stats"] });
        }}
      />

      <PermissionsDialog
        target={permsTarget}
        onClose={() => setPermsTarget(null)}
      />

      <RekeyResultDialog
        result={rekeyResult}
        onClose={() => setRekeyResult(null)}
      />

      <ConfirmDialog
        open={!!rekeyConfirm}
        title="Re-key this account?"
        description={
          rekeyConfirm ? (
            <>
              A brand-new API key will be issued for{" "}
              <span className="font-mono">{rekeyConfirm.display_name}</span> and the
              current key will be <strong>revoked immediately</strong>. The user will be
              signed out until they enter the new key. Make sure you can deliver the new
              key securely before continuing.
            </>
          ) : null
        }
        confirmLabel="Re-key"
        loading={rekeyMut.isPending}
        onCancel={() => setRekeyConfirm(null)}
        onConfirm={() => {
          if (rekeyConfirm) {
            rekeyMut.mutate(rekeyConfirm.api_key, {
              onSettled: () => setRekeyConfirm(null),
            });
          }
        }}
      />

      <ConfirmDialog
        open={!!deleteConfirm}
        title="Soft-delete this account?"
        description={
          deleteConfirm ? (
            <>
              <span className="font-mono">{deleteConfirm.display_name}</span> will be
              marked deleted, their personal fields cleared and their API key revoked. They
              can still be reactivated later from this page.
            </>
          ) : null
        }
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteMut.isPending}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          if (deleteConfirm) {
            deleteMut.mutate(deleteConfirm.api_key, {
              onSettled: () => setDeleteConfirm(null),
            });
          }
        }}
      />
    </div>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: number; className?: string }) {
  return (
    <div className={className}>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function FilterToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function BanDialog({
  target,
  onClose,
  onDone,
}: {
  target: AdminUserListItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reasonCode, setReasonCode] = useState<BanReasonCode>("spam");
  const [reason, setReason] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [days, setDays] = useState(365);

  const preview = useQuery({
    queryKey: ["ban-preview", target?.api_key],
    queryFn: () => adminBanPreview(target!.api_key),
    enabled: !!target,
  });

  const banMut = useMutation({
    mutationFn: () =>
      adminBanUser(target!.api_key, {
        reason_code: reasonCode,
        reason,
        admin_notes: adminNotes || undefined,
        duration_days: days,
      }),
    onSuccess: () => {
      onDone();
      onClose();
      setReason("");
      setAdminNotes("");
    },
  });

  if (!target) return null;
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ban IP for {target.display_name}</DialogTitle>
          <DialogDescription>
            This bans the user's hashed IP. All accounts on that IP will be soft-deleted
            and their API keys revoked.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Label>Reason</Label>
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as BanReasonCode)}
              className="w-full rounded border bg-background px-2 py-1 mt-1"
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Reason details (visible internally)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. ban evasion" />
          </div>
          <div>
            <Label>Admin notes (optional)</Label>
            <Input value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} />
          </div>
          <div>
            <Label>Duration (days)</Label>
            <Input type="number" value={days} onChange={(e) => setDays(parseInt(e.target.value || "0", 10))} />
          </div>
          <Separator />
          <div>
            <Label>Blast radius</Label>
            {preview.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
            {preview.data && (
              <p className="text-xs text-muted-foreground">
                {preview.data.affected_users.length} account(s) on this IP will be revoked &amp; soft-deleted:
                <span className="block mt-1 font-mono">
                  {preview.data.affected_users.map((u) => u.display_name).join(", ")}
                </span>
              </p>
            )}
          </div>
          {banMut.error && (
            <p className="text-sm text-destructive">{(banMut.error as Error).message}</p>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="destructive" disabled={!reason.trim() || banMut.isPending} onClick={() => banMut.mutate()}>
              {banMut.isPending ? "Banning…" : "Ban IP"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SiblingsDialog({ target, onClose }: { target: AdminUserListItem | null; onClose: () => void }) {
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
            <div key={s.api_key} className="text-sm border rounded p-2 flex items-center justify-between">
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

function RekeyResultDialog({
  result,
  onClose,
}: {
  result: { user: string; key: string } | null;
  onClose: () => void;
}) {
  if (!result) return null;
  return (
    <Dialog open={!!result} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New API key generated</DialogTitle>
          <DialogDescription>
            Deliver this key to the user securely. It will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input readOnly value={result.key} className="font-mono text-xs" />
          <Button onClick={() => navigator.clipboard.writeText(result.key)}>Copy</Button>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FlagsDialog({
  target,
  onClose,
  onResolved,
}: {
  target: AdminUserListItem | null;
  onClose: () => void;
  onResolved: () => void;
}) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["admin-flags", target?.api_key],
    queryFn: () =>
      adminListFlags({
        flagged_user: target!.api_key,
        unresolved_only: false,
        cursor: null,
      }),
    enabled: !!target,
  });

  const resolveMut = useMutation({
    mutationFn: ({ id, resolution }: { id: number; resolution: "valid" | "abuse" | "dismissed" }) =>
      adminResolveFlag(id, resolution),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-flags", target?.api_key] });
      onResolved();
    },
  });

  if (!target) return null;
  const flags: UserFlag[] = q.data?.flags ?? [];
  const unresolved = flags.filter((f) => !f.resolved_at);
  const resolved = flags.filter((f) => f.resolved_at);

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center">
            Flags on {target.display_name}
            <HelpTip
              text={
                "Valid: confirm the flag — user did something wrong. Closes the flag and keeps it on record as a strike against the account. " +
                "False positive: the flag was raised in error or in bad faith — the user did nothing wrong. Closes the flag with no strike. " +
                "Dismiss: the flag is technically valid but the admin chooses not to act on it. Closes the flag without a strike."
              }
            />
          </DialogTitle>
          <DialogDescription>
            All moderation flags ever raised against this account.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-3 pr-1">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.data && flags.length === 0 && (
          <p className="text-sm text-muted-foreground">No flags.</p>
        )}
        {unresolved.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-muted-foreground">
              Unresolved ({unresolved.length})
            </div>
            {unresolved.map((f) => (
              <FlagRow key={f.id} flag={f} onResolve={(resolution) =>
                resolveMut.mutate({ id: f.id, resolution })
              } pending={resolveMut.isPending} />
            ))}
          </div>
        )}
        {resolved.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-muted-foreground pt-2">
              Resolved ({resolved.length})
            </div>
            {resolved.map((f) => (
              <FlagRow key={f.id} flag={f} />
            ))}
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FlagRow({
  flag,
  onResolve,
  pending,
}: {
  flag: UserFlag;
  onResolve?: (resolution: "valid" | "abuse" | "dismissed") => void;
  pending?: boolean;
}) {
  return (
    <div className="border rounded p-2 text-sm space-y-1 min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2 flex-wrap min-w-0">
        <Badge variant={flag.resolved_at ? "outline" : "destructive"} className="break-all">
          {flag.reason}
        </Badge>
        <span className="text-xs text-muted-foreground break-all">
          {new Date(flag.created_at).toLocaleString()}
        </span>
      </div>
      {flag.related_display_name && (
        <div className="text-xs text-muted-foreground break-all">
          Related to: <span className="font-mono">{flag.related_display_name}</span>
        </div>
      )}
      {flag.metadata && Object.keys(flag.metadata).length > 0 && (
        <pre className="text-[10px] bg-muted/50 rounded p-1 max-w-full overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(flag.metadata, null, 2)}
        </pre>
      )}
      {flag.resolved_at ? (
        <div className="text-xs text-muted-foreground">
          Resolved {new Date(flag.resolved_at).toLocaleString()}
          {flag.resolution && <> as <strong>{flag.resolution}</strong></>}
        </div>
      ) : (
        onResolve && (
          <div className="flex gap-1 pt-1">
            <Button size="sm" variant="outline" disabled={pending}
              onClick={() => onResolve("valid")}>Valid</Button>
            <Button size="sm" variant="outline" disabled={pending}
              onClick={() => onResolve("abuse")}>False positive</Button>
            <Button size="sm" variant="outline" disabled={pending}
              onClick={() => onResolve("dismissed")}>Dismiss</Button>
          </div>
        )
      )}
    </div>
  );
}

const KEY_PERMISSIONS: { key: KeyPermission; label: string; help: string }[] = [
  {
    key: "region_overwrite",
    label: "Region overwrite",
    help: "Allow this contributor to submit region-restricted updates that overwrite existing tiles.",
  },
];

function PermissionsDialog({
  target,
  onClose,
}: {
  target: AdminUserListItem | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const apiKey = target?.api_key;

  const q = useQuery({
    queryKey: ["admin-key-perms", apiKey],
    queryFn: () => adminGetKeyPermissions(apiKey!),
    enabled: !!apiKey,
  });

  const setMut = useMutation({
    mutationFn: ({ permission, enabled }: { permission: KeyPermission; enabled: boolean }) =>
      adminSetKeyPermission(apiKey!, permission, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-key-perms", apiKey] }),
  });

  if (!target) return null;
  const perms = q.data?.extra_permissions ?? {};

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Permissions for {target.display_name}</DialogTitle>
          <DialogDescription>
            Granular permissions on this API key. These supplement (not replace) the
            coarse "read" / "contribute" tier.
          </DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading�</p>
        ) : (
          <div className="space-y-2">
            {KEY_PERMISSIONS.map((p) => {
              const enabled = Boolean(perms[p.key]);
              return (
                <div
                  key={p.key}
                  className="flex items-start justify-between gap-3 border rounded p-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{p.label}</div>
                    <p className="text-xs text-muted-foreground">{p.help}</p>
                  </div>
                  <Switch
                    checked={enabled}
                    disabled={setMut.isPending}
                    onCheckedChange={(v) =>
                      setMut.mutate({ permission: p.key, enabled: Boolean(v) })
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
