import { useState } from "react";
import { Check, Copy, Pin, PinOff, X } from "lucide-react";
import type { WorldLineSegment } from "../MapViewer";
import { Button } from "@/components/ui/button";

// Y coordinate used for the generated /waypoint commands. Translocator
// endpoints are stored as 2D coords on the tops map, so we pin Y to a
// reasonable surface value — the user can always edit the waypoint in-game.
const WAYPOINT_Y = 110;

function buildWaypointCommands(seg: WorldLineSegment): string {
  const { x1, z1, x2, z2 } = seg;
  return [
    `/waypoint addati spiral ${x1} ${WAYPOINT_Y} ${z1} false purple TL to ${x2} ${z2}`,
    `/waypoint addati spiral ${x2} ${WAYPOINT_Y} ${z2} false purple TL to ${x1} ${z1}`,
  ].join("\n");
}

export function SelectedTranslocatorHeader({
  selectedTranslocator,
  translocatorPinned,
  handleUnpinTranslocator,
  onClose,
}: {
  selectedTranslocator: WorldLineSegment | null;
  translocatorPinned: boolean;
  handleUnpinTranslocator: () => void;
  /**
   * Optional dismiss handler. When provided, the card renders a close (X)
   * button so the user can hide the floating overlay without having to
   * click an empty area of the map.
   */
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!selectedTranslocator) return null;

  const handleCopyWaypointCommands = async () => {
    if (!selectedTranslocator) return;
    const text = buildWaypointCommands(selectedTranslocator);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts / older browsers.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silently ignore — clipboard may be blocked by permissions.
    }
  };
  // User-contributed TLs carry attribution + a "User" badge so reviewers can
  // tell at a glance whether a segment came from a community submission.
  const meta = selectedTranslocator.kind === "user" ? selectedTranslocator.meta : undefined;
  const addedAtLabel = (() => {
    if (!meta?.addedAt) return null;
    const d = new Date(meta.addedAt);
    return Number.isNaN(d.getTime()) ? meta.addedAt : d.toLocaleString();
  })();
  return (
    // Floating card: positioned absolutely over the bottom-left of the map
    // so it doesn't shift the page layout when a translocator is selected.
    // `pointer-events-auto` is set explicitly because callers may wrap this
    // in a `pointer-events-none` overlay layer.
    <div
      className={[
        "absolute left-2 bottom-2 z-20 max-w-[min(calc(100%-1rem),36rem)]",
        "pointer-events-auto",
        "flex flex-wrap items-center gap-x-4 gap-y-1",
        "text-sm text-muted-foreground",
        "rounded-md border bg-card/95 backdrop-blur shadow-lg",
        "px-3 py-2",
      ].join(" ")}
    >
      {selectedTranslocator.kind === "user" && (
        <span
          className="rounded bg-blue-600/15 text-blue-700 dark:text-blue-300 text-xs font-medium px-2 py-0.5"
          title="User-contributed translocator"
        >
          User
        </span>
      )}
      <span>
        Start:{" "}
        <span className="font-medium text-foreground">
          X {selectedTranslocator.x1.toLocaleString()}, Z {selectedTranslocator.z1.toLocaleString()}
        </span>
      </span>
      <span>
        End:{" "}
        <span className="font-medium text-foreground">
          X {selectedTranslocator.x2.toLocaleString()}, Z {selectedTranslocator.z2.toLocaleString()}
        </span>
      </span>
      {meta?.addedBy && (
        <span className="text-xs">
          Added by <span className="font-medium text-foreground">{meta.addedBy}</span>
          {addedAtLabel && (
            <>
              {" "}
              on <span className="font-medium text-foreground">{addedAtLabel}</span>
            </>
          )}
        </span>
      )}
      {translocatorPinned ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleUnpinTranslocator}
          title="Unpin translocator (also unpins on clicking another TL)"
          className="h-7 px-2 text-foreground"
        >
          <Pin className="size-4 mr-1 fill-current" />
          Pinned
          <PinOff className="size-4 ml-1" />
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">Right-click a TL to pin</span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleCopyWaypointCommands}
        title={`Copy /waypoint commands for both endpoints to clipboard`}
        className="h-7 px-2 text-foreground"
      >
        {copied ? (
          <>
            <Check className="size-4 mr-1" />
            Copied
          </>
        ) : (
          <>
            <Copy className="size-4 mr-1" />
            Copy waypoints
          </>
        )}
      </Button>
      {onClose && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Dismiss selected translocator"
          title="Dismiss"
          className="ml-1"
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
