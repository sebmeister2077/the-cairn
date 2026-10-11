/**
 * Admin: Maintenance notices (route: /manage/maintenance).
 *
 * Lets the on-call admin pin a "Maintenance" chip on a public-facing
 * component (e.g. the TOPS Map Viewer) and pick a target ETA. The chip
 * stays up — and shows a live countdown — until the admin turns it off
 * here, even if the original ETA has elapsed.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { adminListMaintenanceNotices } from "@/lib/api";
import { MaintenanceNoticeCard } from "@/components/admin/maintenance/MaintenanceNoticeCard";

export function AdminMaintenancePage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-maintenance-notices"],
    queryFn: adminListMaintenanceNotices,
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Maintenance notices</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Pin a maintenance chip to a public component while you fix it. Visitors see a live
          countdown until you turn it off.
        </p>
      </div>

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {data && (
        <div className="space-y-3">
          {data.known_components.map((comp) => {
            const notice = data.notices.find((n) => n.component === comp.id);
            return (
              <MaintenanceNoticeCard
                key={comp.id}
                component={comp}
                notice={notice}
                onChanged={() =>
                  queryClient.invalidateQueries({
                    queryKey: ["admin-maintenance-notices"],
                  })
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
