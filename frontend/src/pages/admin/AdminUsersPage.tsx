import { BanDialog } from "@/components/admin/BanDialog";
import { FilterToggle } from "@/components/admin/FilterToggle";
import { FlagsDialog } from "@/components/admin/FlagsDialog";
import { PermissionsDialog } from "@/components/admin/PermissionsDialog";
import { RekeyResultDialog } from "@/components/admin/RekeyResultDialog";
import { SiblingsDialog } from "@/components/admin/SiblingsDialog";
import { UserStat } from "@/components/admin/UserStat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import {
  adminGetUserStats,
  adminListUsers,
  adminReactivateUser,
  adminRegenerateName,
  adminRekeyUser,
  adminSoftDeleteUser,
  type AdminUserListItem,
  type AdminUserStats,
} from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { useCallback, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setAdminUsersFilters, type AdminUsersFilters } from "@/store/slices/adminUsersFilters";

// Filters live in the Redux `adminUsersFilters` slice; the slice handles
// load/persist/cross-tab sync. Keep the legacy type alias so existing
// callsites in this file don't shift around.
type StoredFilters = AdminUsersFilters;

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const filters = useAppSelector((s) => s.adminUsersFilters);
  const setFilters = useCallback(
    (next: StoredFilters) => dispatch(setAdminUsersFilters(next)),
    [dispatch],
  );

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
    queryKey: [
      "admin-users",
      filters.q,
      filters.sort,
      filters.filterFlagged,
      filters.filterBanned,
      filters.filterGenesis,
      filters.includeDeleted,
    ],
    queryFn: () =>
      adminListUsers({
        q: filters.q,
        sort: filters.sort,
        flagged: filters.filterFlagged,
        banned: filters.filterBanned,
        genesis: filters.filterGenesis,
        include_deleted: filters.includeDeleted,
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
          <p className="text-sm text-muted-foreground mt-0.5">View, edit and moderate accounts.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refreshStats.mutate()}>
          <RefreshCw className={refreshStats.isPending ? "size-3 animate-spin" : "size-3"} />
          Refresh stats
        </Button>
      </div>

      {s && (
        <Card>
          <CardContent className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 py-3 text-sm">
            <UserStat label="Total" value={s.total} />
            <UserStat label="Active" value={s.active} />
            <UserStat label="Active 7d" value={s.active_last_7_days} />
            <UserStat label="Hireable" value={s.hireable} />
            <UserStat label="Flagged" value={s.flagged} className="text-amber-600" />
            <UserStat label="Banned IPs" value={s.banned} className="text-destructive" />
            <UserStat label="Deleted" value={s.deleted} className="text-muted-foreground" />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-50">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
              <Input
                value={filters.q}
                onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                placeholder="Search display name or in-game name…"
                className="pl-7"
              />
            </div>
            <select
              value={filters.sort}
              onChange={(e) => setFilters({ ...filters, sort: e.target.value })}
              className="rounded border bg-background px-2 py-1 text-sm"
            >
              <option value="joined_at">Newest first</option>
              <option value="last_login_at">Recently active</option>
              <option value="is_hireable">Hireable first</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            <FilterToggle
              label="Flagged"
              value={filters.filterFlagged}
              onChange={(v) => setFilters({ ...filters, filterFlagged: v })}
            />
            <FilterToggle
              label="Banned"
              value={filters.filterBanned}
              onChange={(v) => setFilters({ ...filters, filterBanned: v })}
            />
            <span className="inline-flex items-center">
              <FilterToggle
                label="Genesis only"
                value={filters.filterGenesis}
                onChange={(v) => setFilters({ ...filters, filterGenesis: v })}
              />
              <HelpTip text="Genesis = the first (earliest) account ever created from a given IP address. Subsequent accounts on the same IP are flagged 'shared_ip' and are NOT genesis. Useful for spotting alts." />
            </span>
            <FilterToggle
              label="Include deleted"
              value={filters.includeDeleted}
              onChange={(v) => setFilters({ ...filters, includeDeleted: v })}
            />
          </div>
        </CardContent>
      </Card>

      {users.isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {users.error && <p className="text-sm text-destructive">{(users.error as Error).message}</p>}

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
                    {u.in_game_name && (
                      <>
                        In-game: <span className="font-mono">{u.in_game_name}</span> ·{" "}
                      </>
                    )}
                    Joined {new Date(u.joined_at).toLocaleDateString()}
                    {u.last_used_at && (
                      <> · Last seen {new Date(u.last_used_at).toLocaleDateString()}</>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono break-all">
                    {u.api_key.slice(0, 8)}…{u.api_key.slice(-4)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" onClick={() => setSiblingTarget(u)}>
                    Siblings
                  </Button>
                  {u.flag_count > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setFlagsTarget(u)}>
                      Flags ({u.flag_count})
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => regenMut.mutate(u.api_key)}>
                    Regen name
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setPermsTarget(u)}>
                    Permissions
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRekeyConfirm(u)}>
                    Re-key
                  </Button>
                  {u.deleted_at ? (
                    <Button size="sm" variant="outline" onClick={() => reactMut.mutate(u.api_key)}>
                      Reactivate
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setDeleteConfirm(u)}>
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

      <BanDialog
        target={banTarget}
        onClose={() => setBanTarget(null)}
        onDone={() => {
          queryClient.invalidateQueries({ queryKey: ["admin-users"] });
          queryClient.invalidateQueries({ queryKey: ["admin-user-stats"] });
        }}
      />

      <SiblingsDialog target={siblingTarget} onClose={() => setSiblingTarget(null)} />

      <FlagsDialog
        target={flagsTarget}
        onClose={() => setFlagsTarget(null)}
        onResolved={() => {
          queryClient.invalidateQueries({ queryKey: ["admin-users"] });
          queryClient.invalidateQueries({ queryKey: ["admin-user-stats"] });
        }}
      />

      <PermissionsDialog target={permsTarget} onClose={() => setPermsTarget(null)} />

      <RekeyResultDialog result={rekeyResult} onClose={() => setRekeyResult(null)} />

      <ConfirmDialog
        open={!!rekeyConfirm}
        title="Re-key this account?"
        description={
          rekeyConfirm ? (
            <>
              A brand-new API key will be issued for{" "}
              <span className="font-mono">{rekeyConfirm.display_name}</span> and the current key
              will be <strong>revoked immediately</strong>. The user will be signed out until they
              enter the new key. Make sure you can deliver the new key securely before continuing.
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
              <span className="font-mono">{deleteConfirm.display_name}</span> will be marked
              deleted, their personal fields cleared and their API key revoked. They can still be
              reactivated later from this page.
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
