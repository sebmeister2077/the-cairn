import { Check, MailOpen, Link } from "lucide-react";
import { type InviteLinkRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useCopy } from "@/components/useCopy";
import { fmt } from "@/components/DateFormatter";

export function CreatedInviteLinkDialog({
  record,
  onClose,
}: {
  record: InviteLinkRecord | null;
  onClose: () => void;
}) {
  const { copied, copy } = useCopy();
  if (!record) return null;

  const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(record.token)}`;

  return (
    <Dialog open={!!record} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MailOpen className="size-4 text-emerald-500" />
            Invite Link Created
          </DialogTitle>
          <DialogDescription>
            Share this link. Anyone who opens it can claim a new API key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Invite Link</Label>
            <div className="flex gap-2">
              <Input readOnly value={inviteUrl} className="font-mono text-xs text-muted-foreground" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy(inviteUrl, "link")}
                className="shrink-0"
              >
                {copied === "link" ? (
                  <Check className="size-4 text-emerald-500" />
                ) : (
                  <Link className="size-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground space-y-0.5">
            <p><span className="font-medium text-foreground">Permissions:</span> {record.permissions === "contribute" ? "Read & Contribute" : "Read only"}</p>
            <p><span className="font-medium text-foreground">Max claims:</span> {record.max_uses !== null ? record.max_uses : "Unlimited"}</p>
            <p><span className="font-medium text-foreground">Expires:</span> {record.expires_at ? fmt(record.expires_at) : "Never"}</p>
          </div>
        </div>

        <Button onClick={onClose} className="w-full">Done</Button>
      </DialogContent>
    </Dialog>
  );
}
