import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createApiKey, type ApiKeyRecord } from "@/lib/api";
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

export function GenerateKeyDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (record: ApiKeyRecord) => void;
}) {
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<"read" | "contribute">("read");
  const [consumeOnce, setConsumeOnce] = useState(false);
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: createApiKey,
    onSuccess: (record) => {
      onCreate(record);
      setName("");
      setPermissions("read");
      setConsumeOnce(false);
      setError("");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function handleSubmit() {
    if (!name.trim()) { setError("Name is required"); return; }
    setError("");
    mutation.mutate({ name: name.trim(), permissions, consume_once: consumeOnce });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Generate API Key</DialogTitle>
          <DialogDescription>New keys are active immediately.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="key-name">Name / Note <span className="text-destructive">*</span></Label>
            <Input
              id="key-name"
              placeholder="e.g. Server regulars, Friend Alex"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Permissions</Label>
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

          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Consume once</p>
              <p className="text-xs text-muted-foreground">
                Binds to the first user's IP; rejects others.
              </p>
            </div>
            <Switch
              checked={consumeOnce}
              onCheckedChange={setConsumeOnce}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending} className="flex-1">
            {mutation.isPending ? "Generating…" : "Generate"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
