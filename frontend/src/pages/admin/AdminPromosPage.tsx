/**
 * Admin / promo-manager: Promo events page (route: /manage/promos).
 *
 * Create, edit, activate (one at a time), expire and delete the site-wide
 * promotion banner. Accessible to admins and to any user holding the
 * ``manage_promos`` permission.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  adminCreatePromo,
  adminDeletePromo,
  adminListPromos,
  adminUpdatePromo,
  adminUploadPromoImage,
  promoImageSrc,
  type PromoContent,
  type PromoEvent,
  type PromoScheduleRow,
} from "@/lib/helpers/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromoEditorDialog } from "@/components/admin/promos/PromoEditorDialog";

// --- Page --------------------------------------------------------------------

export function AdminPromosPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-promos"],
    queryFn: adminListPromos,
  });
  const promos = useMemo(() => data?.promos ?? [], [data]);

  const [editing, setEditing] = useState<PromoEvent | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PromoEvent | null>(null);

  const activeMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      adminUpdatePromo(id, { active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-promos"] });
      queryClient.invalidateQueries({ queryKey: ["active-promo"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => adminDeletePromo(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-promos"] });
      queryClient.invalidateQueries({ queryKey: ["active-promo"] });
      setDeleteTarget(null);
    },
  });

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (p: PromoEvent) => {
    setEditing(p);
    setEditorOpen(true);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle>Promo events</CardTitle>
            <p className="text-sm text-muted-foreground">
              Create and manage the site-wide promotion banner. Only one promo is active at a time.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" /> New promo
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : isError ? (
            <p className="text-sm text-destructive">Failed to load promos.</p>
          ) : promos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No promos yet.</p>
          ) : (
            promos.map((p) => {
              const expired = p.expires_at != null && Date.now() >= Date.parse(p.expires_at);
              const thumb = promoImageSrc(p);
              return (
                <div key={p.id} className="flex items-start gap-3 rounded-lg border p-3">
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="size-14 shrink-0 rounded object-cover border border-border"
                    />
                  ) : (
                    <div className="size-14 shrink-0 rounded border border-dashed border-border" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{p.title}</span>
                      {p.active ? (
                        <Badge className="bg-emerald-600 hover:bg-emerald-600">Active</Badge>
                      ) : null}
                      {expired ? <Badge variant="secondary">Expired</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {p.expires_at
                        ? `Expires ${new Date(p.expires_at).toLocaleString()}`
                        : "No expiry"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Active
                      <Switch
                        checked={p.active}
                        disabled={activeMut.isPending}
                        onCheckedChange={(v) => activeMut.mutate({ id: p.id, active: Boolean(v) })}
                      />
                    </label>
                    <Button size="sm" variant="outline" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete promo"
                      onClick={() => setDeleteTarget(p)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <PromoEditorDialog open={editorOpen} promo={editing} onClose={() => setEditorOpen(false)} />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete promo?"
        description={
          deleteTarget ? `“${deleteTarget.title}” will be permanently deleted.` : undefined
        }
        variant="destructive"
        confirmLabel="Delete"
        loading={deleteMut.isPending}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
