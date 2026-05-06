import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { adminListLandmarkEditRequests } from "@/lib/api";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { LandmarkPendingEditRequestRow } from "./LandmarkPendingEditRequestRow";
import { Badge } from "@/components/ui/badge";

export function LandmarkPendingEditRequestsCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-landmark-edit-requests", "pending"],
    queryFn: () => adminListLandmarkEditRequests("pending"),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-landmark-edit-requests"] });
    queryClient.invalidateQueries({ queryKey: ["admin-landmark-audit"] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Pending rename requests</span>
          {data && <Badge variant="secondary">{data.edit_requests.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && data.edit_requests.length === 0 && (
          <p className="text-sm text-muted-foreground">No pending requests.</p>
        )}
        {data?.edit_requests.map((req) => (
          <LandmarkPendingEditRequestRow key={req.id} request={req} onChanged={invalidate} />
        ))}
      </CardContent>
    </Card>
  );
}
