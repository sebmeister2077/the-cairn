import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createInviteLink, type InviteLinkRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function CreateInviteLinkDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (record: InviteLinkRecord) => void;
}) {
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<"read" | "contribute">("read");
  const [maxUsesEnabled, setMaxUsesEnabled] = useState(false);
  const [maxUses, setMaxUses] = useState("10");
  const [expiryEnabled, setExpiryEnabled] = useState(false);
  const [expiryHours, setExpiryHours] = useState("72");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: createInviteLink,
    onSuccess: (record) => {
      onCreate(record);
      setName("");
      setPermissions("read");
      setMaxUsesEnabled(false);
      setMaxUses("10");
      setExpiryEnabled(false);
      setExpiryHours("72");
      setError("");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function handleSubmit() {
    if (!name.trim()) { setError("Name is required"); return; }
    const maxUsesVal = maxUsesEnabled ? parseInt(maxUses, 10) : null;
    if (maxUsesEnabled && (isNaN(maxUsesVal!) || maxUsesVal! < 1)) {
      setError("Max uses must be at least 1");
      return;
    }
    const expiryVal = expiryEnabled ? parseInt(expiryHours, 10) : null;
    if (expiryEnabled && (isNaN(expiryVal!) || expiryVal! < 1)) {
      setError("Expiry must be at least 1 hour");
      return;
    }
    setError("");
    mutation.mutate({
      name: name.trim(),
      permissions,
      max_uses: maxUsesVal,
      expires_in_hours: expiryVal,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Invite Link</DialogTitle>
          <DialogDescription>
            Anyone with the link can claim a new API key with the permissions you configure.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-name">Label <span className="text-destructive">*</span></Label>
            <Input
              id="invite-name"
              placeholder="e.g. Server regulars, Discord friends"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Permissions for claimed keys</Label>
            <Select value={permissions} onValueChange={(v) => setPermissions(v as "read" | "contribute")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read only</SelectItem>
                <SelectItem value="contribute">Read &amp; Contribute</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Limit total claims</p>
                <p className="text-xs text-muted-foreground">Maximum number of people who can claim a key.</p>
              </div>
              <Switch checked={maxUsesEnabled} onCheckedChange={setMaxUsesEnabled} />
            </div>
            {maxUsesEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="max-uses">Max claims</Label>
                <Input
                  id="max-uses"
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Set expiry</p>
                <p className="text-xs text-muted-foreground">Link stops working after this time.</p>
              </div>
              <Switch checked={expiryEnabled} onCheckedChange={setExpiryEnabled} />
            </div>
            {expiryEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="expiry-hours">Valid for (hours)</Label>
                <Input
                  id="expiry-hours"
                  type="number"
                  min={1}
                  value={expiryHours}
                  onChange={(e) => setExpiryHours(e.target.value)}
                />
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending} className="flex-1">
            {mutation.isPending ? "Creating…" : "Create Link"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
