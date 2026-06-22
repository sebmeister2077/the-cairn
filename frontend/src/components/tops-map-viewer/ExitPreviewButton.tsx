import { useTranslation } from "@/lib/i18n";
import { Button } from "../ui/button";
import { useAppDispatch } from "@/store/hooks";
import { X } from "lucide-react";
import { exitPreview as exitPreviewAction } from "@/store/slices/topsMapPreview";

export function ExitPreviewButton({}) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
      <Button
        type="button"
        size="sm"
        variant="default"
        className="pointer-events-auto gap-1.5 shadow-lg"
        onClick={() => dispatch(exitPreviewAction())}
      >
        <X className="size-4" />
        {t("topsMap.markGroupingElk.exitPreview")}
      </Button>
    </div>
  );
}
