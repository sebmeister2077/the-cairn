import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import type { FeatureFlag } from "@/lib/api";
import {
  Info,
  AlertTriangle,
  CheckCircle2,
  Wrench,
  Upload,
  Archive,
  Cpu,
  UserPlus,
} from "lucide-react";
import { type ReactNode, useState } from "react";

type IconType = typeof Wrench;

interface OperationalFlagSpec {
  key: string;
  label: string;
  icon: IconType;
  /** What turning the switch ON does. */
  whenOn: string;
  /** What turning the switch OFF does. */
  whenOff: string;
  /** Default value when no row exists in the DB (matches the backend). */
  defaultEnabled: boolean;
  /** Tone shown next to the toggle when the flag is in its "alarm" state. */
  alarmState: "on" | "off";
  alarmText: string;
  /**
   * Visual severity of the alarm state. "danger" (default) draws an amber
   * border + destructive badge + destructive confirm dialog. "info" uses a
   * neutral blue accent for flags whose alarm state is merely informational
   * (e.g. an opt-in optimization being active, not a kill switch tripped).
   */
  alarmTone?: "danger" | "info";
  /** Optional additional caveat — surfaced in a callout. */
  caveat?: string;
}

export const OPERATIONAL_FLAGS: OperationalFlagSpec[] = [
  {
    key: "maintenance_mode",
    label: "Maintenance mode",
    icon: Wrench,
    defaultEnabled: false,
    whenOn:
      "All POST/PUT/PATCH/DELETE requests from non-admin users return HTTP 503. " +
      "Read-only browsing (map viewer, contribution history, public stats) keeps working. " +
      "Admin endpoints (/api/admin/*) and the env-var admin key remain fully writable so you can disable the flag without locking yourself out.",
    whenOff: "Normal operation — writes flow through as usual.",
    alarmState: "on",
    alarmText: "site is in maintenance mode",
    caveat:
      "Use this for short windows (DB migration, R2 maintenance, incident triage). " +
      "Long-running maintenance should also be communicated on the General page.",
  },
  {
    key: "uploads_enabled",
    label: "Map contributions",
    icon: Upload,
    defaultEnabled: true,
    whenOn: "Players with the contribute permission can upload .db files via the Contribute page.",
    whenOff:
      "POST /api/contribute, /contribute/upload-url, and /contribute/complete return HTTP 503 for non-admin callers. " +
      "Approving / rejecting / reverting existing pending contributions still works. " +
      "Admins can still upload (e.g. while backfilling after an incident).",
    alarmState: "off",
    alarmText: "uploads disabled",
    caveat:
      "Flip OFF during a contribution-driven incident (spam wave, disk near full, R2 quota issue). " +
      "Existing pending contributions are not affected — only new submissions.",
  },
  {
    key: "registration_enabled",
    label: "New account registration",
    icon: UserPlus,
    defaultEnabled: true,
    whenOn: "Users with a freshly claimed invite key can complete /api/account/register.",
    whenOff:
      "POST /api/account/register returns HTTP 503. Existing accounts continue to work (login, profile edits, contributions). " +
      "Invite links can still be claimed (a key is issued) but the user cannot create an account row until this is re-enabled.",
    alarmState: "off",
    alarmText: "registration disabled",
    caveat:
      "Useful when a sibling-account / shared-IP wave needs to be triaged before more accounts join. " +
      "Pre-existing static API keys (env-var) bypass registration entirely.",
  },
  {
    key: "heavy_compute_enabled",
    label: "Heavy compute (previews, validation, match score)",
    icon: Cpu,
    defaultEnabled: true,
    whenOn:
      "Preview rendering, upload validation, and match-score computation run normally for every caller. " +
      "This is the right setting whenever the server has the RAM/CPU & disk space to spare.",
    whenOff:
      "/contribute/preview and /contribute/preview-region requests return HTTP 503. " +
      "New uploads are still accepted but the validate_uploads and match-score workers are NOT auto-spawned \u2014 rows pile up in 'pending' until the bulk-run button below is pressed. " +
      "Already-running workers continue to drain whatever they were processing. ",
    alarmState: "off",
    alarmText: "heavy compute paused",
    caveat:
      "Flip OFF when the production server is too small for the per-request workload (multi-GB DB downloads, OOM during previews) and you want an admin on a beefier machine to drain pending work in batches via the button below.",
  },
  {
    key: "compress_artefacts",
    label: "Zstd compression of R2 artefacts",
    icon: Archive,
    defaultEnabled: false,
    whenOn:
      "All NEW writes to weekly backups, archived per-contribution .db files, and undo " +
      "replaced.db files are stored as .zst (single form, no raw sibling). The combined " +
      "globalservermap.db is uploaded raw AND a .zst sibling is produced in the background " +
      "(latest-wins) so cache-miss reads can prefer the smaller .zst when its source-etag " +
      "matches the live raw ETag. Flipping ON for the first time also kicks an eager " +
      "migration that converts every still-retained archived/undo .db to .zst (paused when " +
      "heavy compute is OFF). Readers transparently support both forms forever.",
    whenOff:
      "All artefacts are written as raw .db / .bin (current behaviour). Existing .zst " +
      "artefacts continue to be readable — flipping OFF does NOT rehydrate them. Use this " +
      "as a kill switch if a compression bug is suspected.",
    alarmState: "on",
    alarmText: "compression active",
    alarmTone: "info",
    caveat:
      "Compression level + thread budget are tuned in the panel below (visible only when " +
      "the flag is ON). Higher levels use more CPU per write but produce smaller files; " +
      "the eager migration honours the heavy-compute kill switch.",
  },
];

export function OperationalFlagCard({
  spec,
  flag,
  pending,
  onToggle,
  extra,
}: {
  spec: OperationalFlagSpec;
  flag: FeatureFlag | undefined;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  extra?: ReactNode;
}) {
  const enabled = flag ? flag.enabled : spec.defaultEnabled;
  const inAlarm = (spec.alarmState === "on" && enabled) || (spec.alarmState === "off" && !enabled);
  const tone = spec.alarmTone ?? "danger";
  const Icon = spec.icon;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  // Toggling into alarm state (e.g. enabling maintenance, disabling uploads)
  // is destructive enough that we want a confirmation.
  function handleToggle(next: boolean) {
    const willBeAlarm = (spec.alarmState === "on" && next) || (spec.alarmState === "off" && !next);
    if (willBeAlarm) {
      setPendingValue(next);
      setConfirmOpen(true);
      return;
    }
    onToggle(next);
  }

  const alarmBorderClass = inAlarm
    ? tone === "info"
      ? "border-sky-500"
      : "border-amber-500"
    : undefined;

  return (
    <Card className={alarmBorderClass}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4" />
            {spec.label}
            <Badge variant="outline" className="font-mono text-[10px]">
              {spec.key}
            </Badge>
          </span>
          <span className="flex items-center gap-2">
            {inAlarm ? (
              tone === "info" ? (
                <Badge variant="outline" className="gap-1 text-sky-600 border-sky-500/40">
                  <Info className="h-3 w-3" />
                  {spec.alarmText}
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {spec.alarmText}
                </Badge>
              )
            ) : (
              <Badge variant="outline" className="gap-1 text-emerald-600 border-emerald-500/40">
                <CheckCircle2 className="h-3 w-3" />
                normal
              </Badge>
            )}
            <Switch
              checked={enabled}
              disabled={pending}
              onCheckedChange={(v) => handleToggle(Boolean(v))}
            />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid gap-1 sm:grid-cols-2">
          <div className="rounded border p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
              When ON
            </div>
            <p className="text-xs">{spec.whenOn}</p>
          </div>
          <div className="rounded border p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
              When OFF
            </div>
            <p className="text-xs">{spec.whenOff}</p>
          </div>
        </div>
        {spec.caveat && (
          <p className="text-[11px] text-muted-foreground italic flex gap-1">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-amber-600" />
            {spec.caveat}
          </p>
        )}
        {flag && (
          <p className="text-[10px] text-muted-foreground">
            Last changed {new Date(flag.updated_at).toLocaleString()}
            {flag.updated_by_suffix ? ` by …${flag.updated_by_suffix}` : ""}
          </p>
        )}
        {!flag && (
          <p className="text-[10px] text-muted-foreground">
            Default value (no row in DB yet — first toggle creates one).
          </p>
        )}
        {extra}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        title={`${pendingValue ? "Enable" : "Disable"} ${spec.label}?`}
        description={
          spec.alarmState === "on" && pendingValue
            ? spec.whenOn
            : spec.alarmState === "off" && !pendingValue
              ? spec.whenOff
              : ""
        }
        confirmLabel={pendingValue ? "Enable" : "Disable"}
        variant={tone === "info" ? "default" : "destructive"}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingValue(null);
        }}
        onConfirm={() => {
          if (pendingValue !== null) onToggle(pendingValue);
          setConfirmOpen(false);
          setPendingValue(null);
        }}
      />
    </Card>
  );
}
