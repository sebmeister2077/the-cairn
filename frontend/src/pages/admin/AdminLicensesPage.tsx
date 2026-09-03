import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Copy,
  Check,
  Loader2,
  Ban,
  ChevronDown,
  ChevronRight,
  KeyRound,
  MonitorSmartphone,
  AlertTriangle,
  SlidersHorizontal,
  Search,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  adminListLicenses,
  adminCreateLicense,
  adminListLicenseActivations,
  adminListLicenseAttempts,
  adminRevokeLicense,
  adminRevokeLicenseActivation,
  adminDismissActivationFlag,
  type License,
  type LicenseActivation,
  type LicenseAttempt,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
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

function shortFp(fp: string): string {
  return fp.length > 16 ? `${fp.slice(0, 8)}…${fp.slice(-6)}` : fp;
}

function fmtVal(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

type ParamDiff = {
  added: string[];
  removed: string[];
  changed: { key: string; from: unknown; to: unknown }[];
};

function diffParams(
  prev: Record<string, unknown> | null,
  cur: Record<string, unknown> | null,
): ParamDiff {
  const p = prev ?? {};
  const c = cur ?? {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: { key: string; from: unknown; to: unknown }[] = [];
  for (const k of Object.keys(c)) {
    if (!(k in p)) added.push(k);
    else if (JSON.stringify(p[k]) !== JSON.stringify(c[k]))
      changed.push({ key: k, from: p[k], to: c[k] });
  }
  for (const k of Object.keys(p)) {
    if (!(k in c)) removed.push(k);
  }
  added.sort();
  removed.sort();
  changed.sort((a, b) => a.key.localeCompare(b.key));
  return { added, removed, changed };
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

function ActivationsPanel({ licenseCode }: { licenseCode: string }) {
  const queryClient = useQueryClient();
  const activations = useQuery({
    queryKey: ["admin-license-activations", licenseCode],
    queryFn: () => adminListLicenseActivations(licenseCode),
  });

  const unbindMut = useMutation({
    mutationFn: (fingerprint: string) => adminRevokeLicenseActivation(licenseCode, fingerprint),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-license-activations", licenseCode] });
      queryClient.invalidateQueries({ queryKey: ["admin-licenses"] });
    },
  });

  const dismissMut = useMutation({
    mutationFn: (fingerprint: string) => adminDismissActivationFlag(licenseCode, fingerprint),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-license-activations", licenseCode] });
    },
  });

  if (activations.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading machines…
      </div>
    );
  }

  const items = activations.data?.items ?? [];
  if (items.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No machines have activated this license yet.
      </p>
    );
  }

  return (
    <div className="space-y-2 py-1">
      {items.map((a: LicenseActivation) => (
        <ActivationRow
          key={a.fingerprint}
          a={a}
          onUnbind={() => unbindMut.mutate(a.fingerprint)}
          unbinding={unbindMut.isPending}
          onDismiss={() => dismissMut.mutate(a.fingerprint)}
          dismissing={dismissMut.isPending}
        />
      ))}
    </div>
  );
}

function ActivationRow({
  a,
  onUnbind,
  unbinding,
  onDismiss,
  dismissing,
}: {
  a: LicenseActivation;
  onUnbind: () => void;
  unbinding: boolean;
  onDismiss: () => void;
  dismissing: boolean;
}) {
  const [showParams, setShowParams] = useState(false);
  const params = a.parameters ?? null;
  const paramKeys = params ? Object.keys(params).sort() : [];
  const diff = a.params_changed ? diffParams(a.parameters_prev, params) : null;

  return (
    <div className="rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <MonitorSmartphone className="size-4 text-muted-foreground" />
            <span className="font-mono text-xs">{shortFp(a.fingerprint)}</span>
            {a.app_version && <Badge variant="secondary">v{a.app_version}</Badge>}
            {a.revoked && <Badge variant="destructive">unbound</Badge>}
            {a.params_changed && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="size-3" /> params changed
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            first {fmtDate(a.first_seen)} · last {fmtDate(a.last_seen)}
            {a.params_changed && a.params_changed_at
              ? ` · changed ${fmtDate(a.params_changed_at)}`
              : ""}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {params && (
            <Button size="xs" variant="outline" onClick={() => setShowParams((v) => !v)}>
              <SlidersHorizontal className="size-3" /> Params
            </Button>
          )}
          {a.params_changed && (
            <Button size="xs" variant="outline" disabled={dismissing} onClick={onDismiss}>
              <Check className="size-3" /> Dismiss
            </Button>
          )}
          {!a.revoked && (
            <Button size="xs" variant="outline" disabled={unbinding} onClick={onUnbind}>
              <Ban className="size-3" /> Unbind
            </Button>
          )}
        </div>
      </div>

      {diff && (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) && (
        <div className="mt-2 space-y-1 rounded bg-muted/50 px-2 py-1.5 text-xs">
          <div className="font-medium">Changes since previous run</div>
          {diff.added.map((k) => (
            <div key={`a-${k}`} className="font-mono text-green-600 dark:text-green-400">
              + {k} = {fmtVal(params?.[k])}
            </div>
          ))}
          {diff.removed.map((k) => (
            <div key={`r-${k}`} className="font-mono text-red-600 dark:text-red-400">
              − {k} = {fmtVal(a.parameters_prev?.[k])}
            </div>
          ))}
          {diff.changed.map((c) => (
            <div key={`c-${c.key}`} className="font-mono text-amber-600 dark:text-amber-400">
              ~ {c.key}: {fmtVal(c.from)} → {fmtVal(c.to)}
            </div>
          ))}
        </div>
      )}

      {showParams && params && (
        <div className="mt-2 rounded bg-muted/50 px-2 py-1.5 text-xs">
          {paramKeys.length === 0 ? (
            <span className="text-muted-foreground">No parameters reported.</span>
          ) : (
            paramKeys.map((k) => {
              const changedKey = diff?.changed.some((c) => c.key === k) || diff?.added.includes(k);
              return (
                <div key={k} className="font-mono">
                  <span className={changedKey ? "text-amber-600 dark:text-amber-400" : ""}>
                    {k}
                  </span>
                  <span className="text-muted-foreground"> = {fmtVal(params[k])}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function AttemptsPanel({ licenseCode }: { licenseCode: string }) {
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
              <span className="font-mono">
                {a.fingerprint ? shortFp(a.fingerprint) : "unknown"}
              </span>
              {a.app_version && <Badge variant="secondary">v{a.app_version}</Badge>}
            </span>
            <span className="text-muted-foreground">{fmtDate(a.attempted_at)}</span>
          </div>
          <div className="mt-0.5 text-muted-foreground break-all">
            {a.ip_hash_short ? `ip ${a.ip_hash_short}` : "ip —"}
            {a.user_agent ? ` · ${a.user_agent}` : ""}
          </div>
        </div>
      ))}
      <InfiniteScrollSentinel query={attempts} />
    </div>
  );
}

function LicenseCard({ lic }: { lic: License }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [showAttempts, setShowAttempts] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const revoked = lic.status !== "active";

  const revokeMut = useMutation({
    mutationFn: () => adminRevokeLicense(lic.license_code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-licenses"] }),
  });

  return (
    <Card>
      <CardContent className="py-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{lic.label || "(no label)"}</span>
              <Badge variant={revoked ? "destructive" : "default"}>{lic.status}</Badge>
              <Badge variant="secondary">
                {lic.active_activations} / {lic.max_activations} machines
              </Badge>
              {lic.over_limit_attempts > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <ShieldAlert className="size-3" /> {lic.over_limit_attempts} over-limit
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {lic.license_code}
              </code>
              <CopyButton value={lic.license_code} label="Copy code" />
            </div>
            <div className="text-xs text-muted-foreground">
              created {fmtDate(lic.created_at)} · expires {fmtDate(lic.expires_at)}
              {lic.notes ? ` · ${lic.notes}` : ""}
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Machines
            </Button>
            {lic.over_limit_attempts > 0 && (
              <Button size="sm" variant="outline" onClick={() => setShowAttempts((v) => !v)}>
                <ShieldAlert className="size-3" /> Over-limit
              </Button>
            )}
            {!revoked && (
              <Button size="sm" variant="destructive" onClick={() => setConfirmRevoke(true)}>
                Revoke
              </Button>
            )}
          </div>
        </div>

        {expanded && (
          <>
            <Separator />
            <ActivationsPanel licenseCode={lic.license_code} />
          </>
        )}

        {showAttempts && (
          <>
            <Separator />
            <AttemptsPanel licenseCode={lic.license_code} />
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke this license?"
        description={
          <>
            <span className="font-mono">{lic.label || lic.license_code}</span> will stop working on
            the next online check (within ~24h of any cached token expiring). This cannot be undone.
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

export function AdminLicensesPage() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [maxActivations, setMaxActivations] = useState(2);
  const [expiresAt, setExpiresAt] = useState("");
  const [notes, setNotes] = useState("");
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  // List filters
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search);
  const [status, setStatus] = useState<"all" | "active" | "revoked">("all");
  const [machines, setMachines] = useState("any");

  const machineFilter = MACHINE_FILTER_OPTIONS.find((m) => m.value === machines);

  const licenses = useInfiniteQuery<Page<License>>({
    queryKey: ["admin-licenses", debouncedSearch, status, machines],
    queryFn: ({ pageParam = 0 }) =>
      adminListLicenses({
        status,
        q: debouncedSearch,
        min_machines: machineFilter?.min ?? null,
        max_machines: machineFilter?.max ?? null,
        offset: pageParam as number,
        limit: PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset,
  });

  const createMut = useMutation({
    mutationFn: () =>
      adminCreateLicense({
        label: label.trim() || null,
        max_activations: maxActivations,
        expires_at: expiresAt ? `${expiresAt}T23:59:59Z` : null,
        notes: notes.trim() || null,
      }),
    onSuccess: (data) => {
      setCreatedCode(data.license_code);
      setLabel("");
      setNotes("");
      setExpiresAt("");
      queryClient.invalidateQueries({ queryKey: ["admin-licenses"] });
    },
  });

  const items = licenses.data?.pages.flatMap((p) => p.items) ?? [];
  const total = licenses.data?.pages[0]?.total ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">VSProxy Licenses</h1>
        <p className="text-sm text-muted-foreground">
          Issue a per-friend key, see which machines each key is bound to, and revoke keys or
          individual machines. Each key is checked online at startup and locked to at most its
          activation limit.
        </p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 py-3 text-sm">
          <div>
            <div className="text-2xl font-semibold">{total}</div>
            <div className="text-muted-foreground">
              Licenses
              {status !== "all" || debouncedSearch || machines !== "any" ? " (filtered)" : ""}
            </div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{items.length}</div>
            <div className="text-muted-foreground">Loaded</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" /> Issue a new license
          </CardTitle>
          <CardDescription>Give the generated code to one friend.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="lic-label">Label (friend name)</Label>
              <Input
                id="lic-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Alice"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lic-max">Max machines</Label>
              <Input
                id="lic-max"
                type="number"
                min={1}
                max={20}
                value={maxActivations}
                onChange={(e) => setMaxActivations(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lic-exp">Expires (optional)</Label>
              <Input
                id="lic-exp"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lic-notes">Notes (optional)</Label>
              <Input
                id="lic-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="anything to remember"
              />
            </div>
          </div>

          {createMut.isError && (
            <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>
          )}

          {createdCode && (
            <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
              <div className="text-sm font-medium">New license created</div>
              <div className="flex items-center gap-2 flex-wrap">
                <code className="rounded bg-muted px-2 py-1 font-mono text-sm break-all">
                  {createdCode}
                </code>
                <CopyButton value={createdCode} label="Copy code" />
              </div>
              <p className="text-xs text-muted-foreground">
                Send this to the friend. They put it in a <code>license.key</code> file next to the
                exe (or pass <code>--license</code>).
              </p>
            </div>
          )}

          <Button onClick={() => createMut.mutate()} disabled={createMut.isPending}>
            {createMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Create license
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            All licenses{total ? ` (${total})` : ""}
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => licenses.refetch()}
            disabled={licenses.isFetching}
          >
            <RefreshCw className={`size-3 ${licenses.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-50 flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search label, code, or notes…"
              className="pl-7"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
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

        {licenses.isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No licenses match these filters.</p>
        ) : (
          <>
            {items.map((lic) => (
              <LicenseCard key={lic.license_code} lic={lic} />
            ))}
            <InfiniteScrollSentinel query={licenses} />
          </>
        )}
      </div>
    </div>
  );
}
