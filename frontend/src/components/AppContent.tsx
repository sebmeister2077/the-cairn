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
import { ContributeTLsPage } from "@/pages/ContributeTLsPage";
import { ContributeTradersPage } from "@/pages/ContributeTradersPage";
import { ApiKeysPage } from "@/pages/admin/ApiKeysPage";
import { AdminUsersPage } from "@/pages/admin/AdminUsersPage";
import { AdminBannedIpsPage } from "@/pages/admin/AdminBannedIpsPage";
import { AdminFlagsPage } from "@/pages/admin/AdminFlagsPage";
import { AdminFeatureFlagsPage } from "@/pages/admin/AdminFeatureFlagsPage";
import { AdminMaintenancePage } from "@/pages/admin/AdminMaintenancePage";
import { AdminResourcesPage } from "@/pages/admin/AdminResourcesPage";
import { AdminLandmarksPage } from "@/pages/admin/AdminLandmarksPage";
import { AdminTranslocatorsPage } from "@/pages/admin/AdminTranslocatorsPage";
import { AdminTradersPage } from "@/pages/admin/AdminTradersPage";
import { AdminTLScreenshotsPage } from "@/pages/admin/AdminTLScreenshotsPage";
import { AdminUsagePage } from "@/pages/admin/AdminUsagePage";
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
  getAdminPendingCounts,
  type AccountMeResponse,
  type AdminPendingCounts,
  type DefaultInviteRecord,
} from "@/lib/api";
import { AuthRejectedBanner } from "./AuthRejectedBanner";
import { useEffectWithAbort } from "@/hooks/useEffectWithAbort";
import { useReduxState } from "@/store/hooks";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "./ErrorBoundary";

const BASE_CATEGORIES = [
  { value: "/general", label: "General" },
  { value: "/singleplayer", label: "Singleplayer" },
  { value: "/multiplayer", label: "Multiplayer" },
] as const;

const ADMIN_CATEGORY = { value: "/manage", label: "Manage" } as const;
const USAGE_CATEGORY = { value: "/usage", label: "Usage" } as const;

const NavigationRoutes = {
  Singleplayer: {
    Extract: "/singleplayer/extract",
    Import: "/singleplayer/import",
    Commands: "/singleplayer/commands",
    Delete: "/singleplayer/delete",
  },
  Multiplayer: {
    Identify: "/multiplayer/identify",
    MapViewer: "/multiplayer/map-viewer",
    TOPSMap: "/multiplayer/tops-map",
    ContributeMap: "/multiplayer/contribute-map",
    ContributeTLs: "/multiplayer/contribute-tls",
    ContributeTraders: "/multiplayer/contribute-traders",
  },
  General: {},
  Manage: {
    ApiKeys: "/manage/api-keys",
    Users: "/manage/users",
    BannedIPs: "/manage/banned-ips",
    Flags: "/manage/flags",
    FeatureFlags: "/manage/feature-flags",
    Maintenance: "/manage/maintenance",
    Resources: "/manage/resources",
    WaypointsBackup: "/manage/waypoints-backup",
    Translocators: "/manage/translocators",
    Traders: "/manage/traders",
    TLScreenshots: "/manage/tl-screenshots",
  },
  Usage: {
    Overview: "/usage",
  },
} as const;
type SubTab<V extends any = string> = {
  value: V;
  label: string;
  chip?: string;
  chipShownUntil?: string;
};
type SubtabKey = keyof typeof NavigationRoutes;
type SubtabKeyToValue<K extends SubtabKey> =
  (typeof NavigationRoutes)[K][keyof (typeof NavigationRoutes)[K]];

type Subtabs = {
  [K in SubtabKey as `/${Lowercase<K>}`]: SubTab<SubtabKeyToValue<K>>[];
};
const subTabs: Subtabs = {
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
    { value: "/multiplayer/contribute-map", label: "Contribute Map" },
    {
      value: "/multiplayer/contribute-tls",
      label: "Contribute TLs",
      chip: "New",
      chipShownUntil: "2026-05-23",
    },
    {
      value: "/multiplayer/contribute-traders",
      label: "Contribute Traders",
      chip: "New",
      chipShownUntil: "2026-06-02",
    },
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
    { value: "/manage/waypoints-backup", label: "Waypoints & Backup" },
    { value: "/manage/translocators", label: "Translocators" },
    { value: "/manage/traders", label: "Traders" },
    { value: "/manage/tl-screenshots", label: "TL Screenshots" },
  ],
  "/usage": [],
};

function getActiveCategory(pathname: string): `/${Lowercase<SubtabKey>}` | null {
  for (const cat of [...BASE_CATEGORIES, ADMIN_CATEGORY, USAGE_CATEGORY]) {
    if (pathname.startsWith(cat.value)) return cat.value;
  }
  // Standalone pages like /privacy and /terms intentionally have no
  // active tab. The root path "/" redirects to the TOPS map viewer, so
  // we don't need to special-case it here.
  return null;
}

function shouldShowChip(t: SubTab) {
  if (!t.chip) return false;
  if (!t.chipShownUntil) return true;

  try {
    return new Date(t.chipShownUntil) > new Date();
  } catch {
    return false;
  }
}

/**
 * Map a nav-item path to the number of pending admin items it represents.
 * Top-level category paths aggregate the counts of every sub-tab beneath
 * them so the badge is visible even when the admin hasn't opened the tab.
 */
function getPendingCountFor(value: string, counts: AdminPendingCounts | undefined): number {
  if (!counts) return 0;
  switch (value) {
    case "/multiplayer/contribute-map":
      return counts.map_contributions;
    case "/manage/waypoints-backup":
      return counts.landmark_renames;
    case "/manage/tl-screenshots":
      return counts.translocator_screenshots;
    case "/multiplayer":
      return counts.map_contributions;
    case "/manage":
      return counts.landmark_renames + counts.translocator_screenshots;
    default:
      return 0;
  }
}

function formatPendingCount(n: number): string {
  return n > 9 ? "9+" : String(n);
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

  // Detect "API key set but no account registered yet" so we can nudge the
  // user toward the Account page (otherwise the 403 from /account/me is
  // silent and they have no idea they need to click Account → Register).
  // The queryKey includes the API key so switching keys invalidates the
  // cached answer immediately (otherwise a previously-registered key's
  // successful response would hide the dot for a freshly-pasted new key).
  const apiKey = useReduxState("auth.apiKey");
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
  // Fetch pending admin review counts once when an admin enters the site so
  // the relevant nav items can show a badge ("you have things to review").
  // No polling — staleTime: Infinity means we only refetch on a hard reload
  // or when the API key changes (different admin → different cache key).
  const { data: pendingCounts } = useQuery<AdminPendingCounts>({
    queryKey: ["admin-pending-counts", apiKey ?? ""],
    queryFn: getAdminPendingCounts,
    enabled: !!isAdmin && !!apiKey,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const categories = isAdmin
    ? [...BASE_CATEGORIES, ADMIN_CATEGORY, USAGE_CATEGORY]
    : BASE_CATEGORIES;
  const activeCategory = getActiveCategory(location.pathname);
  const activeSubs = activeCategory ? (subTabs[activeCategory] ?? []) : [];
  const activeSub = activeSubs.find((t) => location.pathname === t.value)?.value ?? "";

  const isTopsPage = activeSub === NavigationRoutes.Multiplayer.TOPSMap;

  useEffect(() => {
    const pagesWithMapAssets = ["/multiplayer/map-viewer", "/multiplayer/tops-map"];
    const isPageWithMapAssets = pagesWithMapAssets.some((p) => location.pathname.startsWith(p));
    if (isPageWithMapAssets) {
      const linkEl = document.createElement("link");
      linkEl.rel = "preconnect";
      linkEl.href = import.meta.env.VITE_ASSETS_BASE_URL;
      document.head.appendChild(linkEl);
      return () => {
        document.head.removeChild(linkEl);
      };
    }
  }, [location.pathname]);

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
  useEffectWithAbort(
    ({ signal }) => {
      if (!inviteClaim || inviteClaim.status !== "pending") return;
      (async () => {
        try {
          const result = await claimInvite(inviteClaim.token);
          if (signal.aborted) return;
          setApiKey(result.key);
          const status = await checkAuthStatus();
          if (signal.aborted) return;
          setStoredIsAdmin(status.is_admin);
          setStoredCanContribute(status.can_contribute);
          setIsAdmin(status.is_admin);
          // Success: silently dismiss the splash. The api-key-change event
          // already updated ``hasApiKey`` so the rest of the UI lights up.
          setInviteClaim(null);
        } catch (e: unknown) {
          if (signal.aborted) return;
          const msg = e instanceof Error ? e.message : "Could not set up access automatically";
          setInviteClaim((prev) => prev && { ...prev, status: "error", error: msg });
        }
      })();
    },
    [inviteClaim],
  );

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b">
        <div className="container mx-auto flex items-center justify-between px-4 py-3">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
            className="flex flex-col items-start gap-1"
          >
            <Logo className="h-10 w-auto" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Unofficial fan project &mdash; not affiliated with Anego Studios
            </span>
          </a>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Badge variant="default" className="bg-amber-500 text-white hover:bg-amber-500">
                Admin
              </Badge>
            )}
            <NavLink to="/general">
              <Button
                variant="ghost"
                size="sm"
                title="What is Cairn? Learn about the project and its tools."
              >
                <span aria-hidden="true" className="mr-1">
                  &#9432;
                </span>
                About
              </Button>
            </NavLink>
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
              {categories.map((c) => {
                const pending = getPendingCountFor(c.value, pendingCounts);
                return (
                  <NavLink key={c.value} to={c.value} end={false}>
                    {() => (
                      <TabsTrigger value={c.value} className="relative">
                        {c.label}
                        {pending > 0 && (
                          <Badge
                            variant="default"
                            aria-label={`${pending} pending review${pending === 1 ? "" : "s"}`}
                            title={`${pending} item${pending === 1 ? "" : "s"} awaiting your review`}
                            className="absolute -top-2 -right-3 h-4 min-w-4 px-1 text-[10px] leading-none bg-red-500 text-white hover:bg-red-500"
                          >
                            {formatPendingCount(pending)}
                          </Badge>
                        )}
                      </TabsTrigger>
                    )}
                  </NavLink>
                );
              })}
            </TabsList>
          </Tabs>
          {activeSubs.length > 0 && (
            <Tabs value={activeSub}>
              <TabsList variant="line">
                {activeSubs.map((t) => {
                  const pending = getPendingCountFor(t.value, pendingCounts);
                  return (
                    <NavLink key={t.value} to={t.value} end>
                      {() => (
                        <TabsTrigger value={t.value} className="relative">
                          {t.label}
                          {shouldShowChip(t) && (
                            <Badge
                              variant="default"
                              className="absolute -top-2 -right-3 h-4 px-1.5 text-[10px] leading-none bg-amber-500 text-white hover:bg-amber-500"
                            >
                              {t.chip}
                            </Badge>
                          )}
                          {pending > 0 && (
                            <Badge
                              variant="default"
                              aria-label={`${pending} pending review${pending === 1 ? "" : "s"}`}
                              title={`${pending} item${pending === 1 ? "" : "s"} awaiting your review`}
                              className="absolute -top-2 -right-3 h-4 min-w-4 px-1 text-[10px] leading-none bg-red-500 text-white hover:bg-red-500"
                            >
                              {formatPendingCount(pending)}
                            </Badge>
                          )}
                        </TabsTrigger>
                      )}
                    </NavLink>
                  );
                })}
              </TabsList>
            </Tabs>
          )}
        </nav>
      </header>
      <main
        className={cn(
          "container mx-auto px-4 py-6 max-w-6xl flex-1 w-full",
          // isTopsPage && "max-w-6xl",
        )}
      >
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
          {/* The vast majority of visitors come for the TOPS map viewer, so
              send them straight there instead of greeting them with the
              project intro. The intro / tool overview is still reachable via
              the "General" tab in the nav. */}
          <Route path="/" element={<Navigate to="/multiplayer/tops-map" replace />} />
          <Route path="/singleplayer" element={<Navigate to="/singleplayer/extract" replace />} />
          <Route
            path="/singleplayer/extract"
            element={
              <ErrorBoundary title="Extract failed" resetKeys={[location.pathname]}>
                <ExtractPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/singleplayer/import"
            element={
              <ErrorBoundary title="Import failed" resetKeys={[location.pathname]}>
                <ImportPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/singleplayer/commands"
            element={
              <ErrorBoundary title="Commands failed" resetKeys={[location.pathname]}>
                <CommandsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/singleplayer/delete"
            element={
              <ErrorBoundary title="Delete failed" resetKeys={[location.pathname]}>
                <DeletePage />
              </ErrorBoundary>
            }
          />
          <Route path="/multiplayer" element={<Navigate to="/multiplayer/identify" replace />} />
          <Route
            path="/multiplayer/identify"
            element={
              <ErrorBoundary title="Identify failed" resetKeys={[location.pathname]}>
                <IdentifyMapsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/multiplayer/map-viewer"
            element={
              <ErrorBoundary title="Map Viewer failed" resetKeys={[location.pathname]}>
                <MapViewPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/multiplayer/tops-map"
            element={
              <ErrorBoundary title="TOPS Map failed" resetKeys={[location.pathname]}>
                <TOPSMapViewPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/multiplayer/contribute"
            element={
              <ErrorBoundary title="Contribute failed" resetKeys={[location.pathname]}>
                <ContributePage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/multiplayer/contribute-map"
            element={
              <ErrorBoundary title="Contribute Map failed" resetKeys={[location.pathname]}>
                <ContributePage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/multiplayer/contribute-tls"
            element={
              <ErrorBoundary title="Contribute TLs failed" resetKeys={[location.pathname]}>
                <ContributeTLsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/multiplayer/contribute-traders"
            element={
              <ErrorBoundary title="Contribute Traders failed" resetKeys={[location.pathname]}>
                <ContributeTradersPage />
              </ErrorBoundary>
            }
          />
          <Route path="/manage" element={<Navigate to="/manage/api-keys" replace />} />
          <Route
            path="/manage/api-keys"
            element={
              <ErrorBoundary title="API Keys failed" resetKeys={[location.pathname]}>
                <ApiKeysPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/users"
            element={
              <ErrorBoundary title="Users failed" resetKeys={[location.pathname]}>
                <AdminUsersPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/banned-ips"
            element={
              <ErrorBoundary title="Banned IPs failed" resetKeys={[location.pathname]}>
                <AdminBannedIpsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/flags"
            element={
              <ErrorBoundary title="Flags failed" resetKeys={[location.pathname]}>
                <AdminFlagsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/feature-flags"
            element={
              <ErrorBoundary title="Feature Flags failed" resetKeys={[location.pathname]}>
                <AdminFeatureFlagsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/maintenance"
            element={
              <ErrorBoundary title="Maintenance failed" resetKeys={[location.pathname]}>
                <AdminMaintenancePage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/resources"
            element={
              <ErrorBoundary title="Resources failed" resetKeys={[location.pathname]}>
                <AdminResourcesPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/waypoints-backup"
            element={
              <ErrorBoundary title="Waypoints failed" resetKeys={[location.pathname]}>
                <AdminLandmarksPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/translocators"
            element={
              <ErrorBoundary title="Translocators failed" resetKeys={[location.pathname]}>
                <AdminTranslocatorsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/traders"
            element={
              <ErrorBoundary title="Traders failed" resetKeys={[location.pathname]}>
                <AdminTradersPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/manage/tl-screenshots"
            element={
              <ErrorBoundary title="TL Screenshots failed" resetKeys={[location.pathname]}>
                <AdminTLScreenshotsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/usage"
            element={
              <ErrorBoundary title="Usage failed" resetKeys={[location.pathname]}>
                <AdminUsagePage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/account"
            element={
              <ErrorBoundary title="Account failed" resetKeys={[location.pathname]}>
                <AccountPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/general"
            element={
              <ErrorBoundary title="General failed" resetKeys={[location.pathname]}>
                <GeneralPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/privacy"
            element={
              <ErrorBoundary title="Privacy failed" resetKeys={[location.pathname]}>
                <PrivacyPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/terms"
            element={
              <ErrorBoundary title="Terms failed" resetKeys={[location.pathname]}>
                <TermsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/blog"
            element={
              <ErrorBoundary title="Blog failed" resetKeys={[location.pathname]}>
                <BlogIndexPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/blog/:slug"
            element={
              <ErrorBoundary title="Blog Post failed" resetKeys={[location.pathname]}>
                <BlogPostPage />
              </ErrorBoundary>
            }
          />
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
