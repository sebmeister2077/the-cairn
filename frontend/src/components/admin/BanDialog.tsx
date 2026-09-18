import {
  type AdminUserListItem,
  type BanReasonCode,
  adminBanPreview,
  adminBanUser,
} from "@/lib/api";
import { Separator } from "@base-ui/react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const REASONS: { value: BanReasonCode; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "impersonation", label: "Impersonation" },
  { value: "abuse", label: "Abuse" },
  { value: "harassment", label: "Harassment" },
  { value: "duplicate_account", label: "Duplicate account" },
  { value: "provocative_name", label: "Provocative name" },
  { value: "other", label: "Other" },
];

export function BanDialog({
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
            This bans the user's hashed IP. All accounts on that IP will be soft-deleted and their
            API keys revoked.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex flex-col gap-2">
            <Label>Reason</Label>
            <Select value={reasonCode} onValueChange={(v) => setReasonCode(v as BanReasonCode)}>
              <SelectTrigger>
                <SelectValue>
                  {(value) => REASONS.find((r) => r.value === value)?.label || "Select a reason"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Reason details (visible internally)</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. ban evasion"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Admin notes (optional)</Label>
            <Input value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Duration (days)</Label>
            <Input
              type="number"
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value || "0", 10))}
            />
          </div>
          <Separator />
          <div className="flex flex-col gap-2">
            <Label>Blast radius</Label>
            {preview.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
            {preview.data && (
              <p className="text-xs text-muted-foreground">
                {preview.data.affected_users.length} account(s) on this IP will be revoked &amp;
                soft-deleted:
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
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim() || banMut.isPending}
              onClick={() => banMut.mutate()}
            >
              {banMut.isPending ? "Banning…" : "Ban IP"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
