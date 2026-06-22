import { useTranslation } from "@/lib/i18n";
import { Button } from "../ui/button";
import {
  DialogContent,
  DialogHeader,
  DialogFooter,
  Dialog,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function GoToDialog({
  open,
  onOpenChange,
  goToXInput,
  setGoToXInput,
  goToZInput,
  setGoToZInput,
  goToError,
  setGoToError,
  handleGoToSubmit,
  lastViewportRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goToXInput: string;
  setGoToXInput: (value: string) => void;
  goToZInput: string;
  setGoToZInput: (value: string) => void;
  goToError: string | null;
  setGoToError: (value: string | null) => void;
  handleGoToSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  lastViewportRef: React.MutableRefObject<{
    centerWorldX: number;
    centerWorldZ: number;
  } | null>;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t("topsMap.goToCoordinate")}</DialogTitle>
          <DialogDescription>{t("topsMap.goToCoordinateDescription")}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={handleGoToSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="goto-x">X</Label>
              <Input
                id="goto-x"
                inputMode="decimal"
                autoComplete="off"
                placeholder={t("topsMap.examplePositiveCoordinate")}
                value={goToXInput}
                onChange={(e) => {
                  setGoToXInput(e.target.value);
                  if (goToError) setGoToError(null);
                }}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="goto-z">Z</Label>
              <Input
                id="goto-z"
                inputMode="decimal"
                autoComplete="off"
                placeholder={t("topsMap.exampleNegativeCoordinate")}
                value={goToZInput}
                onChange={(e) => {
                  setGoToZInput(e.target.value);
                  if (goToError) setGoToError(null);
                }}
              />
            </div>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("topsMap.currentCenterPrefilled")}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                const view = lastViewportRef.current;
                if (!view) return;
                setGoToXInput(String(Math.round(view.centerWorldX)));
                setGoToZInput(String(Math.round(view.centerWorldZ)));
                setGoToError(null);
              }}
            >
              {t("topsMap.useCurrentCenter")}
            </Button>
          </div>
          {goToError && <p className="text-sm text-destructive">{goToError}</p>}
          <DialogFooter className="mx-0 mb-0 border-0 bg-transparent p-0 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("topsMap.cancel")}
            </Button>
            <Button type="submit">{t("topsMap.goToCoordinate")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
