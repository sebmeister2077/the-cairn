import { useState, useEffect } from "react";
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/assets/Logo";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { AdminPasskeyDialog, type PasskeyDialogMode } from "@/components/AdminPasskeyDialog";
import { CookieConsent } from "@/components/CookieConsent";
import { hasAcceptedStorage, clearStoredConsent } from "@/lib/consent";
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
import { AdminFeatureFlagsPage } from "@/pages/AdminFeatureFlagsPage";
import { AdminMaintenancePage } from "@/pages/AdminMaintenancePage";
import { AccountPage } from "@/pages/AccountPage";
import { PrivacyPage } from "@/pages/PrivacyPage";
import { TermsPage } from "@/pages/TermsPage";
import { GeneralPage } from "@/pages/GeneralPage";
import { BlogIndexPage } from "@/pages/blog/BlogIndexPage";
import { BlogPostPage } from "@/pages/blog/BlogPostPage";
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
  getDefaultPublicInvite,
  getMyAccountSafe,
  type AccountMeResponse,
  type DefaultInviteRecord,
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
    { value: "/manage/feature-flags", label: "Feature Flags" },
    { value: "/manage/maintenance", label: "Maintenance" },
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
  const navigate = useNavigate();
  const [inviteClaim, setInviteClaim] = useState<{
    token: string;
    status: "idle" | "pending" | "success" | "error";
    error?: string;
    key?: string;
  } | null>(null);
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);
  // Default-public invite discovered from the backend, shown as a friendly
  // dismissible banner to first-time visitors who land on the site without
  // an invite URL or saved API key (and have accepted browser-storage).
  const [defaultInvite, setDefaultInvite] = useState<DefaultInviteRecord | null>(null);
  const [defaultInviteDismissed, setDefaultInviteDismissed] = useState(false);
  // Reactive mirror of the consent flag so the discovery effect re-runs the
  // moment the user clicks Accept (rather than only on the next reload).
  const [storageConsented, setStorageConsented] = useState(hasAcceptedStorage);
  // Reactive mirror of "is an API key currently stored?" so the welcome
  // banner disappears the moment the user pastes one in (in this tab).
  const [hasApiKey, setHasApiKey] = useState(() => !!getStoredApiKey());
  // Captured snapshot of "why was the user kicked out" so we can render a
  // friendly banner after the global ``auth-rejected`` event fires. Cleared
  // when the user dismisses the banner or claims a new key.
  const [authRejected, setAuthRejected] = useState<
    { kind: "had-key" } | { kind: "no-key-no-consent" } | { kind: "no-key" } | null
  >(null);

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
      setDefaultInvite(null);
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

  // Discover the default-public invite once consent is accepted and the
  // visitor has no saved API key + no other invite flow in progress. The
  // backend returns 404 when no link is configured, in which case we render
  // nothing.
  useEffect(() => {
    if (defaultInviteDismissed) return;
    if (!storageConsented) return;
    if (hasApiKey) {
      // A key was just saved — make sure no stale banner remains.
      setDefaultInvite(null);
      return;
    }
    if (inviteClaim || pendingInviteToken) return;
    let cancelled = false;
    getDefaultPublicInvite()
      .then((rec) => {
        if (!cancelled) setDefaultInvite(rec);
      })
      .catch(() => {
        // Network errors / DB unavailable: silently skip the banner.
      });
    return () => {
      cancelled = true;
    };
    // Re-evaluate when the invite-claim modal closes (success/dismiss), when
    // consent flips, or when the stored API key appears/disappears.
  }, [inviteClaim, pendingInviteToken, defaultInviteDismissed, storageConsented, hasApiKey]);

  // When consent is granted via the cookie banner, re-trigger the discovery
  // effect above by listening to the same custom event other components use.
  useEffect(() => {
    function onConsent() {
      setStorageConsented(hasAcceptedStorage());
    }
    window.addEventListener("storage-consent-change", onConsent);
    return () => window.removeEventListener("storage-consent-change", onConsent);
  }, []);

  // Track API key changes (saved via the dialog, claimed via invite, pasted
  // from a ``?key=`` URL, or written by another tab). Covers both our own
  // ``api-key-change`` custom event (same tab) and the native ``storage``
  // event (cross-tab).
  useEffect(() => {
    function syncFromStorage() {
      setHasApiKey(!!getStoredApiKey());
    }
    window.addEventListener("api-key-change", syncFromStorage);
    window.addEventListener("storage", syncFromStorage);
    return () => {
      window.removeEventListener("api-key-change", syncFromStorage);
      window.removeEventListener("storage", syncFromStorage);
    };
  }, []);

  // Listen for the global ``auth-rejected`` event fired by api.ts on a 401
  // response. We snapshot the user's situation (has a stored key? has
  // accepted browser storage?) so we can render a contextual banner that
  // tells them what to do next. We also navigate back to the home page via
  // react-router (instead of the previous full-page reload) so the banner
  // survives the redirect.
  useEffect(() => {
    function onAuthRejected() {
      const hadKey = !!getStoredApiKey();
      const consented = hasAcceptedStorage();
      // 401 means the backend rejected this key. Drop the cached
      // admin/contributor flags so the UI no longer thinks we're admin.
      setIsAdmin(false);
      setStoredIsAdmin(false);
      setStoredCanContribute(false);
      if (hadKey) {
        setAuthRejected({ kind: "had-key" });
      } else if (!consented) {
        setAuthRejected({ kind: "no-key-no-consent" });
      } else {
        setAuthRejected({ kind: "no-key" });
      }
      if (window.location.pathname !== "/") {
        navigate("/", { replace: true });
      }
    }
    window.addEventListener("auth-rejected", onAuthRejected);
    return () => window.removeEventListener("auth-rejected", onAuthRejected);
  }, [navigate]);

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

  // Detect "API key set but no account registered yet" so we can nudge the
  // user toward the Account page (otherwise the 403 from /account/me is
  // silent and they have no idea they need to click Account → Register).
  // The queryKey includes the API key so switching keys invalidates the
  // cached answer immediately (otherwise a previously-registered key's
  // successful response would hide the dot for a freshly-pasted new key).
  const apiKey = getStoredApiKey();
  const { data: accountData } = useQuery<AccountMeResponse>({
    queryKey: ["account-me", apiKey ?? ""],
    queryFn: getMyAccountSafe,
    enabled: !!apiKey,
    retry: false,
    // Always refetch on mount / focus so the indicator reflects reality
    // even if a stale entry was rehydrated from the persisted cache.
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
  const needsRegister = !!apiKey && accountData?.user === null && !accountData?.is_admin;

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
              <Button variant="ghost" size="sm" className="relative">
                Account
                {needsRegister && (
                  <span
                    aria-label="Account setup required"
                    title="Finish setting up your account"
                    className="absolute -top-0.5 -right-0.5 flex size-2.5"
                  >
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-amber-500 ring-2 ring-background" />
                  </span>
                )}
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
        {authRejected && (
          <AuthRejectedBanner
            kind={authRejected.kind}
            hasDefaultInvite={!!defaultInvite}
            onDismiss={() => setAuthRejected(null)}
            onClaim={() => {
              if (defaultInvite) {
                setInviteClaim({ token: defaultInvite.token, status: "idle" });
                setDefaultInvite(null);
              }
              setAuthRejected(null);
            }}
            onOpenApiKey={() => {
              setAuthRejected(null);
              setKeyOpen(true);
            }}
            onReopenConsent={() => {
              clearStoredConsent();
              setStorageConsented(false);
              setAuthRejected(null);
            }}
          />
        )}
        {defaultInvite && !inviteClaim && !authRejected && !hasApiKey && (
          <Card className="mb-4 border-sky-300 bg-sky-50/60 dark:bg-sky-950/30">
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="font-medium text-foreground">Welcome to Cairn 👋</p>
                <p className="text-sm text-muted-foreground">
                  You don't have an API key yet. Claim a free one to start using the multiplayer map
                  tools — no sign-up form, no email required.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDefaultInvite(null);
                    setDefaultInviteDismissed(true);
                  }}
                >
                  Not now
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setInviteClaim({ token: defaultInvite.token, status: "idle" });
                    setDefaultInvite(null);
                  }}
                >
                  Claim a key
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
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
          <Route path="/manage/feature-flags" element={<AdminFeatureFlagsPage />} />
          <Route path="/manage/maintenance" element={<AdminMaintenancePage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/general" element={<GeneralPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/blog" element={<BlogIndexPage />} />
          <Route path="/blog/:slug" element={<BlogPostPage />} />
        </Routes>
      </main>
      <footer className="border-t mt-8">
        <div className="container mx-auto px-4 py-4 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
          <span>Cairn &mdash; unofficial fan project.</span>
          <span className="flex gap-3">
            <NavLink
              to="/blog"
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              Blog
            </NavLink>
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
            <button
              type="button"
              onClick={() => {
                clearStoredConsent();
                setStorageConsented(false);
              }}
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              Cookie settings
            </button>
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

function AuthRejectedBanner({
  kind,
  hasDefaultInvite,
  onDismiss,
  onClaim,
  onOpenApiKey,
  onReopenConsent,
}: {
  kind: "had-key" | "no-key" | "no-key-no-consent";
  hasDefaultInvite: boolean;
  onDismiss: () => void;
  onClaim: () => void;
  onOpenApiKey: () => void;
  onReopenConsent: () => void;
}) {
  let title: string;
  let body: string;
  let primary: { label: string; onClick: () => void } | null = null;

  if (kind === "had-key") {
    title = "Your access has been restricted";
    body =
      "The server rejected your API key. It may have been revoked or temporarily disabled by an admin, or your account may have been removed. You can paste a different key, or contact an administrator if you think this is a mistake.";
    primary = { label: "Use a different key", onClick: onOpenApiKey };
  } else if (kind === "no-key-no-consent") {
    title = "You need an API key to continue";
    body =
      "To use this service you'll need an API key, which means we have to store a small amount of data in your browser. Click below to review the cookie prompt again and accept storage so you can claim a free key.";
    primary = { label: "Review cookie prompt", onClick: onReopenConsent };
  } else {
    title = "You need an API key to continue";
    body = hasDefaultInvite
      ? "Your previous session was rejected. You can claim a free key now to keep going — no sign-up form, no email required."
      : "Your previous session was rejected. Paste an API key to continue, or ask an admin for an invite link.";
    primary = hasDefaultInvite
      ? { label: "Claim a key", onClick: onClaim }
      : { label: "Enter an API key", onClick: onOpenApiKey };
  }

  return (
    <Card className="mb-4 border-amber-300 bg-amber-50/70 dark:bg-amber-950/30">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="font-medium text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          {primary && (
            <Button size="sm" onClick={primary.onClick}>
              {primary.label}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
