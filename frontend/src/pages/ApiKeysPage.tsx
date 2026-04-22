import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, MailOpen } from "lucide-react";
import {
  listApiKeys, revokeApiKey, type ApiKeyRecord,
  listInviteLinks, revokeInviteLink, type InviteLinkRecord,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { KeyRow } from "@/components/ApiKeyRow";
import { CreatedKeyDialog } from "@/components/CreatedKeyDialog";
import { GenerateKeyDialog } from "@/components/GenerateKeyDialog";
import { InviteLinkRow } from "@/components/InviteLinkRow";
import { CreateInviteLinkDialog } from "@/components/CreateInviteLinkDialog";
import { CreatedInviteLinkDialog } from "@/components/CreatedInviteLinkDialog";

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyRecord | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<InviteLinkRecord | null>(null);

  const { data: keys = [], isLoading, error } = useQuery<ApiKeyRecord[]>({
    queryKey: ["admin-api-keys"],
    queryFn: listApiKeys,
  });

  const { data: inviteLinks = [] } = useQuery<InviteLinkRecord[]>({
    queryKey: ["admin-invite-links"],
    queryFn: listInviteLinks,
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
    queryClient.invalidateQueries({ queryKey: ["admin-api-keys"] });
    setCreatedKey(record);
  }

  function handleInviteCreated(record: InviteLinkRecord) {
    queryClient.invalidateQueries({ queryKey: ["admin-invite-links"] });
    setCreatedInvite(record);
  }

  const active = keys.filter((k) => !k.revoked);
  const revoked = keys.filter((k) => k.revoked);
  const activeInvites = inviteLinks.filter((l) => !l.revoked);
  const revokedInvites = inviteLinks.filter((l) => l.revoked);

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

      <Separator />

      {/* Invite Links Section */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Invite Links</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Share a link — anyone who opens it can claim a new API key automatically.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <MailOpen className="size-4" />
          Create Invite Link
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Active Invite Links ({activeInvites.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {activeInvites.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No active invite links. Create one to share access with a group.
            </p>
          ) : (
            activeInvites.map((l) => (
              <InviteLinkRow
                key={l.token}
                record={l}
                onRevoke={(token) => revokeInviteMutation.mutate(token)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {revokedInvites.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-muted-foreground">
              Revoked Invite Links ({revokedInvites.length})
            </CardTitle>
            <CardDescription>These invite links no longer work.</CardDescription>
          </CardHeader>
          <CardContent className="opacity-60">
            {revokedInvites.map((l) => (
              <InviteLinkRow key={l.token} record={l} onRevoke={() => {}} />
            ))}
          </CardContent>
        </Card>
      )}

      <CreateInviteLinkDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreate={handleInviteCreated}
      />

      <CreatedInviteLinkDialog
        record={createdInvite}
        onClose={() => setCreatedInvite(null)}
      />
    </div>
  );
}
