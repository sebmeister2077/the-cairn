import { useState, useEffect } from "react";
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/assets/Logo";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { AdminPasskeyDialog, type PasskeyDialogMode } from "@/components/AdminPasskeyDialog";
import { ContactDialog, useContactDialog } from "@/components/ContactDialog";
import { ExtractPage } from "@/pages/ExtractPage";
import { ImportPage } from "@/pages/ImportPage";
import { CommandsPage } from "@/pages/CommandsPage";
import { DeletePage } from "@/pages/DeletePage";
import { IdentifyMapsPage } from "@/pages/IdentifyMapsPage";
import { MapViewPage } from "@/pages/MapViewPage";
import { TOPSMapViewPage } from "@/pages/TOPSMapViewPage";
import { ContributePage } from "@/pages/ContributePage";
import { ApiKeysPage } from "@/pages/admin/ApiKeysPage";
import { AdminUsersPage } from "@/pages/admin/AdminUsersPage";
import { AdminBannedIpsPage } from "@/pages/admin/AdminBannedIpsPage";
import { AdminFlagsPage } from "@/pages/admin/AdminFlagsPage";
import { AdminFeatureFlagsPage } from "@/pages/admin/AdminFeatureFlagsPage";
import { AdminMaintenancePage } from "@/pages/admin/AdminMaintenancePage";
import { AdminResourcesPage } from "@/pages/admin/AdminResourcesPage";
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
import { AuthRejectedBanner } from "./AuthRejectedBanner";
import { useEffectWithAbort } from "@/hooks/useEffectWithAbort";

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
    { value: "/manage/resources", label: "Resources" },
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
  // Tracks the auto-claim splash. Shown briefly on first visit while we
  // fetch a free key from the public default invite. The dialog is
  // non-interactive — it appears, runs, and disappears on success.
  const [inviteClaim, setInviteClaim] = useState<{
    token: string;
    status: "pending" | "error";
    error?: string;
  } | null>(null);
  // Default-public invite discovered from the backend. Used to auto-claim
  // a key for any visitor without one. Kept in state only to gate the
  // "no invite available, contact admin" fallback notice.
  const [defaultInvite, setDefaultInvite] = useState<DefaultInviteRecord | null | undefined>(
    undefined,
  );
  const contact = useContactDialog();
  // Reactive mirror of "is an API key currently stored?" so banners and
  // the auto-claim effect re-evaluate the moment a key is saved.
  const [hasApiKey, setHasApiKey] = useState(() => !!getStoredApiKey());
  // Captured snapshot of "why was the user kicked out" so we can render a
  // friendly banner after the global ``auth-rejected`` event fires.
  const [authRejected, setAuthRejected] = useState<{ kind: "had-key" } | { kind: "no-key" } | null>(
    null,
  );

  // On boot (or after a hot reload) if we already think we're admin but have
  // no live X-Admin-Session token, ask the user to verify their passkey.
  // This covers: page reload, opening a new tab, or session TTL expiry.
  useEffectWithAbort(
    ({ signal }) => {
      if (!isAdmin) return;
      if (getAdminSession()) return;
      (async () => {
        try {
          const wa = await adminWebauthnStatus();
          if (signal.aborted) return;
          if (wa.configured && wa.enrolled) {
            setPasskeyDialog({ mode: "assert", required: true });
          }
        } catch {
          // server doesn't have webauthn configured — leave admin un-gated
        }
      })();
    },
    [isAdmin],
  );

  // Apply any ``?key=`` or ``?invite=`` URL parameters on first load.
  // Both flows write to localStorage immediately — the API key is treated
  // as strictly necessary for the service to function, so no consent gate.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const keyParam = params.get("key");
    if (keyParam) {
      setApiKey(keyParam.trim());
      checkAuthStatus().then((status) => {
        setStoredIsAdmin(status.is_admin);
        setStoredCanContribute(status.can_contribute);
        setIsAdmin(status.is_admin);
      });
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    const inviteParam = params.get("invite");
    if (inviteParam) {
      window.history.replaceState({}, "", window.location.pathname);
      if (!getStoredApiKey()) {
        setInviteClaim({ token: inviteParam, status: "pending" });
      }
    }
  }, []);

  // Auto-claim flow: any visitor without a stored key gets one assigned
  // automatically from the public default invite link. If no public invite
  // is configured the fallback notice is rendered later in the JSX.
  useEffectWithAbort(
    ({ ifNotAbortedThen, signal }) => {
      if (hasApiKey) {
        // Already provisioned — clear any stale discovery result.
        setDefaultInvite(null);
        return;
      }
      if (inviteClaim) return;
      if (authRejected) return; // user is banned/revoked — do NOT silently re-issue
      getDefaultPublicInvite()
        .then(
          ifNotAbortedThen((invite) => {
            setDefaultInvite(invite);
            if (invite && !signal.aborted) {
              setInviteClaim({ token: invite.token, status: "pending" });
            }
          }),
        )
        .catch(() => {
          if (!signal.aborted) setDefaultInvite(null);
        });
    },
    [hasApiKey, inviteClaim, authRejected],
  );

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
      // 401 means the backend rejected this key. Drop the cached
      // admin/contributor flags so the UI no longer thinks we're admin.
      setIsAdmin(false);
      setStoredIsAdmin(false);
      setStoredCanContribute(false);
      // Only surface the banner if the user actually had a key that got
      // rejected (revoked / banned / account deleted). Anonymous visitors
      // get a 401 simply because they have no key yet — that's the normal
      // first-load state and the auto-claim flow (or the "no public invite"
      // fallback notice) will handle it without scaring them.
      if (hadKey) {
        setAuthRejected({ kind: "had-key" });
      }
      // if (window.location.pathname !== "/") {
      //   navigate("/", { replace: true });
      // }
    }
    window.addEventListener("auth-rejected", onAuthRejected);
    return () => window.removeEventListener("auth-rejected", onAuthRejected);
  }, [navigate]);

  // Auto-claim whenever a pending invite enters the state machine. The
  // dialog is purely informational — there is no "Claim" button anymore.
  useEffect(() => {
    if (!inviteClaim || inviteClaim.status !== "pending") return;
    let cancelled = false;
    (async () => {
      try {
        const result = await claimInvite(inviteClaim.token);
        if (cancelled) return;
        setApiKey(result.key);
        const status = await checkAuthStatus();
        if (cancelled) return;
        setStoredIsAdmin(status.is_admin);
        setStoredCanContribute(status.can_contribute);
        setIsAdmin(status.is_admin);
        // Success: silently dismiss the splash. The api-key-change event
        // already updated ``hasApiKey`` so the rest of the UI lights up.
        setInviteClaim(null);
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Could not set up access automatically";
        setInviteClaim((prev) => prev && { ...prev, status: "error", error: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteClaim]);

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
            onDismiss={() => setAuthRejected(null)}
            onOpenApiKey={() => {
              setAuthRejected(null);
              setKeyOpen(true);
            }}
          />
        )}
        {/* Fallback notice when no public invite link is configured and the
            visitor has no key. Auto-claim cannot run; an admin must hand out
            an invite link or paste a key directly via the API Key dialog. */}
        {!hasApiKey && !inviteClaim && !authRejected && defaultInvite === null && (
          <Card className="mb-4 border-amber-300 bg-amber-50/70 dark:bg-amber-950/30">
            <CardContent className="p-4 space-y-1">
              <p className="font-medium text-foreground">Access not available</p>
              <p className="text-sm text-muted-foreground">
                Automatic sign-up is currently disabled. Please contact an administrator for an
                invite link, or paste an existing access key via the &ldquo;API Key&rdquo; button at
                the top right.
              </p>
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
          <Route path="/manage/resources" element={<AdminResourcesPage />} />
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
              onClick={contact.openDialog}
              className="hover:text-foreground underline-offset-2 hover:underline cursor-pointer"
            >
              Contact
            </button>
          </span>
        </div>
      </footer>
      <ContactDialog open={contact.open} onClose={contact.closeDialog} />
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

      {/* Auto-claim splash. Non-interactive: appears while we silently fetch
          a free key for first-time visitors and auto-dismisses on success.
          Only the error state offers a button (to close the splash). */}
      {inviteClaim && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>
                {inviteClaim.status === "error" ? "Setup failed" : "Setting up…"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {inviteClaim.status === "pending" && (
                <p className="text-sm text-muted-foreground text-center py-2">
                  One moment while we get you ready…
                </p>
              )}
              {inviteClaim.status === "error" && (
                <>
                  <p className="text-sm text-destructive">{inviteClaim.error}</p>
                  <p className="text-xs text-muted-foreground">
                    Please try refreshing the page, or contact an administrator if the problem
                    persists.
                  </p>
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
