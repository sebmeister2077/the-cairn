/**
 * AdminPasskeyPanel
 * -----------------
 * Account-page card for admins to manage their WebAuthn (passkey) factor.
 * Hidden entirely when:
 *   - The signed-in user is not an admin, or
 *   - The server has WebAuthn unconfigured (missing RP_ID / rate-limited).
 *
 * Lets admins:
 *   - See whether passkey 2FA is enrolled and whether the current browser
 *     session is verified (with TTL countdown).
 *   - Add a new passkey (Touch ID, Windows Hello, hardware key, ...).
 *   - Revoke individual credentials.
 *   - Sign out of the passkey session (without losing the API key).
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, KeyRound, Trash2, ShieldCheck, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  adminWebauthnStatus,
  adminWebauthnListCredentials,
  adminWebauthnDeleteCredential,
  adminWebauthnLogout,
  getAdminSession,
} from "@/lib/api";
import {
  AdminPasskeyDialog,
  useAdminSessionExpiry,
} from "@/components/AdminPasskeyDialog";

export function AdminPasskeyPanel() {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<null | "register" | "assert">(null);

  const status = useQuery({
    queryKey: ["admin-webauthn-status"],
    queryFn: adminWebauthnStatus,
    retry: false,
  });

  const credentials = useQuery({
    queryKey: ["admin-webauthn-credentials"],
    queryFn: adminWebauthnListCredentials,
    enabled: !!status.data?.configured,
    retry: false,
  });

  const expiry = useAdminSessionExpiry();
  const hasSession = !!getAdminSession();

  const removeMut = useMutation({
    mutationFn: adminWebauthnDeleteCredential,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-webauthn-status"] });
      queryClient.invalidateQueries({ queryKey: ["admin-webauthn-credentials"] });
    },
  });

  const logoutMut = useMutation({
    mutationFn: adminWebauthnLogout,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-webauthn-status"] });
    },
  });

  // Server doesn't have WebAuthn configured (missing RP_ID etc.) — nothing to do here.
  if (status.isError) return null;
  if (status.isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Admin passkeys
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="h-4 w-4 animate-spin" />
        </CardContent>
      </Card>
    );
  }
  if (!status.data?.configured) return null;

  const enrolled = status.data.enrolled;
  const enforced = status.data.enforced;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Admin passkeys
            {enrolled ? (
              <span className="ml-1 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                <ShieldCheck className="h-3 w-3" /> 2FA active
              </span>
            ) : enforced ? (
              <span className="ml-1 inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                <ShieldAlert className="h-3 w-3" /> Recommended
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>
            Add a hardware-backed second factor on top of your admin API key.
            The private key never leaves your device — only signed challenges
            are sent to the server. Lose access to all your devices? An admin
            can clear the <code>webauthn_credentials</code> table to recover.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Session status */}
          <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">Session:</span>
            {hasSession ? (
              <>
                <span className="text-emerald-700 dark:text-emerald-400">verified</span>
                {expiry && expiry !== "expired" && (
                  <span className="text-muted-foreground">({expiry})</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => logoutMut.mutate()}
                  disabled={logoutMut.isPending}
                >
                  Sign out of passkey
                </Button>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">
                  {enrolled ? "not verified — re-authenticate to use admin endpoints" : "no passkey yet"}
                </span>
                {enrolled && (
                  <Button
                    size="sm"
                    className="ml-auto"
                    onClick={() => setDialog("assert")}
                  >
                    Verify now
                  </Button>
                )}
              </>
            )}
          </div>

          {/* Credential list */}
          <div className="space-y-2">
            {credentials.data?.credentials.length === 0 && (
              <p className="text-sm text-muted-foreground">No passkeys registered yet.</p>
            )}
            {credentials.data?.credentials.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Added {formatDate(c.created_at)}
                    {c.last_used_at && <> · Last used {formatDate(c.last_used_at)}</>}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    if (confirm(`Remove passkey "${c.name}"? Make sure you have another way to sign in.`)) {
                      removeMut.mutate(c.id);
                    }
                  }}
                  disabled={removeMut.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          {removeMut.error && (
            <p className="text-sm text-destructive">{(removeMut.error as Error).message}</p>
          )}

          <div className="flex justify-end">
            <Button onClick={() => setDialog("register")}>
              <KeyRound className="h-4 w-4" /> Add passkey
            </Button>
          </div>
        </CardContent>
      </Card>

      {dialog && (
        <AdminPasskeyDialog
          open={true}
          mode={dialog}
          onClose={() => setDialog(null)}
          onSuccess={() => setDialog(null)}
        />
      )}
    </>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
