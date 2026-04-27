import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Download, Eye, EyeOff, Copy } from "lucide-react";
import {
  getMyAccount,
  updateMyAccount,
  regenerateMyDisplayName,
  exportMyData,
  deleteMyAccount,
  registerAccount,
  getStoredApiKey,
  type AccountMeResponse,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminPasskeyPanel } from "@/components/AdminPasskeyPanel";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";

export function AccountPage() {
  const queryClient = useQueryClient();
  const apiKey = getStoredApiKey();
  const [showKey, setShowKey] = useState(false);
  const [inGameName, setInGameName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [needsRegister, setNeedsRegister] = useState(false);

  const { data, isLoading, error } = useQuery<AccountMeResponse>({
    queryKey: ["account-me"],
    queryFn: async () => {
      try {
        const result = await getMyAccount();
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.toLowerCase().includes("no account")) {
          setNeedsRegister(true);
          return {
            user: null,
            is_admin: false,
            terms_version_current: "",
            terms_accepted_current: false,
          };
        }
        throw e;
      }
    },
    retry: false,
  });

  const registerMut = useMutation({
    mutationFn: registerAccount,
    onSuccess: () => {
      setNeedsRegister(false);
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
      localStorage.removeItem("api_key");
      window.location.href = "/";
    },
  });

  const user = data?.user ?? null;

  // Sync editable fields when user data loads.
  if (user && inGameName === "" && user.in_game_name) {
    setInGameName(user.in_game_name);
  }

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
            Your API key isn't yet linked to an account. Accept the terms and a random display name
            will be generated for you.
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
              <p className="text-xs text-destructive mt-1">{(regenMut.error as Error).message}</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Regenerated {user.name_regen_count} times. Limited to 3 per day.
            </p>
          </div>
          <Separator />
          <div className="space-y-1">
            <Label htmlFor="ign" className="text-xs text-muted-foreground">
              In-game name (optional)
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
              Used for hire-board matching. Other users may flag duplicates.
            </p>
          </div>
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
              <p className="text-xs text-muted-foreground">
                Show me on the hire board (admins only for now).
              </p>
            </div>
            <Switch
              checked={user.is_hireable}
              onCheckedChange={(v) => updateMut.mutate({ is_hireable: v })}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label>Show on leaderboards</Label>
              <p className="text-xs text-muted-foreground">
                Opt-in to appear on future contributor leaderboards.
              </p>
            </div>
            <Switch
              checked={user.is_leaderboard_visible}
              onCheckedChange={(v) => updateMut.mutate({ is_leaderboard_visible: v })}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label>Show Contributions</Label>
              <p className="text-xs text-muted-foreground">
                Reveal who submitted each contribution on the Contribute page (e.g. "Made by Alex").
                When off, contributors are shown as anonymous. Admins always see the names.
              </p>
            </div>
            <Switch
              checked={user.show_contributions}
              onCheckedChange={(v) => updateMut.mutate({ show_contributions: v })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Appearance</CardTitle>
          <CardDescription>
            Choose how Cairn looks. Auto follows your operating system.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label>Theme</Label>
            <ThemeSwitcher />
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
