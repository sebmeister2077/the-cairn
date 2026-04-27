import { useState, useEffect } from "react";
import { Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/assets/Logo";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { AdminPasskeyDialog, type PasskeyDialogMode } from "@/components/AdminPasskeyDialog";
import { CookieConsent } from "@/components/CookieConsent";
import { hasAcceptedStorage } from "@/lib/consent";
import { ExtractPage } from "@/pages/ExtractPage";
import { ImportPage } from "@/pages/ImportPage";
import { CommandsPage } from "@/pages/CommandsPage";
import { DeletePage } from "@/pages/DeletePage";
import { IdentifyMapsPage } from "@/pages/IdentifyMapsPage";
import { MapViewPage } from "@/pages/MapViewPage";
import { TOPSMapViewPage } from "@/pages/TOPSMapViewPage";
import { ContributePage } from "@/pages/ContributePage";
import { ApiKeysPage } from "@/pages/ApiKeysPage";
import { AdminUsersPage } from "@/pages/AdminUsersPage";
import { AdminBannedIpsPage } from "@/pages/AdminBannedIpsPage";
import { AdminFlagsPage } from "@/pages/AdminFlagsPage";
import { AccountPage } from "@/pages/AccountPage";
import { PrivacyPage } from "@/pages/PrivacyPage";
import { TermsPage } from "@/pages/TermsPage";
import { GeneralPage } from "@/pages/GeneralPage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getStoredIsAdmin,
  setApiKey,
  checkAuthStatus,
  setStoredIsAdmin,
  setStoredCanContribute,
  getStoredApiKey,
  getAdminSession,
  adminWebauthnStatus,
  claimInvite,
} from "@/lib/api";

const BASE_CATEGORIES = [
  { value: "/general", label: "General" },
  { value: "/singleplayer", label: "Singleplayer" },
  { value: "/multiplayer", label: "Multiplayer" },
];

const ADMIN_CATEGORY = { value: "/manage", label: "Manage" };

const subTabs: Record<string, { value: string; label: string }[]> = {
  "/singleplayer": [
    { value: "/singleplayer/extract", label: "Extract" },
    { value: "/singleplayer/import", label: "Import" },
    { value: "/singleplayer/commands", label: "Commands" },
    { value: "/singleplayer/delete", label: "Delete" },
  ],
  "/multiplayer": [
    { value: "/multiplayer/identify", label: "Identify Maps" },
    { value: "/multiplayer/map-viewer", label: "Local Map Viewer" },
    { value: "/multiplayer/tops-map", label: "TOPS Map Viewer" },
    { value: "/multiplayer/contribute", label: "Contribute" },
  ],
  "/general": [],
  "/manage": [
    { value: "/manage/api-keys", label: "API Keys" },
    { value: "/manage/users", label: "Users" },
    { value: "/manage/banned-ips", label: "Banned IPs" },
    { value: "/manage/flags", label: "Flags" },
  ],
};

function getActiveCategory(pathname: string) {
  for (const cat of [...BASE_CATEGORIES, ADMIN_CATEGORY]) {
    if (pathname.startsWith(cat.value)) return cat.value;
  }
  // Root path (/) defaults to General. Standalone pages like /privacy and
  // /terms intentionally have no active tab.
  if (pathname === "/") return "/general";
  return "";
}

export function AppContent() {
  const [keyOpen, setKeyOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(getStoredIsAdmin);
  const [passkeyDialog, setPasskeyDialog] = useState<{
    mode: PasskeyDialogMode;
    required: boolean;
  } | null>(null);
  const location = useLocation();
  const [inviteClaim, setInviteClaim] = useState<{
    token: string;
    status: "idle" | "pending" | "success" | "error";
    error?: string;
    key?: string;
  } | null>(null);
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);

  // On boot (or after a hot reload) if we already think we're admin but have
  // no live X-Admin-Session token, ask the user to verify their passkey.
  // This covers: page reload, opening a new tab, or session TTL expiry.
  useEffect(() => {
    if (!isAdmin) return;
    if (getAdminSession()) return;
    let cancelled = false;
    (async () => {
      try {
        const wa = await adminWebauthnStatus();
        if (cancelled) return;
        if (wa.configured && wa.enrolled) {
          setPasskeyDialog({ mode: "assert", required: true });
        }
      } catch {
        // server doesn't have webauthn configured — leave admin un-gated
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const keyParam = params.get("key");
    if (keyParam) {
      // Don't write the key to localStorage until the user has consented to
      // browser storage. If consent isn't given yet, treat the key as an
      // invite-style claim that's gated behind the consent banner.
      if (hasAcceptedStorage()) {
        setApiKey(keyParam.trim());
        checkAuthStatus().then((status) => {
          setStoredIsAdmin(status.is_admin);
          setStoredCanContribute(status.can_contribute);
          setIsAdmin(status.is_admin);
        });
      } else {
        // Stash the raw key in memory until consent is granted.
        sessionStorage.setItem("pending_api_key", keyParam.trim());
      }
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    const inviteParam = params.get("invite");
    if (inviteParam) {
      window.history.replaceState({}, "", window.location.pathname);
      // Only show the claim prompt if the user does not already have an API key
      if (!getStoredApiKey()) {
        if (hasAcceptedStorage()) {
          setInviteClaim({ token: inviteParam, status: "idle" });
        } else {
          // Defer until consent is granted.
          setPendingInviteToken(inviteParam);
        }
      }
    }
  }, []);

  function handleConsentChange(value: "accepted" | "declined") {
    if (value !== "accepted") {
      setPendingInviteToken(null);
      sessionStorage.removeItem("pending_api_key");
      return;
    }
    // Apply any deferred direct API key first.
    const deferredKey = sessionStorage.getItem("pending_api_key");
    if (deferredKey) {
      sessionStorage.removeItem("pending_api_key");
      setApiKey(deferredKey);
      checkAuthStatus().then((status) => {
        setStoredIsAdmin(status.is_admin);
        setStoredCanContribute(status.can_contribute);
        setIsAdmin(status.is_admin);
      });
    }
    if (pendingInviteToken) {
      setInviteClaim({ token: pendingInviteToken, status: "idle" });
      setPendingInviteToken(null);
    }
  }

  async function handleClaimInvite() {
    if (!inviteClaim) return;
    setInviteClaim((prev) => prev && { ...prev, status: "pending" });
    try {
      const result = await claimInvite(inviteClaim.token);
      setApiKey(result.key);
      const status = await checkAuthStatus();
      setStoredIsAdmin(status.is_admin);
      setStoredCanContribute(status.can_contribute);
      setIsAdmin(status.is_admin);
      setInviteClaim((prev) => prev && { ...prev, status: "success", key: result.key });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to claim invite";
      setInviteClaim((prev) => prev && { ...prev, status: "error", error: msg });
    }
  }

  const categories = isAdmin ? [...BASE_CATEGORIES, ADMIN_CATEGORY] : BASE_CATEGORIES;
  const activeCategory = getActiveCategory(location.pathname);
  const activeSubs = subTabs[activeCategory] ?? [];
  const activeSub = activeSubs.find((t) => location.pathname === t.value)?.value ?? "";

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b">
        <div className="container mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex flex-col items-start gap-1">
            <Logo className="h-10 w-auto" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Unofficial fan project &mdash; not affiliated with Anego Studios
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Badge variant="default" className="bg-amber-500 text-white hover:bg-amber-500">
                Admin
              </Badge>
            )}
            <NavLink to="/account">
              <Button variant="ghost" size="sm">
                Account
              </Button>
            </NavLink>
            <Button variant="ghost" size="sm" onClick={() => setKeyOpen(true)}>
              API Key
            </Button>
          </div>
        </div>
        <nav className="container mx-auto px-4 pb-2 flex flex-col gap-1">
          <Tabs value={activeCategory}>
            <TabsList>
              {categories.map((c) => (
                <NavLink key={c.value} to={c.value} end={false}>
                  {() => <TabsTrigger value={c.value}>{c.label}</TabsTrigger>}
                </NavLink>
              ))}
            </TabsList>
          </Tabs>
          {activeSubs.length > 0 && (
            <Tabs value={activeSub}>
              <TabsList variant="line">
                {activeSubs.map((t) => (
                  <NavLink key={t.value} to={t.value} end>
                    {() => <TabsTrigger value={t.value}>{t.label}</TabsTrigger>}
                  </NavLink>
                ))}
              </TabsList>
            </Tabs>
          )}
        </nav>
      </header>
      <main className="container mx-auto px-4 py-6 max-w-3xl flex-1 w-full">
        <Routes>
          <Route path="/" element={<GeneralPage />} />
          <Route path="/singleplayer" element={<Navigate to="/singleplayer/extract" replace />} />
          <Route path="/singleplayer/extract" element={<ExtractPage />} />
          <Route path="/singleplayer/import" element={<ImportPage />} />
          <Route path="/singleplayer/commands" element={<CommandsPage />} />
          <Route path="/singleplayer/delete" element={<DeletePage />} />
          <Route path="/multiplayer" element={<Navigate to="/multiplayer/identify" replace />} />
          <Route path="/multiplayer/identify" element={<IdentifyMapsPage />} />
          <Route path="/multiplayer/map-viewer" element={<MapViewPage />} />
          <Route path="/multiplayer/tops-map" element={<TOPSMapViewPage />} />
          <Route path="/multiplayer/contribute" element={<ContributePage />} />
          <Route path="/manage" element={<Navigate to="/manage/api-keys" replace />} />
          <Route path="/manage/api-keys" element={<ApiKeysPage />} />
          <Route path="/manage/users" element={<AdminUsersPage />} />
          <Route path="/manage/banned-ips" element={<AdminBannedIpsPage />} />
          <Route path="/manage/flags" element={<AdminFlagsPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/general" element={<GeneralPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
        </Routes>
      </main>
      <footer className="border-t mt-8">
        <div className="container mx-auto px-4 py-4 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
          <span>Cairn &mdash; unofficial fan project.</span>
          <span className="flex gap-3">
            <NavLink
              to="/privacy"
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              Privacy
            </NavLink>
            <NavLink
              to="/terms"
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              Terms
            </NavLink>
          </span>
        </div>
      </footer>
      <ApiKeyDialog
        open={keyOpen}
        onClose={() => setKeyOpen(false)}
        onAdminStatusChange={setIsAdmin}
        onAdminPasskeyNeeded={(mode) => setPasskeyDialog({ mode, required: mode === "assert" })}
      />

      {passkeyDialog && (
        <AdminPasskeyDialog
          open={true}
          mode={passkeyDialog.mode}
          required={passkeyDialog.required}
          onClose={() => setPasskeyDialog(null)}
          onSuccess={() => setPasskeyDialog(null)}
        />
      )}

      {/* Cookie / browser-storage consent. Renders as a blocking modal when an
          invite link is waiting to be claimed, otherwise as a dismissible
          bottom banner. The component returns null once a choice is stored. */}
      <CookieConsent blocking={pendingInviteToken !== null} onChange={handleConsentChange} />

      {/* Invite claim dialog */}
      {inviteClaim && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Claim Your API Key</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {inviteClaim.status === "idle" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    You were invited to use this service. Click below to receive your personal API
                    key.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setInviteClaim(null)}
                      className="flex-1"
                    >
                      Dismiss
                    </Button>
                    <Button onClick={handleClaimInvite} className="flex-1">
                      Claim Key
                    </Button>
                  </div>
                </>
              )}
              {inviteClaim.status === "pending" && (
                <p className="text-sm text-muted-foreground text-center py-2">Claiming…</p>
              )}
              {inviteClaim.status === "success" && (
                <>
                  <p className="text-sm text-emerald-600 font-medium">
                    Your API key has been activated!
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Your key is now saved in this browser. You can start using the service.
                  </p>
                  <Button onClick={() => setInviteClaim(null)} className="w-full">
                    Continue
                  </Button>
                </>
              )}
              {inviteClaim.status === "error" && (
                <>
                  <p className="text-sm text-destructive">{inviteClaim.error}</p>
                  <Button variant="outline" onClick={() => setInviteClaim(null)} className="w-full">
                    Close
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
