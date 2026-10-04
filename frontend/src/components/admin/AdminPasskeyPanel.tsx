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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  adminWebauthnStatus,
  adminWebauthnListCredentials,
  adminWebauthnDeleteCredential,
  adminWebauthnLogout,
  adminWebauthnSetStrictMode,
  getAdminSession,
} from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { AdminPasskeyDialog, useAdminSessionExpiry } from "@/components/admin/AdminPasskeyDialog";
import { Trans, useFormat, useTranslation } from "@/lib/i18n";

export function AdminPasskeyPanel() {
  const { t } = useTranslation();
  const { dateTime } = useFormat();
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
  const sessionExpired = expiry === t("account.passkeys.expired");
  const hasVerifiedSession = hasSession && !sessionExpired;

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

  const strictMut = useMutation({
    mutationFn: adminWebauthnSetStrictMode,
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
            <KeyRound className="h-4 w-4" /> {t("account.passkeys.loadingTitle")}
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
  const strictMode = !!status.data.strict_mode;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> {t("account.passkeys.title")}
            {enrolled ? (
              <span className="ml-1 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                <ShieldCheck className="h-3 w-3" /> {t("account.passkeys.activeBadge")}
              </span>
            ) : enforced ? (
              <span className="ml-1 inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                <ShieldAlert className="h-3 w-3" /> {t("account.passkeys.recommendedBadge")}
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>
            <Trans
              path="account.passkeys.description"
              components={{
                code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
              }}
            />
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Session status */}
          <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">{t("account.passkeys.session")}</span>
            {hasVerifiedSession ? (
              <>
                <span className="text-emerald-700 dark:text-emerald-400">
                  {t("account.passkeys.verified")}
                </span>
                {expiry && <span className="text-muted-foreground">({expiry})</span>}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => logoutMut.mutate()}
                  disabled={logoutMut.isPending}
                >
                  {t("account.passkeys.signOut")}
                </Button>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">
                  {enrolled
                    ? t("account.passkeys.notVerified")
                    : t("account.passkeys.noPasskeyYet")}
                </span>
                {enrolled && (
                  <Button size="sm" className="ml-auto" onClick={() => setDialog("assert")}>
                    {t("account.passkeys.verifyNow")}
                  </Button>
                )}
              </>
            )}
          </div>

          {/* Strict mode toggle */}
          <div className="flex flex-wrap items-center gap-3 rounded border bg-muted/40 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium">
                <ShieldCheck className="h-4 w-4" /> Strict mode
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                When on, every admin who makes changes (or views API keys) must have a passkey.
                Admins without one are limited to read-only actions until they enrol one.
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span
                className={
                  strictMode
                    ? "text-xs text-emerald-700 dark:text-emerald-400"
                    : "text-xs text-muted-foreground"
                }
              >
                {strictMode ? "On" : "Off"}
              </span>
              <Switch
                checked={strictMode}
                disabled={!enrolled || !hasVerifiedSession || strictMut.isPending}
                onCheckedChange={(v) => strictMut.mutate(v)}
                aria-label="Toggle admin strict mode"
              />
            </div>
          </div>
          {!enrolled && (
            <p className="-mt-1 text-xs text-muted-foreground">
              Add a passkey below to enable strict mode.
            </p>
          )}
          {enrolled && !hasVerifiedSession && (
            <p className="-mt-1 text-xs text-muted-foreground">
              Verify your passkey to change strict mode.
            </p>
          )}
          {strictMut.error && (
            <p className="-mt-1 text-sm text-destructive">{(strictMut.error as Error).message}</p>
          )}

          {/* Credential list */}
          <div className="space-y-2">
            {credentials.data?.credentials.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("account.passkeys.noPasskeys")}</p>
            )}
            {credentials.data?.credentials.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("account.passkeys.added", { date: formatDate(c.created_at, dateTime, t) })}
                    {c.last_used_at && (
                      <>
                        {" "}
                        ·{" "}
                        {t("account.passkeys.lastUsed", {
                          date: formatDate(c.last_used_at, dateTime, t),
                        })}
                      </>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    if (confirm(t("account.passkeys.removeConfirm", { name: c.name }))) {
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
              <KeyRound className="h-4 w-4" /> {t("account.passkeys.addPasskey")}
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

function formatDate(
  iso: string | null,
  dateTime: ReturnType<typeof useFormat>["dateTime"],
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!iso) return t("account.passkeys.emptyDate");
  try {
    return dateTime(iso, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}
