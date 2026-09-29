import { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Copy,
  Check,
  Loader2,
  ChevronDown,
  ChevronRight,
  KeyRound,
  ExternalLink,
  Package,
  Search,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  adminGetProgramBuilds,
  adminListProgramBuilds,
  adminGetProgramVersionGate,
  adminSetProgramVersionGate,
  adminCreateProgramDownloadLink,
  adminListProgramDownloadLinks,
  adminListProgramDownloadRedemptions,
  adminListLicenseAttempts,
  adminRevokeProgramDownloadLink,
  programDownloadPageUrl,
  type ProgramBuild,
  type ProgramDownloadLink,
  type ProgramDownloadRedemption,
  type LicenseAttempt,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useDebounced } from "@/hooks/useDebounced";
import { InfiniteScrollSentinel } from "@/components/InfiniteScrollSentinel";

const PAGE_SIZE = 25;

type Page<T> = { items: T[]; total: number; next_offset: number | null };

// Presets for the "machines bound" filter. Values map to the min/max query params.
const MACHINE_FILTER_OPTIONS: {
  value: string;
  label: string;
  min?: number;
  max?: number;
}[] = [
  { value: "any", label: "Any machines" },
  { value: "unused", label: "Unused (0)", max: 0 },
  { value: "1plus", label: "1+ machines", min: 1 },
  { value: "2plus", label: "2+ machines", min: 2 },
  { value: "3plus", label: "3+ machines", min: 3 },
];

const STATUS_FILTER_OPTIONS: {
  value: string;
  label: string;
}[] = [
  { value: "any", label: "Any status" },
  { value: "active", label: "Active" },
  { value: "revoked", label: "Revoked" },
  { value: "expired", label: "Expired" },
];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

const PLATFORMS: { id: string; label: string }[] = [
  { id: "win-x64", label: "Windows (x64)" },
  { id: "linux-x64", label: "Linux (x64)" },
];

function CurrentBuildsCard() {
  const [showHistory, setShowHistory] = useState(false);
  const builds = useQuery({
    queryKey: ["admin-program-builds"],
    queryFn: adminGetProgramBuilds,
  });
  const history = useQuery({
    queryKey: ["admin-program-build-history"],
    queryFn: () => adminListProgramBuilds({ limit: 30 }),
    enabled: showHistory,
  });

  const byPlatform = builds.data?.builds ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="size-4" /> Current builds
        </CardTitle>
        <CardDescription>
          Builds are published automatically by <code>deploy/publish.ps1</code> — there is no
          manual upload. Each platform keeps one current build; superseded binaries are purged from
          storage while their version history (below) is kept for auditing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {builds.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PLATFORMS.map((p) => {
              const b = byPlatform[p.id] ?? null;
              return (
                <div key={p.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{p.label}</span>
                    {b?.version_label && <Badge variant="secondary">{b.version_label}</Badge>}
                    {b ? (
                      <Badge variant="outline">{fmtBytes(b.size_bytes)}</Badge>
                    ) : (
                      <Badge variant="destructive">not published</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {b ? `published ${fmtDate(b.uploaded_at)}` : "no build yet"}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowHistory((v) => !v)}
        >
          {showHistory ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          Version history
        </button>
        {showHistory && (
          <div className="space-y-1.5">
            {history.isLoading ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading history…
              </div>
            ) : (history.data?.builds ?? []).length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No builds yet.</p>
            ) : (
              (history.data?.builds ?? []).map((b: ProgramBuild) => (
                <div key={b.id} className="rounded-md border px-3 py-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="flex items-center gap-2">
                      <Badge variant="outline">{b.platform}</Badge>
                      {b.version_label && <span className="font-medium">{b.version_label}</span>}
                      {b.is_current && <Badge variant="secondary">current</Badge>}
                      {b.r2_deleted && !b.is_current && (
                        <span className="text-muted-foreground">purged</span>
                      )}
                    </span>
                    <span className="text-muted-foreground">{fmtBytes(b.size_bytes)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 flex-wrap text-muted-foreground">
                    <span>{fmtDate(b.uploaded_at)}</span>
                    {b.sha256 && (
                      <span className="font-mono break-all">
                        sha256 {b.sha256.slice(0, 16)}…
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function VersionGateCard() {
  const queryClient = useQueryClient();
  const gate = useQuery({
    queryKey: ["admin-program-version-gate"],
    queryFn: adminGetProgramVersionGate,
  });

  // Local edit state overlays the loaded values; null means "not yet edited".
  const [minVersion, setMinVersion] = useState<string | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  const data = gate.data;
  const minV = minVersion ?? data?.min_supported_version ?? "";
  const blockedM = blockedMessage ?? data?.blocked_message ?? "";
  const updateM = updateMessage ?? data?.update_message ?? "";

  const saveMut = useMutation({
    mutationFn: () =>
      adminSetProgramVersionGate({
        min_supported_version: minV.trim() || null,
        blocked_message: blockedM.trim() || null,
        update_message: updateM.trim() || null,
      }),
    onSuccess: (fresh) => {
      queryClient.setQueryData(["admin-program-version-gate"], fresh);
      setMinVersion(null);
      setBlockedMessage(null);
      setUpdateMessage(null);
    },
  });

  const textareaClass =
    "w-full min-h-[56px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4" /> Version gate
        </CardTitle>
        <CardDescription>
          Block outdated clients and message users without touching their licenses. Clients strictly
          below the minimum version refuse to start; the update prompt and download URL are derived
          automatically from the latest published build per platform.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {gate.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="gate-min">Minimum supported version</Label>
              <Input
                id="gate-min"
                value={minV}
                onChange={(e) => setMinVersion(e.target.value)}
                placeholder="e.g. 1.2.7 (blank = no block)"
              />
              <p className="text-xs text-muted-foreground">
                Clients below this version are blocked from running. Leave blank to allow all
                versions.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="gate-blocked">Blocked message</Label>
              <textarea
                id="gate-blocked"
                className={textareaClass}
                value={blockedM}
                onChange={(e) => setBlockedMessage(e.target.value)}
                placeholder="Shown to blocked users, e.g. “This version is retired, please update.”"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gate-update">Update prompt message</Label>
              <textarea
                id="gate-update"
                className={textareaClass}
                value={updateM}
                onChange={(e) => setUpdateMessage(e.target.value)}
                placeholder="Optional note shown when an update is offered."
              />
            </div>

            <div className="rounded-md border px-3 py-2 text-xs">
              <div className="mb-1 font-medium text-muted-foreground">
                Auto update targets (from latest builds)
              </div>
              {PLATFORMS.map((p) => {
                const l = data?.latest?.[p.id] ?? null;
                return (
                  <div key={p.id} className="flex items-center justify-between gap-2 py-0.5">
                    <span>{p.label}</span>
                    {l ? (
                      <Badge variant="secondary">{l.version_label || "—"}</Badge>
                    ) : (
                      <span className="text-muted-foreground">none</span>
                    )}
                  </div>
                );
              })}
            </div>

            {saveMut.isError && (
              <p className="text-sm text-destructive">{(saveMut.error as Error).message}</p>
            )}
            <div className="flex items-center gap-2">
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                {saveMut.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                {saveMut.isPending ? "Saving…" : "Save version gate"}
              </Button>
              {saveMut.isSuccess && !saveMut.isPending && (
                <span className="text-xs text-muted-foreground">Saved.</span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RedemptionsPanel({ linkId }: { linkId: number }) {
  const redemptions = useQuery({
    queryKey: ["admin-program-redemptions", linkId],
    queryFn: () => adminListProgramDownloadRedemptions(linkId),
  });

  if (redemptions.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading downloads…
      </div>
    );
  }

  const items = redemptions.data?.redemptions ?? [];
  if (items.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">No downloads yet.</p>;
  }

  return (
    <div className="space-y-1.5 py-1">
      {items.map((r: ProgramDownloadRedemption) => (
        <div key={r.id} className="rounded-md border px-3 py-1.5 text-xs">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-muted-foreground">{fmtDate(r.redeemed_at)}</span>
            <span className="flex items-center gap-2">
              {r.success ? (
                <Badge variant="secondary">ok</Badge>
              ) : (
                <Badge variant="destructive">{r.failure_reason || "failed"}</Badge>
              )}
              <span className="font-mono text-muted-foreground">{r.ip_hash_short || "—"}</span>
            </span>
          </div>
          <div className="mt-0.5 break-all text-muted-foreground">
            {r.user_agent ? `UA: ${r.user_agent}` : "UA: —"}
          </div>
        </div>
      ))}
    </div>
  );
}

function LinkAttemptsPanel({ licenseCode }: { licenseCode: string }) {
  const attempts = useInfiniteQuery<Page<LicenseAttempt>>({
    queryKey: ["admin-license-attempts", licenseCode],
    queryFn: ({ pageParam = 0 }) =>
      adminListLicenseAttempts(licenseCode, { offset: pageParam as number, limit: PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset,
  });

  if (attempts.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading attempts…
      </div>
    );
  }

  const items = attempts.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No over-limit activation attempts recorded.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 py-1">
      <div className="text-xs font-medium text-muted-foreground">
        Machines that tried to activate past the limit
      </div>
      {items.map((a: LicenseAttempt) => (
        <div key={a.id} className="rounded-md border px-3 py-1.5 text-xs">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="flex items-center gap-2 flex-wrap">
              <ShieldAlert className="size-3.5 text-destructive" />
              {a.app_version && <Badge variant="secondary">v{a.app_version}</Badge>}
            </span>
            <span className="text-muted-foreground">{fmtDate(a.attempted_at)}</span>
          </div>
          <div className="mt-0.5 break-all text-muted-foreground">
            {a.ip_hash_short ? `ip ${a.ip_hash_short}` : "ip —"}
            {a.user_agent ? ` · ${a.user_agent}` : ""}
          </div>
        </div>
      ))}
      <InfiniteScrollSentinel query={attempts} />
    </div>
  );
}

function LinkCard({ link }: { link: ProgramDownloadLink }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [showAttempts, setShowAttempts] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const revokeMut = useMutation({
    mutationFn: () => adminRevokeProgramDownloadLink(link.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-program-links"] }),
  });

  const statusVariant =
    link.status === "active" ? "default" : link.status === "revoked" ? "destructive" : "secondary";

  // Build the shareable link from the current frontend origin so it always
  // points at the SPA /download page, not the backend API host.
  const shareUrl = programDownloadPageUrl(link.token);

  return (
    <Card>
      <CardContent className="py-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{link.label || "(no label)"}</span>
              <Badge variant={statusVariant}>{link.status}</Badge>
              <Badge variant={link.include_keys ? "outline" : "secondary"}>
                {link.include_keys ? "full package" : "program only"}
              </Badge>
              <Badge variant="secondary">{link.redeem_count} downloads</Badge>
              {link.include_keys && (
                <Badge variant="secondary">
                  {link.active_activations} / {link.max_activations} machines
                </Badge>
              )}
              {link.over_limit_attempts > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <ShieldAlert className="size-3" /> {link.over_limit_attempts} over-limit
                </Badge>
              )}
            </div>
            {shareUrl && (
              <div className="flex items-center gap-2 flex-wrap">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                  {shareUrl}
                </code>
                <CopyButton value={shareUrl} label="Copy link" />
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ size: "xs", variant: "outline" })}
                >
                  <ExternalLink className="size-3" /> Open
                </a>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              created {fmtDate(link.created_at)} · expires {fmtDate(link.expires_at)}
              {link.last_redeem_at ? ` · last download ${fmtDate(link.last_redeem_at)}` : ""}
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Downloads
            </Button>
            {link.over_limit_attempts > 0 && (
              <Button size="sm" variant="outline" onClick={() => setShowAttempts((v) => !v)}>
                <ShieldAlert className="size-3" /> Over-limit
              </Button>
            )}
            {link.status !== "revoked" && (
              <Button size="sm" variant="destructive" onClick={() => setConfirmRevoke(true)}>
                Revoke
              </Button>
            )}
          </div>
        </div>

        {expanded && (
          <>
            <Separator />
            {link.include_keys && link.license_code && link.api_key ? (
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-muted-foreground">license</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono break-all">
                    {link.license_code}
                  </code>
                  <CopyButton value={link.license_code} />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-muted-foreground">publish key</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono break-all">
                    {link.api_key}
                  </code>
                  <CopyButton value={link.api_key} />
                </div>
                <Separator />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Program-only link — the zip ships just the exe, no license or publish key.
              </p>
            )}
            <RedemptionsPanel linkId={link.id} />
          </>
        )}

        {showAttempts && link.license_code && (
          <>
            <Separator />
            <LinkAttemptsPanel licenseCode={link.license_code} />
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke this download link?"
        description={
          <>
            <span className="font-mono">{link.label || link.token}</span> will stop working
            immediately and the recipient can no longer download the build. The already-issued
            license and key stay valid — revoke those separately on the Licenses page if needed.
          </>
        }
        confirmLabel="Revoke"
        variant="destructive"
        loading={revokeMut.isPending}
        onCancel={() => setConfirmRevoke(false)}
        onConfirm={() => revokeMut.mutate(undefined, { onSettled: () => setConfirmRevoke(false) })}
      />
    </Card>
  );
}

export function AdminProgramDownloadsPage() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [maxActivations, setMaxActivations] = useState(2);
  const [expiresAt, setExpiresAt] = useState("");
  const [notes, setNotes] = useState("");
  const [exeOnly, setExeOnly] = useState(false);
  const [created, setCreated] = useState<ProgramDownloadLink | null>(null);

  // List filters
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search);
  const [status, setStatus] = useState<"all" | "active" | "expired" | "revoked">("all");
  const [machines, setMachines] = useState("any");

  const machineFilter = MACHINE_FILTER_OPTIONS.find((m) => m.value === machines);

  const links = useInfiniteQuery<Page<ProgramDownloadLink>>({
    queryKey: ["admin-program-links", debouncedSearch, status, machines],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await adminListProgramDownloadLinks({
        status,
        q: debouncedSearch,
        min_machines: machineFilter?.min ?? null,
        max_machines: machineFilter?.max ?? null,
        offset: pageParam as number,
        limit: PAGE_SIZE,
      });
      return { items: res.links, total: res.total, next_offset: res.next_offset };
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset,
  });

  const createMut = useMutation({
    mutationFn: () =>
      adminCreateProgramDownloadLink({
        label: label.trim() || null,
        max_activations: maxActivations,
        expires_at: expiresAt ? `${expiresAt}T23:59:59Z` : null,
        notes: notes.trim() || null,
        include_keys: !exeOnly,
      }),
    onSuccess: (data) => {
      setCreated(data);
      setLabel("");
      setNotes("");
      setExpiresAt("");
      setExeOnly(false);
      queryClient.invalidateQueries({ queryKey: ["admin-program-links"] });
    },
  });

  const items = useMemo(() => links.data?.pages.flatMap((p) => p.items) ?? [], [links.data]);
  const total = links.data?.pages[0]?.total ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Program Downloads</h1>
        <p className="text-sm text-muted-foreground">
          Distribute a pre-configured VSProxy build. Builds are published automatically by the
          deploy script; generate a per-recipient link, and the recipient picks their platform
          (Windows/Linux) at download time. Each full link mints a license + an upload key (Map
          features export) packaged as <code>license.key</code> + <code>publish.key</code> next to
          the program in a zip. The label tracks who you handed each link to.
        </p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 py-3 text-sm">
          <div>
            <div className="text-2xl font-semibold">{total}</div>
            <div className="text-muted-foreground">
              Links{status !== "all" || debouncedSearch || machines !== "any" ? " (filtered)" : ""}
            </div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{items.length}</div>
            <div className="text-muted-foreground">Loaded</div>
          </div>
        </CardContent>
      </Card>

      <CurrentBuildsCard />
      <VersionGateCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" /> Generate a download link
          </CardTitle>
          <CardDescription>Share the generated link with one recipient.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
            <div className="space-y-0.5">
              <Label htmlFor="pd-exe-only" className="cursor-pointer">
                Program only (update)
              </Label>
              <p className="text-xs text-muted-foreground">
                Ships just the exe — no license or publish key. Use this to hand out program updates
                to people who already have their keys.
              </p>
            </div>
            <Switch id="pd-exe-only" checked={exeOnly} onCheckedChange={setExeOnly} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pd-label">Label (recipient)</Label>
              <Input
                id="pd-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Alice"
              />
            </div>
            {!exeOnly && (
              <div className="space-y-1">
                <Label htmlFor="pd-max">Max machines</Label>
                <Input
                  id="pd-max"
                  type="number"
                  min={1}
                  max={20}
                  value={maxActivations}
                  onChange={(e) => setMaxActivations(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="pd-exp">Expires (optional)</Label>
              <Input
                id="pd-exp"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pd-notes">Notes (optional)</Label>
              <Input
                id="pd-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="anything to remember"
              />
            </div>
          </div>

          {createMut.isError && (
            <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>
          )}

          {created && (
            <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
              <div className="text-sm font-medium">Download link created</div>
              {created.token && (
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-sm break-all">
                    {programDownloadPageUrl(created.token)}
                  </code>
                  <CopyButton value={programDownloadPageUrl(created.token)} label="Copy link" />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Send this link to {created.label || "the recipient"}.{" "}
                {created.include_keys ? (
                  <>
                    The zip they download already contains their <code>license.key</code> and{" "}
                    <code>publish.key</code> — you don't need to send anything else.
                  </>
                ) : (
                  <>
                    The zip contains only the updated program — they keep their existing{" "}
                    <code>license.key</code> and <code>publish.key</code>.
                  </>
                )}
              </p>
            </div>
          )}

          <Button onClick={() => createMut.mutate()} disabled={createMut.isPending}>
            {createMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Generate link
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Links{total ? ` (${total})` : ""}
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => links.refetch()}
            disabled={links.isFetching}
          >
            <RefreshCw className={`size-3 ${links.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-50 flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search label, notes, license, or token…"
              className="pl-7"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus((v ?? "all") as typeof status)}>
            <SelectTrigger className="w-36">
              <SelectValue>
                {(value) =>
                  STATUS_FILTER_OPTIONS.find((s) => s.value === value)?.label || "Select a status"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTER_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={machines} onValueChange={(v) => setMachines(v ?? "any")}>
            <SelectTrigger className="w-40">
              <SelectValue>
                {(value) =>
                  MACHINE_FILTER_OPTIONS.find((m) => m.value === value)?.label || "Select a machine"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MACHINE_FILTER_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {links.isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No links match these filters.</p>
        ) : (
          <>
            {items.map((l) => (
              <LinkCard key={l.id} link={l} />
            ))}
            <InfiniteScrollSentinel query={links} />
          </>
        )}
      </div>
    </div>
  );
}
