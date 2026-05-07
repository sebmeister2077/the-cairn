import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LandmarkEditRequest, LandmarkFeature } from "@/lib/api";
import { Pencil } from "lucide-react";

export function LandmarkRow({
  feature,
  ownedByMe,
  onEdit,
}: {
  feature: LandmarkFeature;
  ownedByMe: boolean;
  onEdit: () => void;
}) {
  const [x, z] = feature.geometry.coordinates;
  const y = feature.properties.z;
  const label = feature.properties.label || "(no label)";
  return (
    <div className="flex items-start justify-between gap-2 rounded border p-2">
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium truncate">{label}</div>
        <div className="text-muted-foreground font-mono text-[11px]">
          ({x}, {z}
          {y != null ? `, y=${y}` : ""}) · {feature.properties.type}
          {!ownedByMe && (
            <Badge variant="outline" className="ml-1">
              seed
            </Badge>
          )}
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit} title="Rename">
        <Pencil className="size-3" />
      </Button>
    </div>
  );
}

export function PendingRequestRow({ request }: { request: LandmarkEditRequest }) {
  return (
    <div className="rounded border p-2 space-y-0.5">
      <div className="flex items-center gap-1">
        <Badge variant="secondary" className="text-[10px]">
          {request.status}
        </Badge>
        <span className="text-muted-foreground text-[11px]">
          {new Date(request.created_at).toLocaleString()}
        </span>
      </div>
      <div className="text-[11px]">
        <span className="text-muted-foreground">"{request.current_label}"</span>
        {" → "}
        <span className="font-medium">"{request.proposed_label}"</span>
      </div>
    </div>
  );
}
