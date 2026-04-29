import { adminListFlags, adminResolveFlag, type AdminUserListItem, type UserFlag } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { HelpTip } from "../ui/help-tip";
import { FlagRow } from "./FlagRow";

export function FlagsDialog({
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
                <FlagRow
                  key={f.id}
                  flag={f}
                  onResolve={(resolution) => resolveMut.mutate({ id: f.id, resolution })}
                  pending={resolveMut.isPending}
                />
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
