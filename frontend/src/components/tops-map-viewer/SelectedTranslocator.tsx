import { Pin, PinOff } from "lucide-react";
import type { WorldLineSegment } from "../MapViewer";
import { Button } from "@/components/ui/button";

export function SelectedTranslocatorHeader({
  selectedTranslocator,
  translocatorPinned,
  handleUnpinTranslocator,
}: {
  selectedTranslocator: WorldLineSegment | null;
  translocatorPinned: boolean;
  handleUnpinTranslocator: () => void;
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
    <div className="flex flex-wrap min-h-14 items-center gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
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
      {translocatorPinned && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleUnpinTranslocator}
          title="Unpin translocator (also unpins on clicking another TL)"
          className="ml-auto h-7 px-2 text-foreground"
        >
          <Pin className="size-4 mr-1 fill-current" />
          Pinned
          <PinOff className="size-4 ml-1" />
        </Button>
      )}
      {!translocatorPinned && (
        <span className="ml-auto text-xs text-muted-foreground">Right-click a TL to pin</span>
      )}
    </div>
  );
}
