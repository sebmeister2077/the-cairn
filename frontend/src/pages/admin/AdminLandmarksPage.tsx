/**
 * Admin: Landmarks (route: /manage/landmarks).
 *
 * Three panels stacked vertically:
 *   1. Pending rename-requests queue — approve / reject each.
 *   2. Recent audit feed (latest 100 mutations).
 *   3. Geojson backups — list, create-now per asset, restore.
 *
 * All endpoints require the env-var admin API key (and pass through the
 * WebAuthn-session gate when one is configured).
 */

import { LandmarkAuditFeedCard } from "@/components/admin/landmarks/LandmarkAuditFeedCard";
import { LandmarkBackupsCard } from "@/components/admin/landmarks/LandmarkBackupsCard";
import { LandmarkPendingEditRequestsCard } from "@/components/admin/landmarks/LandmarkPendingEditRequestCard";

export function AdminLandmarksPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Landmarks</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Review user-submitted landmark renames, inspect the audit log, and manage the
          landmarks/translocators backups.
        </p>
      </div>

      <LandmarkPendingEditRequestsCard />
      <LandmarkAuditFeedCard />
      <LandmarkBackupsCard />
    </div>
  );
}
