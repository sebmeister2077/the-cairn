import {
  adminGetKeyPermissions,
  adminSetKeyPermission,
  type AdminUserListItem,
  type KeyPermission,
} from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

const KEY_PERMISSIONS: { key: KeyPermission; label: string; help: string }[] = [
  {
    key: "region_overwrite",
    label: "Region overwrite",
    help: "Allow this contributor to submit region-restricted updates that overwrite existing tiles.",
  },
];

export function PermissionsDialog({
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
            Granular permissions on this API key. These supplement (not replace) the coarse "read" /
            "contribute" tier.
          </DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
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
