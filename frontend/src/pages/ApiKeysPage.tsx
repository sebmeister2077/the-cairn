import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Plus, Trash2, KeyRound, Link } from "lucide-react";
import { listApiKeys, createApiKey, revokeApiKey, type ApiKeyRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function useCopy(timeout = 1500) {
  const [copied, setCopied] = useState<string | null>(null);
  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), timeout);
    });
  }
  return { copied, copy };
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function KeyRow({
  record,
  onRevoke,
}: {
  record: ApiKeyRecord;
  onRevoke: (key: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const statusBadge = record.revoked ? (
    <Badge variant="destructive">Revoked</Badge>
  ) : record.consume_once && record.bound_identity ? (
    <Badge variant="secondary">Bound</Badge>
  ) : (
    <Badge variant="default" className="bg-emerald-500 text-white hover:bg-emerald-500">
      Active
    </Badge>
  );

  const permBadge =
    record.permissions === "contribute" ? (
      <Badge variant="outline" className="text-blue-600 border-blue-300">
        Contribute
      </Badge>
    ) : (
      <Badge variant="outline">Read</Badge>
    );

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 items-center py-3 border-b last:border-b-0 text-sm">
      <div className="min-w-0">
        <p className="font-medium truncate">{record.name || <span className="text-muted-foreground italic">Unnamed</span>}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Created {fmt(record.created_at)}
          {record.last_used_at && <> · Last used {fmt(record.last_used_at)}</>}
          {record.consume_once && record.bound_identity && (
            <> · Bound to {record.bound_identity}</>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {permBadge}
        {record.consume_once && (
          <Badge variant="outline" className="text-amber-600 border-amber-300">
            Once
          </Badge>
        )}
      </div>
      <div>{statusBadge}</div>
      <div className="w-px h-5 bg-border" />
      {!record.revoked ? (
        confirming ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => { onRevoke(record.key); setConfirming(false); }}
            >
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-4" />
            Revoke
          </Button>
        )
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Created key reveal dialog (shown once after generation)
// ---------------------------------------------------------------------------

function CreatedKeyDialog({
  record,
  onClose,
}: {
  record: ApiKeyRecord | null;
  onClose: () => void;
}) {
  const { copied, copy } = useCopy();

  if (!record) return null;

  const shareUrl = `${window.location.origin}/?key=${encodeURIComponent(record.key)}`;

  return (
    <Dialog open={!!record} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-emerald-500" />
            Key Created
          </DialogTitle>
          <DialogDescription>
            Copy this key now — it will not be shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>API Key</Label>
            <div className="flex gap-2">
              <Input readOnly value={record.key} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy(record.key, "key")}
                className="shrink-0"
              >
                {copied === "key" ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Shareable Link</Label>
            <div className="flex gap-2">
              <Input readOnly value={shareUrl} className="font-mono text-xs text-muted-foreground" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy(shareUrl, "link")}
                className="shrink-0"
              >
                {copied === "link" ? (
                  <Check className="size-4 text-emerald-500" />
                ) : (
                  <Link className="size-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Opening this link automatically applies the API key.
            </p>
          </div>

          <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground space-y-0.5">
            <p><span className="font-medium text-foreground">Permissions:</span> {record.permissions === "contribute" ? "Read & Contribute" : "Read only"}</p>
            <p><span className="font-medium text-foreground">Consume once:</span> {record.consume_once ? "Yes — binds to the first user's IP" : "No — shareable"}</p>
          </div>
        </div>

        <Button onClick={onClose} className="w-full">Done</Button>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Generate key dialog
// ---------------------------------------------------------------------------

function GenerateKeyDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (record: ApiKeyRecord) => void;
}) {
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<"read" | "contribute">("read");
  const [consumeOnce, setConsumeOnce] = useState(false);
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: createApiKey,
    onSuccess: (record) => {
      onCreate(record);
      setName("");
      setPermissions("read");
      setConsumeOnce(false);
      setError("");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function handleSubmit() {
    if (!name.trim()) { setError("Name is required"); return; }
    setError("");
    mutation.mutate({ name: name.trim(), permissions, consume_once: consumeOnce });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Generate API Key</DialogTitle>
          <DialogDescription>New keys are active immediately.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="key-name">Name / Note <span className="text-destructive">*</span></Label>
            <Input
              id="key-name"
              placeholder="e.g. Server regulars, Friend Alex"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Permissions</Label>
            <Select value={permissions} onValueChange={(v) => setPermissions(v as "read" | "contribute")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read only</SelectItem>
                <SelectItem value="contribute">Read &amp; Contribute</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Consume once</p>
              <p className="text-xs text-muted-foreground">
                Binds to the first user's IP; rejects others.
              </p>
            </div>
            <Switch
              checked={consumeOnce}
              onCheckedChange={setConsumeOnce}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending} className="flex-1">
            {mutation.isPending ? "Generating…" : "Generate"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyRecord | null>(null);

  const { data: keys = [], isLoading, error } = useQuery<ApiKeyRecord[]>({
    queryKey: ["admin-api-keys"],
    queryFn: listApiKeys,
  });

  const revokeMutation = useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-api-keys"] }),
  });

  function handleCreated(record: ApiKeyRecord) {
    queryClient.invalidateQueries({ queryKey: ["admin-api-keys"] });
    setCreatedKey(record);
  }

  const active = keys.filter((k) => !k.revoked);
  const revoked = keys.filter((k) => k.revoked);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">API Keys</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage access keys for this service.
          </p>
        </div>
        <Button onClick={() => setGenerateOpen(true)}>
          <Plus className="size-4" />
          Generate Key
        </Button>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Loading keys…
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            {(error as Error).message}
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Active ({active.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {active.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No active keys. Generate one to get started.
                </p>
              ) : (
                active.map((k) => (
                  <KeyRow
                    key={k.key}
                    record={k}
                    onRevoke={(key) => revokeMutation.mutate(key)}
                  />
                ))
              )}
            </CardContent>
          </Card>

          {revoked.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-muted-foreground">
                  Revoked ({revoked.length})
                </CardTitle>
                <CardDescription>These keys no longer work.</CardDescription>
              </CardHeader>
              <CardContent className="opacity-60">
                {revoked.map((k) => (
                  <KeyRow
                    key={k.key}
                    record={k}
                    onRevoke={() => {}}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <GenerateKeyDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onCreate={handleCreated}
      />

      <CreatedKeyDialog
        record={createdKey}
        onClose={() => setCreatedKey(null)}
      />
    </div>
  );
}
