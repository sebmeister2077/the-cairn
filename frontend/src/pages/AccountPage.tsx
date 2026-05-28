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
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { MyTranslocatorContributionsCard } from "@/components/account/MyTranslocatorContributionsCard";
import { MarkerStylePicker } from "@/components/account/MarkerStylePicker";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { useTranslation } from "@/lib/i18n";
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
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You need to set an API key first to view or create your account.
          </p>
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
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            Accept the terms and a random display name will be generated for you. Creating account
            is not needed for viewing & contributing the map
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => registerMut.mutate()} disabled={registerMut.isPending}>
            {registerMut.isPending ? "Creating…" : "Accept terms & create account"}
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
          <CardTitle>Admin session</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You are signed in as the system admin. The admin key has no user profile. Manage other
            users under <span className="font-mono">Manage → Users</span>.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">My Account</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage your public profile, API key, and personal data.
        </p>
      </div>

      {/* Identity */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="ign" className="text-xs text-muted-foreground">
              In-game name {user.use_in_game_name ? "" : "(optional)"}
            </Label>
            <div className="flex gap-2">
              <Input
                id="ign"
                value={inGameName}
                onChange={(e) => setInGameName(e.target.value)}
                placeholder="Your Vintage Story character name"
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
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {user.use_in_game_name
                ? "Saving will also update your public display name to match."
                : "Used for hire-board matching. Other users may flag duplicates."}
            </p>
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Use in-game name as display name</Label>
              <p className="text-xs text-muted-foreground">
                {user.in_game_name
                  ? "When on, other users see your in-game name everywhere instead of a random handle."
                  : "Set an in-game name first to enable this."}
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
                <Label className="text-xs text-muted-foreground">Display name</Label>
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
                    Regenerate
                  </Button>
                </div>
                {regenMut.error && (
                  <p className="text-xs text-destructive mt-1">
                    {(regenMut.error as Error).message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Regenerated {user.name_regen_count} times. Limited to 3 per day.
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
          <CardTitle className="text-base">Preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label>Available for hire</Label>
              <p className="text-xs text-muted-foreground">Show me on the hire board. (WIP)</p>
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
              <Label>Show on leaderboards</Label>
              <p className="text-xs text-muted-foreground">
                Opt-in to appear on contributor leaderboards. (WIP)
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
              <Label>Show Contributions</Label>
              <p className="text-xs text-muted-foreground">
                Reveal who submitted an explored area (WIP). Will fallback to the expedition
                financier's name if disabled
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
          <div className="flex items-center justify-between">
            <Label>{t("common.theme")}</Label>
            <ThemeSwitcher />
          </div>
          <Separator className="my-3" />
          <div className="flex items-center justify-between">
            <Label>{t("common.language")}</Label>
            <LanguageSwitcher />
          </div>
          <Separator className="my-3" />
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="starfield-toggle">Animated starfield on map</Label>
              <p className="text-xs text-muted-foreground">
                Show a subtle cosmos backdrop behind unexplored areas of the TOPS map. Pure CSS,
                GPU-only — turn off if you prefer a flat dark background.
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
              <Label>Map marker icons</Label>
              <p className="text-xs text-muted-foreground">
                Pick how Traders, Translocator endpoints, and Terminus waypoints are drawn on the
                map. Changes apply immediately and are saved to your browser.
              </p>
            </div>
            <MarkerStylePicker />
          </div>
        </CardContent>
      </Card>

      {/* API Key */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">API Key</CardTitle>
          <CardDescription>Your secret access key. Treat it like a password.</CardDescription>
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
            Download recovery file
          </Button>
        </CardContent>
      </Card>

      {/* Data export */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your data</CardTitle>
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
            Export everything (JSON)
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
          <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Deleting your account is irreversible without admin assistance. Your API key will be
            revoked and your contributions will be reattributed to a tombstone identity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label className="text-xs">Type DELETE to confirm</Label>
          <div className="flex gap-2">
            <Input
              value={confirmDelete}
              onChange={(e) => setConfirmDelete(e.target.value)}
              placeholder="DELETE"
            />
            <Button
              variant="destructive"
              disabled={confirmDelete !== "DELETE" || deleteMut.isPending}
              onClick={() => deleteMut.mutate()}
            >
              Delete my account
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
