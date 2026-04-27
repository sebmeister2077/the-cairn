import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  MailOpen,
  Search,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  listApiKeys,
  revokeApiKey,
  type ApiKeyRecord,
  listInviteLinks,
  revokeInviteLink,
  type InviteLinkRecord,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { KeyRow } from "@/components/ApiKeyRow";
import { CreatedKeyDialog } from "@/components/CreatedKeyDialog";
import { GenerateKeyDialog } from "@/components/GenerateKeyDialog";
import { InviteLinkRow } from "@/components/InviteLinkRow";
import { CreateInviteLinkDialog } from "@/components/CreateInviteLinkDialog";
import { CreatedInviteLinkDialog } from "@/components/CreatedInviteLinkDialog";

const PAGE_SIZE = 50;

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

type Page<T> = { items: T[]; total: number; next_offset: number | null };

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyRecord | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<InviteLinkRecord | null>(null);

  // --- Active keys ---
  const [activeKeysQ, setActiveKeysQ] = useState("");
  const debouncedActiveKeysQ = useDebounced(activeKeysQ);
  const activeKeys = useInfiniteQuery<Page<ApiKeyRecord>>({
    queryKey: ["admin-api-keys", "active", debouncedActiveKeysQ],
    queryFn: ({ pageParam = 0 }) =>
      listApiKeys({
        status: "active",
        q: debouncedActiveKeysQ,
        offset: pageParam as number,
        limit: PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset,
  });

  // --- Revoked keys (collapsed by default) ---
  const [showRevokedKeys, setShowRevokedKeys] = useState(false);
  const [revokedKeysQ, setRevokedKeysQ] = useState("");
  const debouncedRevokedKeysQ = useDebounced(revokedKeysQ);
  const revokedKeys = useInfiniteQuery<Page<ApiKeyRecord>>({
    queryKey: ["admin-api-keys", "revoked", debouncedRevokedKeysQ],
    queryFn: ({ pageParam = 0 }) =>
      listApiKeys({
        status: "revoked",
        q: debouncedRevokedKeysQ,
        offset: pageParam as number,
        limit: PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset,
    enabled: showRevokedKeys,
  });

  // --- Active invite links ---
  const [activeInvitesQ, setActiveInvitesQ] = useState("");
  const debouncedActiveInvitesQ = useDebounced(activeInvitesQ);
  const activeInvites = useInfiniteQuery<Page<InviteLinkRecord>>({
    queryKey: ["admin-invite-links", "active", debouncedActiveInvitesQ],
    queryFn: ({ pageParam = 0 }) =>
      listInviteLinks({
        status: "active",
        q: debouncedActiveInvitesQ,
        offset: pageParam as number,
        limit: PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset,
  });

  // --- Revoked invite links (collapsed by default) ---
  const [showRevokedInvites, setShowRevokedInvites] = useState(false);
  const [revokedInvitesQ, setRevokedInvitesQ] = useState("");
  const debouncedRevokedInvitesQ = useDebounced(revokedInvitesQ);
  const revokedInvites = useInfiniteQuery<Page<InviteLinkRecord>>({
    queryKey: ["admin-invite-links", "revoked", debouncedRevokedInvitesQ],
    queryFn: ({ pageParam = 0 }) =>
      listInviteLinks({
        status: "revoked",
        q: debouncedRevokedInvitesQ,
        offset: pageParam as number,
        limit: PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset,
    enabled: showRevokedInvites,
  });

  const revokeMutation = useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-api-keys"] }),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: revokeInviteLink,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-invite-links"] }),
  });

  function handleCreated(record: ApiKeyRecord) {
    queryClient.refetchQueries({ queryKey: ["admin-api-keys"] });
    setCreatedKey(record);
  }

  function handleInviteCreated(record: InviteLinkRecord) {
    queryClient.refetchQueries({ queryKey: ["admin-invite-links"] });
    setCreatedInvite(record);
  }

  const activeKeyItems = activeKeys.data?.pages.flatMap((p) => p.items) ?? [];
  const revokedKeyItems = revokedKeys.data?.pages.flatMap((p) => p.items) ?? [];
  const activeInviteItems = activeInvites.data?.pages.flatMap((p) => p.items) ?? [];
  const revokedInviteItems = revokedInvites.data?.pages.flatMap((p) => p.items) ?? [];

  const activeKeysTotal = activeKeys.data?.pages[0]?.total ?? 0;
  const revokedKeysTotal = revokedKeys.data?.pages[0]?.total ?? 0;
  const activeInvitesTotal = activeInvites.data?.pages[0]?.total ?? 0;
  const revokedInvitesTotal = revokedInvites.data?.pages[0]?.total ?? 0;

  return (
    <div className="space-y-6">
      {/* API Keys Section */}
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

      {activeKeys.error && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            {(activeKeys.error as Error).message}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Active{activeKeys.isSuccess ? ` (${activeKeyItems.length} of ${activeKeysTotal})` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SearchInput
            value={activeKeysQ}
            onChange={setActiveKeysQ}
            placeholder="Search by name or key…"
          />
          {activeKeys.isLoading ? (
            <LoadingRow />
          ) : activeKeyItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {activeKeysQ ? "No matching keys." : "No active keys. Generate one to get started."}
            </p>
          ) : (
            <>
              <div>
                {activeKeyItems.map((k) => (
                  <KeyRow key={k.key} record={k} onRevoke={(key) => revokeMutation.mutate(key)} />
                ))}
              </div>
              <LoadMoreButton query={activeKeys} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <button
            type="button"
            className="flex items-center gap-1 text-left"
            onClick={() => setShowRevokedKeys((v) => !v)}
          >
            {showRevokedKeys ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            <CardTitle className="text-base text-muted-foreground">
              Revoked
              {showRevokedKeys && revokedKeys.isSuccess
                ? ` (${revokedKeyItems.length} of ${revokedKeysTotal})`
                : ""}
            </CardTitle>
          </button>
          {showRevokedKeys && <CardDescription>These keys no longer work.</CardDescription>}
        </CardHeader>
        {showRevokedKeys && (
          <CardContent className="space-y-3 opacity-80">
            <SearchInput
              value={revokedKeysQ}
              onChange={setRevokedKeysQ}
              placeholder="Search revoked keys…"
            />
            {revokedKeys.isLoading ? (
              <LoadingRow />
            ) : revokedKeyItems.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {revokedKeysQ ? "No matching revoked keys." : "No revoked keys."}
              </p>
            ) : (
              <>
                <div>
                  {revokedKeyItems.map((k) => (
                    <KeyRow key={k.key} record={k} onRevoke={() => {}} />
                  ))}
                </div>
                <LoadMoreButton query={revokedKeys} />
              </>
            )}
          </CardContent>
        )}
      </Card>

      <GenerateKeyDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onCreate={handleCreated}
      />

      <CreatedKeyDialog record={createdKey} onClose={() => setCreatedKey(null)} />

      <Separator />

      {/* Invite Links Section */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Invite Links</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Share a link — anyone who opens it can claim a new API key automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => activeInvites.refetch()}
            disabled={activeInvites.isFetching}
            title="Refresh active invite links"
          >
            <RefreshCw className={activeInvites.isFetching ? "size-3 animate-spin" : "size-3"} />
            Refresh
          </Button>
          <Button onClick={() => setInviteOpen(true)}>
            <MailOpen className="size-4" />
            Create Invite Link
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Active Invite Links
            {activeInvites.isSuccess
              ? ` (${activeInviteItems.length} of ${activeInvitesTotal})`
              : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SearchInput
            value={activeInvitesQ}
            onChange={setActiveInvitesQ}
            placeholder="Search by name or token…"
          />
          {activeInvites.isLoading ? (
            <LoadingRow />
          ) : activeInviteItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {activeInvitesQ
                ? "No matching invite links."
                : "No active invite links. Create one to share access with a group."}
            </p>
          ) : (
            <>
              <div>
                {activeInviteItems.map((l) => (
                  <InviteLinkRow
                    key={l.token}
                    record={l}
                    onRevoke={(token) => revokeInviteMutation.mutate(token)}
                  />
                ))}
              </div>
              <LoadMoreButton query={activeInvites} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <button
            type="button"
            className="flex items-center gap-1 text-left"
            onClick={() => setShowRevokedInvites((v) => !v)}
          >
            {showRevokedInvites ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            <CardTitle className="text-base text-muted-foreground">
              Revoked Invite Links
              {showRevokedInvites && revokedInvites.isSuccess
                ? ` (${revokedInviteItems.length} of ${revokedInvitesTotal})`
                : ""}
            </CardTitle>
          </button>
          {showRevokedInvites && (
            <CardDescription>These invite links no longer work.</CardDescription>
          )}
        </CardHeader>
        {showRevokedInvites && (
          <CardContent className="space-y-3 opacity-80">
            <SearchInput
              value={revokedInvitesQ}
              onChange={setRevokedInvitesQ}
              placeholder="Search revoked invite links…"
            />
            {revokedInvites.isLoading ? (
              <LoadingRow />
            ) : revokedInviteItems.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {revokedInvitesQ ? "No matching revoked invite links." : "No revoked invite links."}
              </p>
            ) : (
              <>
                <div>
                  {revokedInviteItems.map((l) => (
                    <InviteLinkRow key={l.token} record={l} onRevoke={() => {}} />
                  ))}
                </div>
                <LoadMoreButton query={revokedInvites} />
              </>
            )}
          </CardContent>
        )}
      </Card>

      <CreateInviteLinkDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreate={handleInviteCreated}
      />

      <CreatedInviteLinkDialog record={createdInvite} onClose={() => setCreatedInvite(null)} />
    </div>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-7"
      />
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center justify-center py-6">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </div>
  );
}

function LoadMoreButton({
  query,
}: {
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => void;
  };
}) {
  if (!query.hasNextPage) return null;
  return (
    <div className="pt-2 flex justify-center">
      <Button
        size="sm"
        variant="outline"
        disabled={query.isFetchingNextPage}
        onClick={() => query.fetchNextPage()}
      >
        {query.isFetchingNextPage ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </>
        ) : (
          "Load more"
        )}
      </Button>
    </div>
  );
}
