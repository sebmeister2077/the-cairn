import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  adminWebauthnStatus,
  clearAdminSession,
} from "@/lib/api";

export function ApiKeyDialog({
  open,
  onClose,
  onAdminStatusChange,
  onAdminPasskeyNeeded,
}: {
  open: boolean;
  onClose: () => void;
  onAdminStatusChange: (isAdmin: boolean) => void;
  /** Called after a successful admin login when the next step is a passkey
   *  ceremony. ``mode`` is "assert" if the admin has at least one passkey
   *  registered and must verify, or "register" when the server offers
   *  WebAuthn but the admin hasn't enrolled yet (treated as a soft prompt). */
  onAdminPasskeyNeeded?: (mode: "assert" | "register") => void;
}) {
  const [key, setKey] = useState(getStoredApiKey());
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  // The dialog stays mounted in <AppContent/>, so the initial useState value
  // never refreshes on its own. Re-sync from storage every time the dialog
  // opens so flows that write the key elsewhere (invite claim, ?key= URL
  // param, etc.) don't show a misleadingly empty input.
  useEffect(() => {
    if (open) setKey(getStoredApiKey());
  }, [open]);

  async function handleSave() {
    setLoading(true);
    const trimmed = key.trim();
    const previous = getStoredApiKey();
    setApiKey(trimmed);
    const status = await checkAuthStatus();
    setStoredIsAdmin(status.is_admin);
    setStoredCanContribute(status.can_contribute);
    onAdminStatusChange(status.is_admin);
    if (trimmed !== previous) {
      // The new key may have different permissions (or be valid where the old
      // one was not). Drop every cached query — including ones currently in an
      // error state — and force every mounted query to refetch with the new
      // X-API-Key header.
      queryClient.removeQueries();
      await queryClient.invalidateQueries();
    }

    // Phase 4c: if this is an admin login, find out whether a passkey
    // ceremony is required next. Wrapped in try/catch so a 503 (WebAuthn
    // unconfigured on the server) silently no-ops.
    if (status.is_admin) {
      try {
        const wa = await adminWebauthnStatus();
        if (wa.configured && wa.enrolled) {
          // Always assert on a fresh login — drop any stale session token
          // first so the server forces us through the ceremony.
          clearAdminSession();
          onAdminPasskeyNeeded?.("assert");
        } else if (wa.configured && !wa.enrolled) {
          onAdminPasskeyNeeded?.("register");
        }
      } catch {
        // WebAuthn not configured / DB unavailable — don't block login.
      }
    }

    setLoading(false);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API Key</DialogTitle>
          <DialogDescription>Enter your API key to authenticate requests.</DialogDescription>
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
          {/* Copy button */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => navigator.clipboard.writeText(key)}
          >
            Copy
          </Button>
        </div>
        <Button onClick={handleSave} disabled={loading}>
          {loading ? "Saving…" : "Save"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
