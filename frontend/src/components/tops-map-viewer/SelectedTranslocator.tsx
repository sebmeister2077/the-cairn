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
  return (
    <div className="flex flex-wrap min-h-14 items-center gap-x-6 gap-y-1 text-sm text-muted-foreground border rounded-md px-4 py-3">
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
