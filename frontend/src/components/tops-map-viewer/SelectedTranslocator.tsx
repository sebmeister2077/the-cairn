import { Pin, PinOff, X } from "lucide-react";
import type { WorldLineSegment } from "../MapViewer";
import { Button } from "@/components/ui/button";

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
  if (!selectedTranslocator) return null;
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
