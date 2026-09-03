import { useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Copy,
  Check,
  Loader2,
  ChevronDown,
  ChevronRight,
  Upload,
  KeyRound,
  ExternalLink,
  Package,
  Search,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  adminGetProgramBuild,
  adminProgramBuildUploadUrl,
  uploadProgramBuildToR2,
  adminProgramBuildFinalize,
  adminCreateProgramDownloadLink,
  adminListProgramDownloadLinks,
  adminListProgramDownloadRedemptions,
  adminListLicenseAttempts,
  adminRevokeProgramDownloadLink,
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

function BuildCard() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [versionLabel, setVersionLabel] = useState("");

  const build = useQuery({
    queryKey: ["admin-program-build"],
    queryFn: adminGetProgramBuild,
  });

  const uploadMut = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a .exe file first");
      const { upload_url, content_type, r2_key } = await adminProgramBuildUploadUrl(file.name);
      await uploadProgramBuildToR2(upload_url, content_type, file);
      return adminProgramBuildFinalize({
        r2_key,
        original_filename: file.name,
        version_label: versionLabel.trim() || null,
      });
    },
    onSuccess: () => {
      setFile(null);
      setVersionLabel("");
      if (fileRef.current) fileRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["admin-program-build"] });
    },
  });

  const current = build.data?.build ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="size-4" /> Current build
        </CardTitle>
        <CardDescription>
          Upload the compiled <code>VSProxy.exe</code> (built locally with its baked-in default
          arguments, but <strong>without</strong> a license or publish key — those are injected
          per-recipient). Uploading replaces the current build; new links use it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {current ? (
          <div className="rounded-md border px-3 py-2 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{current.original_filename || "VSProxy.exe"}</span>
              {current.version_label && <Badge variant="secondary">{current.version_label}</Badge>}
              <Badge variant="outline">{fmtBytes(current.size_bytes)}</Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              uploaded {fmtDate(current.uploaded_at)}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No build uploaded yet. Upload one before generating download links.
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="build-file">Build file (.exe)</Label>
            <Input
              id="build-file"
              ref={fileRef}
              type="file"
              accept=".exe,application/octet-stream"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="build-version">Version label (optional)</Label>
            <Input
              id="build-version"
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
              placeholder="e.g. 1.2.5"
            />
          </div>
        </div>

        {uploadMut.isError && (
          <p className="text-sm text-destructive">{(uploadMut.error as Error).message}</p>
        )}

        <Button onClick={() => uploadMut.mutate()} disabled={!file || uploadMut.isPending}>
          {uploadMut.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Upload className="size-4" />
          )}
          {uploadMut.isPending ? "Uploading…" : "Upload build"}
        </Button>
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

  return (
    <Card>
      <CardContent className="py-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{link.label || "(no label)"}</span>
              <Badge variant={statusVariant}>{link.status}</Badge>
              <Badge variant="secondary">{link.redeem_count} downloads</Badge>
              <Badge variant="secondary">
                {link.active_activations} / {link.max_activations} machines
              </Badge>
              {link.over_limit_attempts > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <ShieldAlert className="size-3" /> {link.over_limit_attempts} over-limit
                </Badge>
              )}
            </div>
            {link.url && (
              <div className="flex items-center gap-2 flex-wrap">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                  {link.url}
                </code>
                <CopyButton value={link.url} label="Copy link" />
                <a
                  href={link.url}
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
            </div>
            <Separator />
            <RedemptionsPanel linkId={link.id} />
          </>
        )}

        {showAttempts && (
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
      }),
    onSuccess: (data) => {
      setCreated(data);
      setLabel("");
      setNotes("");
      setExpiresAt("");
      queryClient.invalidateQueries({ queryKey: ["admin-program-links"] });
    },
  });

  const items = useMemo(
    () => links.data?.pages.flatMap((p) => p.items) ?? [],
    [links.data],
  );
  const total = links.data?.pages[0]?.total ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Program Downloads</h1>
        <p className="text-sm text-muted-foreground">
          Distribute a pre-configured VSProxy build. Upload the exe once, then generate a
          per-recipient link. Each link mints a license + an upload key (Map features export) and
          packages them as <code>license.key</code> + <code>publish.key</code> next to the exe in a
          zip. The label tracks who you handed each link to.
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

      <BuildCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" /> Generate a download link
          </CardTitle>
          <CardDescription>Share the generated link with one recipient.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
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
              {created.url && (
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-sm break-all">
                    {created.url}
                  </code>
                  <CopyButton value={created.url} label="Copy link" />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Send this link to {created.label || "the recipient"}. The zip they download already
                contains their <code>license.key</code> and <code>publish.key</code> — you don't
                need to send anything else.
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
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="revoked">Revoked</SelectItem>
            </SelectContent>
          </Select>
          <Select value={machines} onValueChange={(v) => setMachines(v ?? "any")}>
            <SelectTrigger className="w-40">
              <SelectValue />
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
