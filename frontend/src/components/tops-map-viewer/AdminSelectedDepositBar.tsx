import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ResourceDeposit } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

interface AdminSelectedDepositBarProps {
  selectedDeposit: ResourceDeposit;
  onDismiss: () => void;
}

/** Admin-only info chip for the currently selected worldgen deposit. */
export function AdminSelectedDepositBar({
  selectedDeposit,
  onDismiss,
}: AdminSelectedDepositBarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 rounded-md border bg-primary/5 px-3 py-2 text-sm">
      <Sparkles className="size-4 text-primary" />
      <span className="font-medium capitalize">{selectedDeposit.type}</span>
      <span className="text-muted-foreground font-mono text-xs">
        ({selectedDeposit.x}, {selectedDeposit.y}, {selectedDeposit.z})
      </span>
      {selectedDeposit.qty != null && (
        <span className="text-xs text-muted-foreground">
          {t("topsMap.depositQuantity", {
            value: selectedDeposit.qty.toFixed(2),
          })}
        </span>
      )}
      {selectedDeposit.richness != null && (
        <span className="text-xs text-muted-foreground">
          {t("topsMap.depositRichness", {
            value: selectedDeposit.richness.toFixed(2),
          })}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        onClick={onDismiss}
        aria-label={t("topsMap.dismissDepositInfo")}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
