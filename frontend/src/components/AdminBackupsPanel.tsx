/**
 * Admin-only panel for the weekly-backup system (Phase 4a).
 *
 * Renders inside ContributePage so all contribution-pipeline admin controls
 * live on a single page. Three subsections:
 *   1. TOTP enrolment status (gate for restore)
 *   2. Backup list + manual snapshot button
 *   3. Restore dialog (TOTP-gated, double-confirmed)
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Database,
  Camera,
  RefreshCw,
  History as HistoryIcon,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  Trash2,
  AlertTriangle,
  Link as LinkIcon,
  Copy,
  ExternalLink,
  Eye,
} from "lucide-react";
import {
  adminListBackups,
  adminCreateBackup,
  adminCleanupBackups,
  adminRestoreBackup,
  adminTotpStatus,
  adminTotpEnroll,
  adminTotpConfirm,
  adminLastBackupRestore,
  adminCreateBackupDownloadLink,
  adminListBackupDownloadLinks,
  adminListBackupDownloadRedemptions,
  adminRevokeBackupDownloadLink,
  type BackupRecord,
  type BackupDownloadLink,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffectWithAbort } from "@/hooks/useEffectWithAbort";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = n / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function AdminBackupsPanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const totp = useQuery({
    queryKey: ["admin-totp-status"],
    queryFn: adminTotpStatus,
    refetchOnWindowFocus: false,
  });

  const backups = useQuery({
    queryKey: ["admin-backups"],
    queryFn: adminListBackups,
    enabled: open,
    // Surface 404 (feature flag off) without polluting the query log.
    retry: false,
  });

  const lastRestore = useQuery({
    queryKey: ["admin-last-restore"],
    queryFn: adminLastBackupRestore,
    refetchInterval: 60_000,
  });

  const createBackup = useMutation({
    mutationFn: adminCreateBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-backups"] }),
  });

  const cleanup = useMutation({
    mutationFn: adminCleanupBackups,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-backups"] }),
  });

  const [enrolDialog, setEnrolDialog] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [linkTarget, setLinkTarget] = useState<BackupRecord | null>(null);

  const featureDisabled = backups.isError && /HTTP 404|Not Found/i.test(String(backups.error));

  const downloadLinks = useQuery({
    queryKey: ["admin-backup-download-links"],
    queryFn: adminListBackupDownloadLinks,
    enabled: open && !featureDisabled,
    refetchInterval: open ? 30_000 : false,
    retry: false,
  });

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left cursor-pointer"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" />
            Admin: Backups & Restore
          </CardTitle>
          {totp.data?.enrolled ? (
            <Badge variant="outline" className="ml-2 gap-1 text-[10px]">
              <ShieldCheck className="h-3 w-3 text-emerald-600" /> 2FA enrolled
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-2 gap-1 text-[10px]">
              <AlertTriangle className="h-3 w-3 text-amber-600" /> 2FA needed
            </Badge>
          )}
        </button>
      </CardHeader>

      {open && (
        <CardContent className="space-y-4">
          {lastRestore.data?.last_restore && (
            <div className="border border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100 rounded p-3 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <HistoryIcon className="h-4 w-4 text-amber-700 dark:text-amber-300" />
                Map was restored from a backup on{" "}
                {new Date(lastRestore.data.last_restore.restored_at).toLocaleString()}
              </div>
              <p className="text-xs text-amber-900/80 dark:text-amber-200/80 mt-1">
                Source: <code>{lastRestore.data.last_restore.backup_key}</code> •{" "}
                {lastRestore.data.last_restore.orphaned_contributions} contribution(s) marked{" "}
                <code>orphaned_by_restore</code>.
              </p>
            </div>
          )}

          <TotpSection
            status={totp.data}
            loading={totp.isLoading}
            onStartEnrol={() => setEnrolDialog(true)}
            onRefresh={() => totp.refetch()}
          />

          {featureDisabled && (
            <p className="text-sm text-muted-foreground">
              The <code>weekly_backups</code> feature flag is off. Enable it from the feature-flag
              panel to view and manage snapshots.
            </p>
          )}

          {!featureDisabled && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => createBackup.mutate()}
                  disabled={createBackup.isPending}
                >
                  {createBackup.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Camera className="h-3 w-3" />
                  )}
                  Create manual snapshot
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => backups.refetch()}
                  disabled={backups.isFetching}
                  aria-label="Refresh"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => cleanup.mutate()}
                  disabled={cleanup.isPending}
                >
                  <Trash2 className="h-3 w-3" />
                  Run cleanup
                </Button>
                {backups.data && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    Retention: {backups.data.retention.scheduled} scheduled,{" "}
                    {backups.data.retention.manual} manual
                    <HelpTip
                      text={
                        "Cleanup keeps the N newest of each kind in R2. Manual snapshots " +
                        "are retained independently from scheduled ones."
                      }
                    />
                  </span>
                )}
              </div>

              {createBackup.error && (
                <p className="text-xs text-destructive">
                  Snapshot failed: {String(createBackup.error)}
                </p>
              )}

              {backups.isLoading && (
                <div className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading backups…
                </div>
              )}

              {backups.data && backups.data.backups.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No backups yet. The first scheduled snapshot fires on the next ISO-week boundary,
                  or click <strong>Create manual snapshot</strong>.
                </p>
              )}

              {backups.data && backups.data.backups.length > 0 && (
                <ul className="divide-y border rounded">
                  {backups.data.backups.map((b) => (
                    <BackupRow
                      key={b.key}
                      backup={b}
                      restoreEnabled={Boolean(totp.data?.enrolled)}
                      onRestore={() => setRestoreTarget(b)}
                      onGenerateLink={() => setLinkTarget(b)}
                    />
                  ))}
                </ul>
              )}

              <DownloadLinksSection
                links={downloadLinks.data?.links ?? []}
                loading={downloadLinks.isLoading}
                error={downloadLinks.error ? String(downloadLinks.error) : null}
                onRefresh={() => downloadLinks.refetch()}
              />
            </>
          )}
        </CardContent>
      )}

      <TotpEnrolDialog
        open={enrolDialog}
        onClose={() => setEnrolDialog(false)}
        onEnrolled={() => {
          setEnrolDialog(false);
          queryClient.invalidateQueries({ queryKey: ["admin-totp-status"] });
        }}
      />

      <RestoreDialog
        backup={restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onRestored={() => {
          setRestoreTarget(null);
          queryClient.invalidateQueries({ queryKey: ["admin-backups"] });
          queryClient.invalidateQueries({ queryKey: ["admin-last-restore"] });
        }}
      />

      <GenerateLinkDialog
        backup={linkTarget}
        onClose={() => setLinkTarget(null)}
        onCreated={() =>
          queryClient.invalidateQueries({ queryKey: ["admin-backup-download-links"] })
        }
      />
    </Card>
  );
}

function BackupRow({
  backup,
  restoreEnabled,
  onRestore,
  onGenerateLink,
}: {
  backup: BackupRecord;
  restoreEnabled: boolean;
  onRestore: () => void;
  onGenerateLink: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 p-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="text-xs font-mono truncate">{backup.key}</code>
          {backup.kind === "scheduled" ? (
            <Badge className="text-[10px]">scheduled</Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">
              manual
            </Badge>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {formatBytes(backup.size)} •{" "}
          {backup.last_modified ? new Date(backup.last_modified).toLocaleString() : "unknown date"}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onGenerateLink}
          title="Generate a shareable download link"
        >
          <LinkIcon className="h-3 w-3" />
          Generate link
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={onRestore}
          disabled={!restoreEnabled}
          title={restoreEnabled ? "Restore this backup" : "Enrol in TOTP 2FA before restoring"}
        >
          Restore
        </Button>
      </div>
    </li>
  );
}

function TotpSection({
  status,
  loading,
  onStartEnrol,
  onRefresh,
}: {
  status: { enrolled: boolean; configured: boolean } | undefined;
  loading: boolean;
  onStartEnrol: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="border rounded p-3 space-y-2 bg-muted/30">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <span>
            <strong>2FA (TOTP)</strong>:{" "}
            {loading
              ? "checking…"
              : !status?.configured
                ? "not configured on the server"
                : status.enrolled
                  ? "enrolled — restore is unlocked"
                  : "not enrolled — required to restore"}
          </span>
          <HelpTip
            text={
              "Backup restore requires a 6-digit TOTP code from a mobile authenticator " +
              "(Google Authenticator, Authy, 1Password, Bitwarden, …). Enrol once per admin " +
              "key. The encrypted secret is stored on the server; the plaintext lives only " +
              "in your authenticator app."
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onRefresh} aria-label="Refresh status">
            <RefreshCw className="h-3 w-3" />
          </Button>
          {status?.configured && !status.enrolled && (
            <Button size="sm" onClick={onStartEnrol}>
              Enrol now
            </Button>
          )}
          {status?.configured && status.enrolled && (
            <Button size="sm" variant="outline" onClick={onStartEnrol}>
              Re-enrol
            </Button>
          )}
        </div>
      </div>
      {status && !status.configured && (
        <p className="text-xs text-muted-foreground">
          Set <code>TOTP_ENCRYPTION_KEY</code> in the backend environment to enable TOTP enrolment.
          Until then, the restore endpoint returns 503.
        </p>
      )}
    </div>
  );
}

function TotpEnrolDialog({
  open,
  onClose,
  onEnrolled,
}: {
  open: boolean;
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const enroll = useMutation({
    mutationFn: adminTotpEnroll,
    onSuccess: (data) => {
      setSecret(data.secret);
      setUri(data.otpauth_uri);
      setError(null);
    },
    onError: (e) => setError(String(e)),
  });

  const confirm = useMutation({
    mutationFn: (c: string) => adminTotpConfirm(c),
    onSuccess: () => {
      onEnrolled();
      // reset for next open
      setSecret(null);
      setUri(null);
      setCode("");
      setQrDataUrl(null);
    },
    onError: (e) => setError(String(e)),
  });

  // Kick off enrolment as soon as the dialog opens.
  useEffect(() => {
    if (open && !secret && !enroll.isPending) {
      enroll.mutate();
    }
    if (!open) {
      setSecret(null);
      setUri(null);
      setCode("");
      setError(null);
      setQrDataUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Render the otpauth URI to a QR data-URL once it's available.
  useEffectWithAbort(
    ({ signal }) => {
      if (!uri) return;
      (async () => {
        try {
          const QRCode = await import("qrcode");
          const dataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
          if (signal.aborted) return;
          setQrDataUrl(dataUrl);
        } catch (e) {
          if (signal.aborted) return;
          setError(`QR render failed: ${String(e)}`);
        }
      })();
    },
    [uri],
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enrol in TOTP 2FA</DialogTitle>
          <DialogDescription>
            Scan the QR with your authenticator app and enter the first 6-digit code. The secret is
            shown once — if you lose it you'll have to re-enrol.
          </DialogDescription>
        </DialogHeader>

        {enroll.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Generating secret…
          </div>
        )}

        {secret && (
          <div className="space-y-3">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="TOTP QR code"
                className="border rounded p-2 bg-white mx-auto"
                width={220}
                height={220}
              />
            ) : (
              <div className="text-xs text-muted-foreground">Rendering QR…</div>
            )}
            <div>
              <Label className="text-xs">Manual entry secret</Label>
              <Input readOnly value={secret} className="font-mono text-xs" />
              <p className="text-[10px] text-muted-foreground mt-1">
                30 s window, 6 digits. Compatible with Google Authenticator, Authy, 1Password,
                Bitwarden.
              </p>
            </div>
            <div>
              <Label htmlFor="totp-confirm-code" className="text-xs">
                First 6-digit code
              </Label>
              <Input
                id="totp-confirm-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
              />
            </div>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!secret || code.length !== 6 || confirm.isPending}
            onClick={() => confirm.mutate(code)}
          >
            {confirm.isPending && <Loader2 className="h-3 w-3 animate-spin" />} Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreDialog({
  backup,
  onClose,
  onRestored,
}: {
  backup: BackupRecord | null;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmFinal, setConfirmFinal] = useState(false);

  const restore = useMutation({
    mutationFn: () => adminRestoreBackup(backup!.key, code),
    onSuccess: () => {
      onRestored();
      setCode("");
      setError(null);
    },
    onError: (e) => setError(String(e)),
  });

  const restoreSummary = useMemo(() => {
    if (!backup) return "";
    const when = backup.last_modified
      ? new Date(backup.last_modified).toLocaleString()
      : "unknown date";
    return `${backup.key} (${when})`;
  }, [backup]);

  if (!backup) return null;

  function handleClose() {
    onClose();
    setCode("");
  }
  return (
    <>
      <Dialog
        open={!!backup && !confirmFinal && !restore.isPending && !restore.isSuccess}
        onOpenChange={(v) => !v && !restore.isPending && handleClose()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore from backup</DialogTitle>
            <DialogDescription>
              This will overwrite the live combined map with <code>{restoreSummary}</code>.
              Contributions approved after this snapshot will be marked{" "}
              <code>orphaned_by_restore</code>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="restore-totp" className="text-xs">
              TOTP code
            </Label>
            <Input
              id="restore-totp"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={code.length !== 6}
              onClick={() => setConfirmFinal(true)}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmFinal}
        title="Really restore the combined map?"
        description={
          "Restore is destructive and not undoable from inside the app. Map regen will run " +
          "afterwards. Make sure no contributors are mid-upload."
        }
        confirmLabel={restore.isPending ? "Restoring…" : "Restore now"}
        variant="destructive"
        onCancel={() => setConfirmFinal(false)}
        onConfirm={() => {
          // Close both dialogs immediately and fire the (long-running) restore.
          // The TOTP dialog stays hidden while the mutation is in flight so the
          // admin isn't stuck staring at it; on success we close via onRestored.
          setConfirmFinal(false);
          restore.mutate();
          // handleClose();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shareable backup-download links
// ---------------------------------------------------------------------------

const TTL_OPTIONS: { label: string; value: number }[] = [
  { label: "15 minutes", value: 15 * 60 },
  { label: "1 hour", value: 60 * 60 },
  { label: "24 hours", value: 24 * 60 * 60 },
  { label: "7 days", value: 7 * 24 * 60 * 60 },
  { label: "30 days", value: 30 * 24 * 60 * 60 },
];

function formatRelative(toIso: string | null): string {
  if (!toIso) return "";
  const ms = new Date(toIso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const units: [number, string][] = [
    [60_000, "s"],
    [3_600_000, "min"],
    [86_400_000, "h"],
    [Number.POSITIVE_INFINITY, "d"],
  ];
  let unitIdx = units.findIndex(([cap]) => abs < cap);
  if (unitIdx === -1) unitIdx = units.length - 1;
  const divisors = [1000, 60_000, 3_600_000, 86_400_000];
  const value = Math.round(abs / divisors[unitIdx]);
  const u = units[unitIdx][1];
  return ms >= 0 ? `in ${value}${u}` : `${value}${u} ago`;
}

function GenerateLinkDialog({
  backup,
  onClose,
  onCreated,
}: {
  backup: BackupRecord | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [ttl, setTtl] = useState<number>(24 * 60 * 60);
  const [label, setLabel] = useState("");
  const [generated, setGenerated] = useState<BackupDownloadLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!backup) {
      setTtl(24 * 60 * 60);
      setLabel("");
      setGenerated(null);
      setError(null);
      setCopied(false);
    }
  }, [backup]);

  const create = useMutation({
    mutationFn: () =>
      adminCreateBackupDownloadLink({
        key: backup!.key,
        ttl_seconds: ttl,
        label: label || undefined,
      }),
    onSuccess: (data) => {
      setGenerated(data);
      setError(null);
      onCreated();
    },
    onError: (e) => setError(String(e)),
  });

  const handleCopy = async () => {
    if (!generated?.url) return;
    try {
      await navigator.clipboard.writeText(generated.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy to clipboard.");
    }
  };

  if (!backup) return null;

  return (
    <Dialog open={!!backup} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate download link</DialogTitle>
          <DialogDescription>
            Create a shareable URL for <code className="font-mono">{backup.key}</code>. Anyone with
            the link can download the file until it expires or you revoke it.
          </DialogDescription>
        </DialogHeader>

        {!generated && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="link-ttl" className="text-xs">
                Link expires after
              </Label>
              <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))}>
                <SelectTrigger id="link-ttl">
                  <SelectValue>
                    {TTL_OPTIONS.find((o) => o.value === ttl)?.label ?? `${ttl} s`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TTL_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="link-label" className="text-xs">
                Label (optional)
              </Label>
              <Input
                id="link-label"
                value={label}
                maxLength={200}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Sent to Alice 2026-05-04"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Shown in the active-links list to help you remember who you shared it with.
              </p>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {generated && (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Shareable URL</Label>
              <div className="flex items-center gap-2">
                <Input readOnly value={generated.url} className="font-mono text-xs" />
                <Button size="sm" variant="outline" onClick={handleCopy}>
                  <Copy className="h-3 w-3" />
                  {copied ? "Copied" : "Copy"}
                </Button>
                <a
                  href={generated.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs hover:bg-accent"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open
                </a>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Expires {formatRelative(generated.expires_at)} (
                {generated.expires_at ? new Date(generated.expires_at).toLocaleString() : "unknown"}
                ). Revoke from the <strong>Active download links</strong> list to invalidate early.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {!generated ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending && <Loader2 className="h-3 w-3 animate-spin" />} Generate
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DownloadLinksSection({
  links,
  loading,
  error,
  onRefresh,
}: {
  links: BackupDownloadLink[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);

  // Active first, then expired/revoked.
  const sorted = useMemo(() => {
    const order: Record<string, number> = { active: 0, expired: 1, revoked: 2 };
    return [...links].sort(
      (a, b) =>
        (order[a.status] ?? 99) - (order[b.status] ?? 99) ||
        (b.created_at || "").localeCompare(a.created_at || ""),
    );
  }, [links]);

  const activeCount = links.filter((l) => l.status === "active").length;

  return (
    <div className="border rounded">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-2 text-left text-sm font-medium cursor-pointer"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <LinkIcon className="h-4 w-4" />
        Active download links
        <Badge variant="outline" className="text-[10px]">
          {activeCount} active
        </Badge>
        {links.length > activeCount && (
          <Badge variant="secondary" className="text-[10px]">
            {links.length - activeCount} past
          </Badge>
        )}
        <span className="ml-auto" />
      </button>

      {open && (
        <div className="p-2 space-y-2 border-t">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onRefresh();
              }}
              aria-label="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
            <span className="text-xs text-muted-foreground">
              Auto-refreshes every 30 s while the panel is open.
            </span>
          </div>

          {loading && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading links…
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {!loading && !error && sorted.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No download links yet. Click <strong>Generate link</strong> on a backup row above.
            </p>
          )}

          {sorted.length > 0 && (
            <ul className="divide-y border rounded bg-background">
              {sorted.map((link) => (
                <DownloadLinkRow key={link.id} link={link} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DownloadLinkRow({ link }: { link: BackupDownloadLink }) {
  const queryClient = useQueryClient();
  const [showRedemptions, setShowRedemptions] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [copied, setCopied] = useState(false);

  const revoke = useMutation({
    mutationFn: () => adminRevokeBackupDownloadLink(link.id),
    onSuccess: () => {
      setConfirmRevoke(false);
      queryClient.invalidateQueries({ queryKey: ["admin-backup-download-links"] });
    },
  });

  const redemptions = useQuery({
    queryKey: ["admin-backup-download-redemptions", link.id],
    queryFn: () => adminListBackupDownloadRedemptions(link.id),
    enabled: showRedemptions,
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const expiryLabel =
    link.status === "revoked"
      ? `revoked ${formatRelative(link.revoked_at)}`
      : link.status === "expired"
        ? `expired ${formatRelative(link.expires_at)}`
        : `expires ${formatRelative(link.expires_at)}`;

  return (
    <li className="p-2 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <code className="text-xs font-mono truncate max-w-[26ch]" title={link.backup_key}>
          {link.backup_key.replace(/^backups\//, "")}
        </code>
        {link.status === "active" && <Badge className="text-[10px]">active</Badge>}
        {link.status === "expired" && (
          <Badge variant="secondary" className="text-[10px]">
            expired
          </Badge>
        )}
        {link.status === "revoked" && (
          <Badge variant="destructive" className="text-[10px]">
            revoked
          </Badge>
        )}
        {link.label && (
          <span className="text-[11px] text-muted-foreground italic truncate" title={link.label}>
            “{link.label}”
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          by …{link.created_by_suffix}
        </span>
      </div>

      <p className="text-[10px] text-muted-foreground">
        {expiryLabel} • {link.redeem_count} redeem{link.redeem_count === 1 ? "" : "s"}
        {link.redeem_count > 0 && ` (${link.success_count} ok)`}
        {link.last_redeem_at && ` • last ${formatRelative(link.last_redeem_at)}`}
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        {link.status === "active" && (
          <Button size="sm" variant="outline" onClick={handleCopy}>
            <Copy className="h-3 w-3" />
            {copied ? "Copied" : "Copy link"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowRedemptions((v) => !v)}>
          <Eye className="h-3 w-3" />
          {showRedemptions ? "Hide" : "View"} redemptions
        </Button>
        {link.status === "active" && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmRevoke(true)}
            disabled={revoke.isPending}
          >
            <Trash2 className="h-3 w-3" />
            Revoke
          </Button>
        )}
      </div>

      {showRedemptions && (
        <div className="mt-1 border rounded bg-muted/30 p-2 text-[11px]">
          {redemptions.isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          )}
          {redemptions.error && (
            <p className="text-destructive">Error: {String(redemptions.error)}</p>
          )}
          {redemptions.data && redemptions.data.redemptions.length === 0 && (
            <p className="text-muted-foreground">No redemptions yet.</p>
          )}
          {redemptions.data && redemptions.data.redemptions.length > 0 && (
            <ul className="space-y-1">
              {redemptions.data.redemptions.map((r) => (
                <li key={r.id} className="flex items-baseline gap-2">
                  <span className={r.success ? "text-emerald-600" : "text-destructive"}>
                    {r.success ? "✓" : "✗"}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {r.redeemed_at ? new Date(r.redeemed_at).toLocaleString() : "?"}
                  </span>
                  <code className="font-mono">ip:{r.ip_hash_short ?? "?"}</code>
                  {r.failure_reason && (
                    <span className="text-destructive">[{r.failure_reason}]</span>
                  )}
                  <span
                    className="text-muted-foreground truncate max-w-[40ch]"
                    title={r.user_agent ?? ""}
                  >
                    {r.user_agent ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke download link?"
        description="The link will stop working immediately. Anyone you have shared it with will see an error."
        confirmLabel={revoke.isPending ? "Revoking…" : "Revoke"}
        variant="destructive"
        onCancel={() => setConfirmRevoke(false)}
        onConfirm={() => revoke.mutate()}
      />
    </li>
  );
}
