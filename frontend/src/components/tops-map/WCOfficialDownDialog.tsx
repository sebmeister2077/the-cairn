import { LifeBuoy, ServerCrash } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Tells the dialog what the "Switch" button is going to do, so the copy
 * and the button label can match.
 *  - "cairn":           a dedicated Cairn-hosted mirror is configured
 *                       (`VITE_CAIRN_BACKUP_MAP_URL` or the public bucket).
 *                       Clicking the button flips to the Cairn tab, which
 *                       fetches geojson directly with CORS.
 *  - "alternate-host":  no Cairn mirror configured. The button stays on
 *                       the WebCartographer tab but swaps the host URL to
 *                       a known-good public mirror (translocator.moe) so
 *                       the page keeps working through the proxy.
 */
export type WCBackupKind = "cairn" | "alternate-host";

interface WCOfficialDownDialogProps {
  open: boolean;
  /** Called when the user dismisses the modal without picking an action. */
  onOpenChange: (open: boolean) => void;
  /** Called when the user picks the "Switch" action. */
  onSwitchToBackup: () => void;
  /** Called when the user picks "Don't ask for 10 minutes". */
  onSnooze: () => void;
  /** Disables the switch button when no backup target is reachable. */
  backupAvailable: boolean;
  /** What the switch action will do. Drives button label + body copy. */
  backupKind: WCBackupKind;
  /** Optional status code (e.g. 502) shown for context. */
  statusCode?: number | null;
}

/**
 * Surfaced when the official WebCartographer host returns a 5xx error
 * (typically a 502 from the proxy when the upstream is down). Lets the
 * user either swap to a backup mirror immediately, or silence the prompt
 * for 10 minutes so a brief outage doesn't keep nagging them.
 */
export function WCOfficialDownDialog({
  open,
  onOpenChange,
  onSwitchToBackup,
  onSnooze,
  backupAvailable,
  backupKind,
  statusCode,
}: WCOfficialDownDialogProps) {
  const isCairn = backupKind === "cairn";
  const switchLabel = isCairn ? "Switch to Cairn backup map" : "Switch to translocator.moe mirror";
  const bodyCopy = isCairn
    ? "You can switch to the Cairn-hosted backup mirror to keep browsing — it serves a recent snapshot of the same data with CORS enabled, so translocators and landmarks load directly without the backend proxy."
    : "You can switch to the translocator.moe community mirror to keep browsing. It hosts an independent copy of the same WC pyramid and geojson, served via the same backend proxy.";
  const disabledTitle = isCairn
    ? "Cairn backup map is not configured in this build"
    : "No backup host available";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-xl" showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 pr-6 text-left">
            <ServerCrash className="mt-0.5 size-5 shrink-0 text-destructive" />
            <span className="min-w-0 break-words">
              Official WebCartographer map appears to be down
            </span>
          </DialogTitle>
          <DialogDescription className="text-left">
            We couldn&apos;t reach the official WebCartographer host
            {statusCode ? ` (HTTP ${statusCode})` : ""}. Tiles and overlays may be incomplete or
            missing entirely until it&apos;s back online.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          {bodyCopy}
        </div>

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button type="button" variant="ghost" onClick={onSnooze} className="w-full sm:w-auto">
            Don&apos;t ask for 10 minutes
          </Button>
          <Button
            type="button"
            onClick={onSwitchToBackup}
            disabled={!backupAvailable}
            title={backupAvailable ? undefined : disabledTitle}
            className="w-full sm:w-auto"
          >
            <LifeBuoy className="mr-2 size-4" />
            {switchLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
