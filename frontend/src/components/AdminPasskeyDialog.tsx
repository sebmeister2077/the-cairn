/**
 * AdminPasskeyDialog
 * ------------------
 * One dialog covering both admin passkey ceremonies:
 *
 *  - **register** mode: shown when an admin first logs in and has no
 *    passkey, or from the Account page when they want to add another
 *    device. Walks the user through `navigator.credentials.create()` and
 *    persists the new credential.
 *
 *  - **assert**  mode: shown automatically after an admin pastes their API
 *    key (and on every subsequent admin page load when the session token
 *    has expired). Triggers `navigator.credentials.get()`, exchanges the
 *    assertion for an X-Admin-Session token and stores it in localStorage.
 *
 * The dialog blocks every other admin action on the page, mirroring the
 * UX of OS-level "verify with Touch ID" sheets.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, KeyRound, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adminWebauthnRegisterBegin,
  adminWebauthnRegisterComplete,
  adminWebauthnAuthBegin,
  adminWebauthnAuthComplete,
  setAdminSession,
} from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

export type PasskeyDialogMode = "register" | "assert";

export function AdminPasskeyDialog({
  open,
  mode,
  onClose,
  onSuccess,
  required = false,
}: {
  open: boolean;
  mode: PasskeyDialogMode;
  onClose: () => void;
  onSuccess?: () => void;
  /** When true, the user cannot dismiss the dialog with Esc / overlay click.
   *  Use for the post-login assertion gate. */
  required?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);

  // Detect platform support once. ``window.PublicKeyCredential`` is the
  // canonical capability marker — it is missing on insecure origins (http
  // outside localhost) and on browsers without WebAuthn.
  useEffect(() => {
    if (!open) return;
    const ok = typeof window !== "undefined" && !!window.PublicKeyCredential;
    setSupported(ok);
    if (!ok) {
      setError(t("account.passkeys.dialog.browserUnsupported"));
    } else {
      setError(null);
    }
    if (mode !== "register") setName("");
  }, [open, mode]);

  const register = useMutation({
    mutationFn: async (label: string) => {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options } = await adminWebauthnRegisterBegin(label);
      // simplewebauthn accepts the options dict shape FastAPI returned.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const credential = await startRegistration(options as any);
      return adminWebauthnRegisterComplete(label, credential);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-webauthn-status"] });
      queryClient.invalidateQueries({ queryKey: ["admin-webauthn-credentials"] });
      onSuccess?.();
      onClose();
    },
    onError: (e: unknown) => setError(humanizeWebAuthnError(e, t)),
  });

  const assert = useMutation({
    mutationFn: async () => {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options } = await adminWebauthnAuthBegin();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const credential = await startAuthentication(options as any);
      const result = await adminWebauthnAuthComplete(credential);
      setAdminSession(result.session_token, result.expires_in);
      return result;
    },
    onSuccess: () => {
      onSuccess?.();
      onClose();
    },
    onError: (e: unknown) => setError(humanizeWebAuthnError(e, t)),
  });

  const pending = register.isPending || assert.isPending;

  const title =
    mode === "register"
      ? t("account.passkeys.dialog.registerTitle")
      : t("account.passkeys.dialog.verifyTitle");
  const description =
    mode === "register"
      ? t("account.passkeys.dialog.registerDescription")
      : t("account.passkeys.dialog.verifyDescription");

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !required && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={!required}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === "register" ? (
              <KeyRound className="h-5 w-5 text-amber-500" />
            ) : (
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {mode === "register" && supported && (
          <div className="grid gap-2">
            <Label htmlFor="passkey-name">{t("account.passkeys.dialog.deviceName")}</Label>
            <Input
              id="passkey-name"
              autoFocus
              placeholder={t("account.passkeys.dialog.deviceNamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              {t("account.passkeys.dialog.deviceNameHelp")}
            </p>
          </div>
        )}

        {mode === "assert" && supported && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Fingerprint className="h-12 w-12 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground text-center">
              {t("account.passkeys.dialog.waiting")}
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter className="gap-2">
          {!required && (
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              {mode === "assert"
                ? t("account.passkeys.dialog.signOut")
                : t("account.passkeys.dialog.notNow")}
            </Button>
          )}
          {mode === "register" ? (
            <Button
              onClick={() => {
                setError(null);
                register.mutate((name || t("account.passkeys.dialog.defaultPasskeyName")).trim());
              }}
              disabled={pending || !supported}
            >
              {register.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {t("account.passkeys.dialog.addPasskey")}
            </Button>
          ) : (
            <Button
              onClick={() => {
                setError(null);
                assert.mutate();
              }}
              disabled={pending || !supported}
            >
              {assert.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Fingerprint className="h-4 w-4" />
              )}
              {t("account.passkeys.dialog.verifyPasskey")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Map low-level WebAuthn / fetch errors to short, actionable copy. */
function humanizeWebAuthnError(e: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  if (e instanceof Error) {
    const msg = e.message || "";
    if (/NotAllowed/i.test(msg)) {
      return t("account.passkeys.dialog.cancelledOrTimedOut");
    }
    if (/InvalidState/i.test(msg)) {
      return t("account.passkeys.dialog.alreadyRegistered");
    }
    if (/SecurityError/i.test(msg)) {
      return t("account.passkeys.dialog.securityError");
    }
    if (/passkey_session_expired|passkey_required/i.test(msg)) {
      return t("account.passkeys.dialog.sessionExpired");
    }
    return msg;
  }
  return t("account.passkeys.dialog.unexpectedError");
}

/** Convenience hook used by the Account page badge — exposes the memoised
 *  human-readable expiry of the current admin session, refreshed every minute. */
export function useAdminSessionExpiry() {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    const onChange = () => setTick((t) => t + 1);
    window.addEventListener("admin-session-changed", onChange);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("admin-session-changed", onChange);
    };
  }, []);
  return useMemo(() => {
    void tick;
    const raw = Number(localStorage.getItem("admin_session_expires") ?? "0");
    if (!raw) return null;
    const remaining = raw - Date.now();
    if (remaining <= 0) return t("account.passkeys.expired");
    const minutes = Math.round(remaining / 60_000);
    if (minutes < 60) return t("account.passkeys.expiresInMinutes", { count: minutes });
    const hours = Math.round(minutes / 60);
    return t("account.passkeys.expiresInHours", { count: hours });
  }, [tick, t]);
}
