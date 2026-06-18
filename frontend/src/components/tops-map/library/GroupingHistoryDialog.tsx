import { useEffect, useState } from "react";
import { GitFork, History } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { groupingLibrary, type LibraryHistoryEntry, type LibraryVersionSnapshot } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

interface GroupingHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupingId: string | null;
  groupingName?: string;
  /** Fork a specific version into the user's local groupings. */
  onForkVersion: (snapshot: LibraryVersionSnapshot) => void;
}

/**
 * Lists every published version of a grouping (append-only history) and lets
 * the user fork any past version into their local groupings. Forking pulls the
 * full snapshot (including TL ids) on demand.
 */
export function GroupingHistoryDialog({
  open,
  onOpenChange,
  groupingId,
  groupingName,
  onForkVersion,
}: GroupingHistoryDialogProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<LibraryHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [forkingVersion, setForkingVersion] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !groupingId) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    groupingLibrary
      .history(groupingId, controller.signal)
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, groupingId]);

  async function handleFork(version: number) {
    if (!groupingId) return;
    setForkingVersion(version);
    try {
      const snapshot = await groupingLibrary.version(groupingId, version);
      onForkVersion(snapshot);
    } finally {
      setForkingVersion(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4" />
            {groupingName ?? t("topsMap.groupingsDrawer.library.historyTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("topsMap.groupingsDrawer.library.historyDescription")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
            {items.map((entry) => (
              <li key={entry.version} className="rounded-md border p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {t("topsMap.groupingsDrawer.library.version", {
                        version: entry.version,
                      })}{" "}
                      · {entry.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("topsMap.groupingsDrawer.library.tls", {
                        count: entry.tl_count,
                      })}
                      {entry.editor ? ` · ${entry.editor}` : ""}
                      {entry.created_at
                        ? ` · ${t("topsMap.groupingsDrawer.library.publishedOn", {
                            date: new Date(entry.created_at).toLocaleDateString(),
                          })}`
                        : ""}
                    </p>
                    <p className="mt-0.5 text-xs italic text-muted-foreground">
                      {entry.change_note || t("topsMap.groupingsDrawer.library.noChangeNote")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={forkingVersion !== null}
                    onClick={() => handleFork(entry.version)}
                  >
                    <GitFork className="size-3.5 mr-1" />
                    {t("topsMap.groupingsDrawer.library.forkVersion")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
