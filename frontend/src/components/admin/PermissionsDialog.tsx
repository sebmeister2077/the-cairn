import { adminGetKeyPermissions, adminSetKeyPermission, type KeyPermission } from "@/lib/api";
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
    help: "Allow this contributor to submit region-restricted updates that overwrite existing chunks.",
  },
  {
    key: "trader_claims_publish",
    label: "Trader claim types (authoritative)",
    help: "Allow this key to publish authoritative trader-claim types (used by the VsProxy). Requires the trader_claims_authoritative feature flag.",
  },
];

export function PermissionsDialog({
  apiKey,
  label,
  onClose,
}: {
  /** API key whose permissions to edit; null closes the dialog. */
  apiKey: string | null;
  /** Human-readable name shown in the title (falls back to a shortened key). */
  label?: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

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

  if (!apiKey) return null;
  const perms = q.data?.extra_permissions ?? {};
  const title = label || `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`;

  return (
    <Dialog open={!!apiKey} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Permissions for {title}</DialogTitle>
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
