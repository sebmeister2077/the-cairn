import { useState } from "react";
import { Heart } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KOFI_URL } from "@/lib/support-links";
import { useTranslation } from "@/lib/i18n";

interface SupportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SupportDialog({ open, onClose }: SupportDialogProps) {
  const { t } = useTranslation();
  if (!KOFI_URL) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("app.support.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("app.support.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <Button
          className="w-full"
          title={t("app.support.openInNew")}
          render={
            <a href={KOFI_URL} target="_blank" rel="noopener noreferrer">
              <Heart className="size-4" />
              {t("app.support.kofi")}
            </a>
          }
        />
        <p className="text-xs text-muted-foreground">{t("app.support.disclaimer")}</p>
      </DialogContent>
    </Dialog>
  );
}

export function useSupportDialog() {
  const [open, setOpen] = useState(false);
  return {
    open,
    openDialog: () => setOpen(true),
    closeDialog: () => setOpen(false),
  };
}
