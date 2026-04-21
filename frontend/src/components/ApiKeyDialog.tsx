import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  setApiKey,
  getStoredApiKey,
  checkAuthStatus,
  setStoredIsAdmin,
  setStoredCanContribute,
} from "@/lib/api";

export function ApiKeyDialog({
  open,
  onClose,
  onAdminStatusChange,
}: {
  open: boolean;
  onClose: () => void;
  onAdminStatusChange: (isAdmin: boolean) => void;
}) {
  const [key, setKey] = useState(getStoredApiKey());
  const [loading, setLoading] = useState(false);

  async function handleSave() {
    setLoading(true);
    setApiKey(key.trim());
    const status = await checkAuthStatus();
    setStoredIsAdmin(status.is_admin);
    setStoredCanContribute(status.can_contribute);
    onAdminStatusChange(status.is_admin);
    setLoading(false);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API Key</DialogTitle>
          <DialogDescription>
            Enter your API key to authenticate requests.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="apikey">API Key</Label>
          <Input
            id="apikey"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
          />
        </div>
        <Button onClick={handleSave} disabled={loading}>
          {loading ? "Saving…" : "Save"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
