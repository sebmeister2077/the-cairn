import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface Waypoint {
  title?: string;
  icon?: string;
  color?: string;
  x?: number;
  y?: number;
  z?: number;
  owner?: string;
  pinned?: boolean;
  guid?: string;
}

export function WaypointTable({ waypoints }: { waypoints: Waypoint[] }) {
  if (waypoints.length === 0) {
    return <p className="text-muted-foreground text-sm">No waypoints found.</p>;
  }

  return (
    <div className="rounded-md border overflow-auto max-h-[500px]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Icon</TableHead>
            <TableHead>Color</TableHead>
            <TableHead>X</TableHead>
            <TableHead>Y</TableHead>
            <TableHead>Z</TableHead>
            <TableHead>Pinned</TableHead>
            <TableHead>Owner</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {waypoints.map((wp, i) => (
            <TableRow key={wp.guid ?? i}>
              <TableCell>{wp.title ?? ""}</TableCell>
              <TableCell>{wp.icon ?? ""}</TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-4 h-4 rounded border"
                    style={{ backgroundColor: wp.color ? `#${wp.color.replace("#", "").slice(-6)}` : "#ccc" }}
                  />
                  {wp.color ?? ""}
                </span>
              </TableCell>
              <TableCell>{wp.x != null ? Math.round(wp.x) : ""}</TableCell>
              <TableCell>{wp.y != null ? Math.round(wp.y) : ""}</TableCell>
              <TableCell>{wp.z != null ? Math.round(wp.z) : ""}</TableCell>
              <TableCell>
                {wp.pinned != null && (
                  <Badge variant={wp.pinned ? "default" : "secondary"}>
                    {wp.pinned ? "Yes" : "No"}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-xs truncate max-w-[120px]">
                {wp.owner ?? ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
