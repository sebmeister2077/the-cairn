import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Download, Eye, EyeOff, Copy } from "lucide-react";
import {
  getMyAccountSafe,
  updateMyAccount,
  regenerateMyDisplayName,
  exportMyData,
  deleteMyAccount,
  registerAccount,
  getStoredApiKey,
  clearStoredAuthFlags,
  clearAdminSession,
  clearPersistedQueryCache,
  type AccountMeResponse,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminPasskeyPanel } from "@/components/AdminPasskeyPanel";
import { MyTranslocatorContributionsCard } from "@/components/account/MyTranslocatorContributionsCard";
import { MarkerStylePicker } from "@/components/account/MarkerStylePicker";
import { Trans, useTranslation } from "@/lib/i18n";
import { useAppDispatch, useReduxState } from "@/store/hooks";
import { setStarfieldEnabled } from "@/store/slices/mapView";

export function AccountPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const apiKey = useReduxState("auth.apiKey");
  const dispatch = useAppDispatch();
  const starfieldEnabled = useReduxState("mapView.starfieldEnabled");
  const [showKey, setShowKey] = useState(false);
  const [inGameName, setInGameName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");

  const { data, isLoading, error } = useQuery<AccountMeResponse>({
    queryKey: ["account-me", apiKey ?? ""],
    queryFn: getMyAccountSafe,
    retry: false,
  });

  useEffect(() => {
    if (isLoading || error || !data?.user?.in_game_name) return;
    setInGameName(data.user.in_game_name);
  }, [data, isLoading, error]);

  // Derive registration state from the query result so it stays correct
  // even when the cache was already populated by another component (e.g.
  // the header indicator) and `queryFn` doesn't re-run on mount.
  const needsRegister = !!data && data.user === null && !data.is_admin;

  const registerMut = useMutation({
    mutationFn: registerAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["account-me"] });
    },
  });

  const updateMut = useMutation({
    mutationFn: updateMyAccount,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["account-me"] }),
  });

  const regenMut = useMutation({
    mutationFn: regenerateMyDisplayName,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["account-me"] }),
  });

  const deleteMut = useMutation({
    mutationFn: deleteMyAccount,
    onSuccess: () => {
      // Wipe every trace of the now-deleted account from the browser:
      // the API key, cached admin/contributor flags, the admin passkey
      // session, the in-memory React Query cache, and the persisted
      // query cache in localStorage. Then hard-navigate so any in-memory
      // page state is dropped too.
      localStorage.removeItem("api_key");
      clearStoredAuthFlags();
      clearAdminSession();
      queryClient.clear();
      clearPersistedQueryCache();
      window.location.href = "/";
    },
  });

  const user = data?.user ?? null;

  if (!apiKey) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("account.noApiKey.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("account.noApiKey.description")}</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (needsRegister) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("account.register.title")}</CardTitle>
          <CardDescription>{t("account.register.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => registerMut.mutate()} disabled={registerMut.isPending}>
            {registerMut.isPending
              ? t("account.register.submitting")
              : t("account.register.submit")}
          </Button>
          {registerMut.error && (
            <p className="text-sm text-destructive">{(registerMut.error as Error).message}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-destructive">
          {(error as Error).message}
        </CardContent>
      </Card>
    );
  }

  if (data?.is_admin && !user) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("account.adminSession.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            <Trans
              path="account.adminSession.description"
              components={{ code: <span className="font-mono" /> }}
            />
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("account.page.title")}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">{t("account.page.description")}</p>
      </div>

      {/* Identity */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("account.identity.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="ign" className="text-xs text-muted-foreground">
              {t("account.identity.inGameName")}{" "}
              {user.use_in_game_name ? "" : t("account.identity.optional")}
            </Label>
            <div className="flex gap-2">
              <Input
                id="ign"
                value={inGameName}
                onChange={(e) => setInGameName(e.target.value)}
                placeholder={t("account.identity.inGameNamePlaceholder")}
                maxLength={64}
              />
              <Button
                size="sm"
                onClick={() =>
                  updateMut.mutate({
                    in_game_name: inGameName.trim() || undefined,
                    clear_in_game_name: !inGameName.trim(),
                  })
                }
                disabled={updateMut.isPending}
              >
                {t("account.identity.save")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {user.use_in_game_name
                ? t("account.identity.saveUpdatesDisplayName")
                : t("account.identity.hireBoardMatching")}
            </p>
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>{t("account.identity.useInGameName")}</Label>
              <p className="text-xs text-muted-foreground">
                {user.in_game_name
                  ? t("account.identity.useInGameNameEnabled")
                  : t("account.identity.useInGameNameDisabled")}
              </p>
            </div>
            <Switch
              checked={user.use_in_game_name}
              disabled={updateMut.isPending || (!user.in_game_name && !user.use_in_game_name)}
              onCheckedChange={(v) => updateMut.mutate({ use_in_game_name: v })}
            />
          </div>
          {!user.use_in_game_name && (
            <>
              <Separator />
              <div>
                <Label className="text-xs text-muted-foreground">
                  {t("account.identity.displayName")}
                </Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="rounded bg-muted px-2 py-1 text-sm font-mono">
                    {user.display_name}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => regenMut.mutate()}
                    disabled={regenMut.isPending}
                  >
                    <RefreshCw className="size-3" />
                    {t("account.identity.regenerate")}
                  </Button>
                </div>
                {regenMut.error && (
                  <p className="text-xs text-destructive mt-1">
                    {(regenMut.error as Error).message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {t("account.identity.regeneratedCount", { count: user.name_regen_count })}
                </p>
              </div>
            </>
          )}
          {updateMut.error && (
            <p className="text-xs text-destructive">{(updateMut.error as Error).message}</p>
          )}
        </CardContent>
      </Card>

      {/* Preferences */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("account.preferences.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t("account.preferences.availableForHire")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("account.preferences.availableForHireDescription")}
              </p>
            </div>
            <Switch
              disabled
              // checked={user.is_hireable}
              onCheckedChange={(v) => updateMut.mutate({ is_hireable: v })}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label>{t("account.preferences.showOnLeaderboards")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("account.preferences.showOnLeaderboardsDescription")}
              </p>
            </div>
            <Switch
              disabled
              // checked={user.is_leaderboard_visible}
              onCheckedChange={(v) => updateMut.mutate({ is_leaderboard_visible: v })}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label>{t("account.preferences.showContributions")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("account.preferences.showContributionsDescription")}
              </p>
            </div>
            <Switch
              disabled
              // checked={user.show_contributions}
              onCheckedChange={(v) => updateMut.mutate({ show_contributions: v })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("account.appearance.title")}</CardTitle>
          <CardDescription>{t("account.appearance.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="starfield-toggle">{t("account.appearance.starfieldLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("account.appearance.starfieldDescription")}
              </p>
            </div>
            <Switch
              id="starfield-toggle"
              checked={starfieldEnabled}
              onCheckedChange={(v) => dispatch(setStarfieldEnabled(v))}
            />
          </div>
          <Separator className="my-3" />
          <div className="space-y-2">
            <div className="space-y-0.5">
              <Label>{t("account.appearance.markerIconsTitle")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("account.appearance.markerIconsDescription")}
              </p>
            </div>
            <MarkerStylePicker />
          </div>
        </CardContent>
      </Card>

      {/* API Key */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("account.apiKey.title")}</CardTitle>
          <CardDescription>{t("account.apiKey.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input
              readOnly
              value={showKey ? apiKey : apiKey.replace(/./g, "•")}
              className="font-mono text-xs"
            />
            <Button size="sm" variant="outline" onClick={() => setShowKey((v) => !v)}>
              {showKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigator.clipboard.writeText(apiKey)}
            >
              <Copy className="size-3" />
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const blob = new Blob(
                [
                  JSON.stringify(
                    {
                      display_name: user.display_name,
                      api_key: apiKey,
                      exported_at: new Date().toISOString(),
                    },
                    null,
                    2,
                  ),
                ],
                { type: "application/json" },
              );
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `cairn-recovery-${user.display_name}.json`;
              a.click();
            }}
          >
            <Download className="size-3" />
            {t("account.apiKey.downloadRecoveryFile")}
          </Button>
        </CardContent>
      </Card>

      {/* Data export */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("account.dataExport.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={async () => {
              const data = await exportMyData();
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `cairn-export-${user.display_name}.json`;
              a.click();
            }}
          >
            <Download className="size-3" />
            {t("account.dataExport.exportEverything")}
          </Button>
        </CardContent>
      </Card>

      {/* User-contributed translocators self-history. The card hides itself
          when the caller has no contributions. */}
      <MyTranslocatorContributionsCard />

      {/* Admin-only: passkey 2FA management. Renders nothing for non-admins
          or when the server has WebAuthn unconfigured. */}
      {data?.is_admin && <AdminPasskeyPanel />}

      {/* Danger zone */}
      <Card className="border-destructive/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-destructive">
            {t("account.dangerZone.title")}
          </CardTitle>
          <CardDescription>{t("account.dangerZone.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label className="text-xs">{t("account.dangerZone.confirmLabel")}</Label>
          <div className="flex gap-2">
            <Input
              value={confirmDelete}
              onChange={(e) => setConfirmDelete(e.target.value)}
              placeholder={t("account.dangerZone.confirmPlaceholder")}
            />
            <Button
              variant="destructive"
              disabled={confirmDelete !== "DELETE" || deleteMut.isPending}
              onClick={() => deleteMut.mutate()}
            >
              {t("account.dangerZone.deleteAccount")}
            </Button>
          </div>
          {deleteMut.error && (
            <p className="text-sm text-destructive">{(deleteMut.error as Error).message}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
