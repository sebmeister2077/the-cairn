import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  adminCreatePromo,
  adminUpdatePromo,
  adminUploadPromoImage,
  promoImageSrc,
  type PromoContent,
  type PromoEvent,
  type PromoScheduleRow,
} from "@/lib/helpers/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TextArea } from "@/components/ui/textarea";
import { PromoPreview } from "@/components/admin/promos/PromoPreview";

/** ISO-8601 string → ``YYYY-MM-DDTHH:mm`` for a ``datetime-local`` input. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** ``datetime-local`` value → ISO-8601 string (or null when empty/invalid). */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// --- Editor form state -------------------------------------------------------

interface PromoForm {
  title: string;
  subtitle: string;
  summary: string;
  prize: string;
  hosts: string;
  hostedBy: string;
  registration: string;
  discordUrl: string;
  mapUrl: string;
  schedule: PromoScheduleRow[];
  expiresLocal: string;
  active: boolean;
}

function emptyForm(): PromoForm {
  return {
    title: "",
    subtitle: "",
    summary: "",
    prize: "",
    hosts: "",
    hostedBy: "",
    registration: "",
    discordUrl: "",
    mapUrl: "",
    schedule: [],
    expiresLocal: "",
    active: false,
  };
}

function formFromPromo(p: PromoEvent): PromoForm {
  const c = p.content ?? {};
  return {
    title: p.title ?? "",
    subtitle: c.subtitle ?? "",
    summary: c.summary ?? "",
    prize: c.prize ?? "",
    hosts: c.hosts ?? "",
    hostedBy: c.hostedBy ?? "",
    registration: c.registration ?? "",
    discordUrl: c.discordUrl ?? "",
    mapUrl: c.mapUrl ?? "",
    schedule: (c.schedule ?? []).map((r) => ({ ...r })),
    expiresLocal: isoToLocalInput(p.expires_at),
    active: p.active,
  };
}

/** Collapse the flat form fields into the backend ``content`` document. */
function formToContent(f: PromoForm): PromoContent {
  const content: PromoContent = {};
  if (f.subtitle.trim()) content.subtitle = f.subtitle.trim();
  if (f.summary.trim()) content.summary = f.summary.trim();
  if (f.prize.trim()) content.prize = f.prize.trim();
  if (f.hosts.trim()) content.hosts = f.hosts.trim();
  if (f.hostedBy.trim()) content.hostedBy = f.hostedBy.trim();
  if (f.registration.trim()) content.registration = f.registration.trim();
  if (f.discordUrl.trim()) content.discordUrl = f.discordUrl.trim();
  if (f.mapUrl.trim()) content.mapUrl = f.mapUrl.trim();
  const schedule = f.schedule
    .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
    .filter((r) => r.label || r.value);
  if (schedule.length > 0) content.schedule = schedule;
  return content;
}

// --- Small styled multiline input -------------------------------------------

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// --- Editor dialog -----------------------------------------------------------

export function PromoEditorDialog({
  open,
  promo,
  onClose,
}: {
  open: boolean;
  /** Promo being edited, or null for "create new". */
  promo: PromoEvent | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PromoForm>(emptyForm);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Reset the form whenever the dialog opens for a different promo.
  useEffect(() => {
    if (!open) return;
    setForm(promo ? formFromPromo(promo) : emptyForm());
    setImageFile(null);
    setError(null);
    setShowPreview(false);
  }, [open, promo]);

  // A locally-selected image is previewed via an object URL (revoked on change
  // / unmount to avoid leaking); otherwise fall back to the saved banner.
  const existingImage = promo ? promoImageSrc(promo) : null;
  const [pickedImageUrl, setPickedImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!imageFile) {
      setPickedImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setPickedImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);
  const previewImageSrc = pickedImageUrl ?? existingImage;
  const previewContent = useMemo(() => formToContent(form), [form]);

  const patch = <K extends keyof PromoForm>(key: K, value: PromoForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const content = formToContent(form);
      const expires_at = localInputToIso(form.expiresLocal);
      let id = promo?.id;
      if (promo) {
        await adminUpdatePromo(promo.id, {
          title: form.title.trim(),
          content,
          expires_at,
          active: form.active,
        });
      } else {
        const created = await adminCreatePromo({
          title: form.title.trim(),
          content,
          expires_at,
          active: form.active,
        });
        id = created.promo.id;
      }
      if (imageFile && id) {
        await adminUploadPromoImage(id, imageFile);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-promos"] });
      queryClient.invalidateQueries({ queryKey: ["active-promo"] });
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to save promo"),
  });

  const addScheduleRow = () => patch("schedule", [...form.schedule, { label: "", value: "" }]);
  const updateScheduleRow = (i: number, key: keyof PromoScheduleRow, value: string) =>
    patch(
      "schedule",
      form.schedule.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)),
    );
  const removeScheduleRow = (i: number) =>
    patch(
      "schedule",
      form.schedule.filter((_, idx) => idx !== i),
    );

  const canSave = form.title.trim().length > 0 && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{promo ? "Edit promo" : "New promo"}</DialogTitle>
          <DialogDescription>
            The active promo (one at a time) is shown to every visitor in the site-wide banner.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <span className="text-sm font-medium">Preview</span>
            <p className="text-xs text-muted-foreground">
              See how the banner and details dialog look to visitors.
            </p>
          </div>
          <Switch
            checked={showPreview}
            onCheckedChange={(v) => setShowPreview(Boolean(v))}
            aria-label="Toggle preview"
          />
        </div>

        {showPreview ? (
          <PromoPreview title={form.title} content={previewContent} imageSrc={previewImageSrc} />
        ) : (
          <div className="space-y-4">
            <Field label="Title">
              <Input
                value={form.title}
                onChange={(e) => patch("title", e.target.value)}
                placeholder="TOPS Halloween Chiseling Event"
              />
            </Field>

            <Field label="Banner subtitle" hint="Appended after the title in the banner (desktop).">
              <Input
                value={form.subtitle}
                onChange={(e) => patch("subtitle", e.target.value)}
                placeholder="— a TOPS community event. Register by Sep 30."
              />
            </Field>

            <Field label="Summary">
              <TextArea
                rows={7}
                value={form.summary}
                onChange={(e) => patch("summary", e.target.value)}
                placeholder="What the event is about…"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Prize">
                <TextArea
                  rows={3}
                  value={form.prize}
                  onChange={(e) => patch("prize", e.target.value)}
                />
              </Field>
              <Field label="Registration / rules location">
                <TextArea
                  rows={3}
                  value={form.registration}
                  onChange={(e) => patch("registration", e.target.value)}
                />
              </Field>
              <Field label="Hosts / judges">
                <Input value={form.hosts} onChange={(e) => patch("hosts", e.target.value)} />
              </Field>
              <Field label="Hosted by (venue)">
                <Input value={form.hostedBy} onChange={(e) => patch("hostedBy", e.target.value)} />
              </Field>
              <Field label="Announcement URL" hint="External link (e.g. Discord).">
                <Input
                  value={form.discordUrl}
                  onChange={(e) => patch("discordUrl", e.target.value)}
                  placeholder="https://discord.com/…"
                />
              </Field>
              <Field label="In-app map link" hint="e.g. /multiplayer/tops-map?x=-1390&z=-20&zoom=4">
                <Input value={form.mapUrl} onChange={(e) => patch("mapUrl", e.target.value)} />
              </Field>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Schedule</Label>
                <Button type="button" size="xs" variant="secondary" onClick={addScheduleRow}>
                  <Plus className="size-3" /> Add row
                </Button>
              </div>
              {form.schedule.length === 0 ? (
                <p className="text-xs text-muted-foreground">No schedule rows.</p>
              ) : (
                <div className="space-y-2">
                  {form.schedule.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        className="flex-1"
                        value={row.label}
                        placeholder="Registration"
                        onChange={(e) => updateScheduleRow(i, "label", e.target.value)}
                      />
                      <Input
                        className="flex-1"
                        value={row.value}
                        placeholder="Sep 26 – Sep 30, 2026"
                        onChange={(e) => updateScheduleRow(i, "value", e.target.value)}
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Remove row"
                        onClick={() => removeScheduleRow(i)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Expires at"
                hint="Banner auto-hides after this moment. Leave empty to never expire."
              >
                <Input
                  type="datetime-local"
                  value={form.expiresLocal}
                  onChange={(e) => patch("expiresLocal", e.target.value)}
                />
              </Field>
              <Field label="Banner image" hint="PNG / JPEG / WebP / GIF, max 5 MB.">
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
                />
                {imageFile ? (
                  <p className="text-xs text-muted-foreground">Selected: {imageFile.name}</p>
                ) : existingImage ? (
                  <img
                    src={existingImage}
                    alt="Current banner"
                    className="mt-1 max-h-24 rounded border border-border"
                  />
                ) : null}
              </Field>
            </div>

            <label className="flex items-center justify-between gap-3 rounded border p-2">
              <div>
                <div className="text-sm font-medium">Active</div>
                <p className="text-xs text-muted-foreground">
                  Activating this promo deactivates any other active one.
                </p>
              </div>
              <Switch checked={form.active} onCheckedChange={(v) => patch("active", Boolean(v))} />
            </label>
          </div>
        )}

        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {promo ? "Save changes" : "Create promo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
