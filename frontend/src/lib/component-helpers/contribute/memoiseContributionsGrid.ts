// Memoise the grid so the React-Query polling that fires every 5s while a
// contribution is being merged/validated doesn't re-render the thumbnail
// list (and the inline expanded `MapViewer`) on every successful refetch.
// React-Query produces a fresh `history` array reference on each fetch even
// when the underlying data is byte-for-byte identical, so the default
// reference equality is not enough — we compare the fields we actually
// render. `displayContributor` and `onRevert` are stabilised at the call
// site via `useCallback`, so identity equality is sufficient there.
//
// IMPORTANT: `preview_signed_url` carries a fresh signature/token on every
// refetch (R2 / S3-style signed URLs include `X-Amz-Signature`, `expires`,
// etc. in the query string), so a strict string compare would always
// disagree and force the inline `MapViewer` to reset its zoom/pan. We
// compare just the URL's pathname to detect actual preview swaps and

import { RecentContributionsGridImpl } from "@/components/contributions/RecentContributionsGrid";
import type { HistoryEntry } from "@/models/contributions";
import { memo } from "react";

// ignore signature churn.
function previewUrlsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
        return new URL(a).pathname === new URL(b).pathname;
    } catch {
        return a === b;
    }
}

function historyEntriesEqual(a: HistoryEntry[], b: HistoryEntry[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (
            x.id !== y.id ||
            x.status !== y.status ||
            x.contributor !== y.contributor ||
            x.tile_count !== y.tile_count ||
            x.tiles_new !== y.tiles_new ||
            x.tiles_existing !== y.tiles_existing ||
            x.combined_total !== y.combined_total ||
            x.approved_at !== y.approved_at ||
            x.withdrawn_at !== y.withdrawn_at ||
            !previewUrlsEqual(x.preview_signed_url, y.preview_signed_url) ||
            x.is_mine !== y.is_mine ||
            x.revert_supported !== y.revert_supported ||
            x.revert_added_count !== y.revert_added_count ||
            x.revert_replaced_count !== y.revert_replaced_count ||
            x.reverted_at !== y.reverted_at ||
            x.can_revert !== y.can_revert ||
            x.revert_status !== y.revert_status ||
            x.revert_error !== y.revert_error ||
            x.revert_attempts !== y.revert_attempts
        ) {
            return false;
        }
    }
    return true;
}

export const RecentContributionsGridMemo = memo(RecentContributionsGridImpl, (prev, next) => {
    return (
        prev.isAdmin === next.isAdmin &&
        prev.totalCount === next.totalCount &&
        prev.revertWindowDays === next.revertWindowDays &&
        prev.onRevert === next.onRevert &&
        historyEntriesEqual(prev.history, next.history)
    );
});
