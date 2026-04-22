import { useState } from "react";
import { Copy, Check, Link } from "lucide-react";
import { type ApiKeyRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useCopy } from "@/components/useCopy";
import { fmt } from "@/components/DateFormatter";

export function CreatedKeyDialog({
  record,
  onClose,
}: {
  record: ApiKeyRecord | null;
  onClose: () => void;
}) {
  const { copied, copy } = useCopy();

  if (!record) return null;

  const shareUrl = `${window.location.origin}/?key=${encodeURIComponent(record.key)}`;

  return (
    <Dialog open={!!record} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <svg className="size-4 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            Key Created
          </DialogTitle>
          <DialogDescription>
            Copy this key now — it will not be shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>API Key</Label>
            <div className="flex gap-2">
              <Input readOnly value={record.key} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy(record.key, "key")}
                className="shrink-0"
              >
                {copied === "key" ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Shareable Link</Label>
            <div className="flex gap-2">
              <Input readOnly value={shareUrl} className="font-mono text-xs text-muted-foreground" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy(shareUrl, "link")}
                className="shrink-0"
              >
                {copied === "link" ? (
                  <Check className="size-4 text-emerald-500" />
                ) : (
                  <Link className="size-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Opening this link automatically applies the API key.
            </p>
          </div>

          <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground space-y-0.5">
            <p><span className="font-medium text-foreground">Permissions:</span> {record.permissions === "contribute" ? "Read & Contribute" : "Read only"}</p>
            <p><span className="font-medium text-foreground">Consume once:</span> {record.consume_once ? "Yes — binds to the first user's IP" : "No — shareable"}</p>
          </div>
        </div>

        <Button onClick={onClose} className="w-full">Done</Button>
      </DialogContent>
    </Dialog>
  );
}
