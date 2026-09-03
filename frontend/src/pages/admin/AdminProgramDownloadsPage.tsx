import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
} from "lucide-react";
import {
  adminGetProgramBuild,
  adminProgramBuildUploadUrl,
  uploadProgramBuildToR2,
  adminProgramBuildFinalize,
  adminCreateProgramDownloadLink,
  adminListProgramDownloadLinks,
  adminListProgramDownloadRedemptions,
  adminRevokeProgramDownloadLink,
  type ProgramDownloadLink,
  type ProgramDownloadRedemption,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

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
    <div className="space-y-1 py-1">
      {items.map((r: ProgramDownloadRedemption) => (
        <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
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
      ))}
    </div>
  );
}

function LinkCard({ link }: { link: ProgramDownloadLink }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
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

  const links = useQuery({
    queryKey: ["admin-program-links"],
    queryFn: adminListProgramDownloadLinks,
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

  const items = links.data?.links ?? [];
  const active = useMemo(() => items.filter((l) => l.status === "active"), [items]);
  const totalDownloads = useMemo(() => items.reduce((n, l) => n + l.redeem_count, 0), [items]);

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
        <CardContent className="grid grid-cols-3 gap-3 py-3 text-sm">
          <div>
            <div className="text-2xl font-semibold">{items.length}</div>
            <div className="text-muted-foreground">Links</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{active.length}</div>
            <div className="text-muted-foreground">Active</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{totalDownloads}</div>
            <div className="text-muted-foreground">Downloads</div>
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
        <h2 className="text-sm font-medium text-muted-foreground">Links</h2>
        {links.isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No links yet.</p>
        ) : (
          items.map((l) => <LinkCard key={l.id} link={l} />)
        )}
      </div>
    </div>
  );
}
