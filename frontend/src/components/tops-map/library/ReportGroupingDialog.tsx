import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";

interface ReportGroupingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupingName: string;
  onSubmit: (reason: string, details?: string) => void | Promise<void>;
}

const REPORT_REASONS = ["spam", "offensive", "inaccurate", "duplicate", "other"] as const;

export function ReportGroupingDialog({
  open,
  onOpenChange,
  groupingName,
  onSubmit,
}: ReportGroupingDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<(typeof REPORT_REASONS)[number]>("spam");
  const [details, setDetails] = useState("");
  const [done, setDone] = useState(false);

  async function submit() {
    await onSubmit(reason, details.trim() || undefined);
    setDone(true);
    setTimeout(() => {
      setDone(false);
      setDetails("");
      onOpenChange(false);
    }, 900);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("topsMap.groupingsDrawer.library.reportTitle")}</DialogTitle>
          <DialogDescription>{groupingName}</DialogDescription>
        </DialogHeader>
        {done ? (
          <p className="py-4 text-sm text-muted-foreground">
            {t("topsMap.groupingsDrawer.library.reportThanks")}
          </p>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              {REPORT_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`rounded-md border px-2 py-1 text-xs transition-colors cursor-pointer ${
                    reason === r ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {t(`topsMap.groupingsDrawer.library.reportReasons.${r}` as const)}
                </button>
              ))}
            </div>
            <textarea
              value={details}
              rows={3}
              maxLength={500}
              placeholder={t("topsMap.groupingsDrawer.library.reportDetails")}
              onChange={(e) => setDetails(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <Button size="sm" onClick={() => void submit()}>
              {t("topsMap.groupingsDrawer.library.reportSubmit")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
