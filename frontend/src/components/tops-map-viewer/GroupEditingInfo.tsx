import type { TLGrouping } from "@/lib/tl-groupings";
import { Button } from "../ui/button";

export function GroupEditingInfo({
  editingGrouping,
  setEditingGroupingId,
}: {
  editingGrouping: TLGrouping | null;
  setEditingGroupingId: (id: string | null) => void;
}) {
  if (!editingGrouping) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-primary bg-primary/5 px-4 py-3 text-sm">
      <span>
        Editing: <span className="font-medium">{editingGrouping.name}</span>
      </span>
      <span className="text-xs text-muted-foreground">
        Click TLs on the map to add or remove. {editingGrouping.tlIds.length} selected.
      </span>
      <Button
        type="button"
        size="sm"
        variant="default"
        className="ml-auto h-7"
        onClick={() => setEditingGroupingId(null)}
      >
        Done
      </Button>
    </div>
  );
}
