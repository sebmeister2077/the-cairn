import { useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/components/useCopy";
import { useTranslation } from "@/lib/i18n";

const DISCORD_USERNAME = "vintagecreeper";

interface ContactDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ContactDialog({ open, onClose }: ContactDialogProps) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("app.contactDialog.title")}</DialogTitle>
          <DialogDescription>{t("app.contactDialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span>
            {t("app.contactDialog.discordLabel")}{" "}
            <span className="font-mono">{DISCORD_USERNAME}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => copy(DISCORD_USERNAME, "discord")}
            aria-label={t("app.contactDialog.copyDiscord")}
          >
            {copied === "discord" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function useContactDialog() {
  const [open, setOpen] = useState(false);
  return {
    open,
    openDialog: () => setOpen(true),
    closeDialog: () => setOpen(false),
  };
}
