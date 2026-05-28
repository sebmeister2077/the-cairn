import { Button } from "@/components/ui/button";
import {
  DialogFooter,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type LandmarkFeature, renameLandmark } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

export function LandmarkRenameDialog({
  feature,
  ownedByMe,
  onClose,
  onSuccess,
}: {
  feature: LandmarkFeature;
  ownedByMe: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(feature.properties.label ?? "");
  const [submitted, setSubmitted] = useState(false);

  const mut = useMutation({
    mutationFn: () => {
      if (!label.trim()) throw new Error(t("topsMap.landmarkDialogs.rename.labelRequired"));
      return renameLandmark(feature.properties.id, label.trim());
    },
    onSuccess: (resp) => {
      if (resp.applied) {
        onSuccess();
      } else {
        // Edit request queued — show the confirmation in-place before closing
        // so the user can read it.
        setSubmitted(true);
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {ownedByMe
              ? t("topsMap.landmarkDialogs.rename.titleOwned")
              : t("topsMap.landmarkDialogs.rename.titleSuggested")}
          </DialogTitle>
        </DialogHeader>
        {submitted ? (
          <div className="text-sm space-y-2">
            <p>{t("topsMap.landmarkDialogs.rename.queuedMessage")}</p>
            <DialogFooter>
              <Button
                onClick={() => {
                  setSubmitted(false);
                  onSuccess();
                }}
              >
                {t("topsMap.landmarkDialogs.rename.ok")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {!ownedByMe && (
                <p className="text-xs text-muted-foreground">
                  {t("topsMap.landmarkDialogs.rename.notOwnedNotice")}
                </p>
              )}
              <div>
                <Label htmlFor="lm-rename" className="mb-2">
                  {t("topsMap.landmarkDialogs.rename.label")}
                </Label>
                <Input
                  id="lm-rename"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={200}
                />
              </div>
              {mut.error && (
                <p className="text-xs text-destructive">{(mut.error as Error).message}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={mut.isPending}>
                {t("topsMap.cancel")}
              </Button>
              <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
                {mut.isPending && <Loader2 className="size-3 animate-spin mr-1" />}
                {ownedByMe
                  ? t("topsMap.landmarkDialogs.rename.save")
                  : t("topsMap.landmarkDialogs.rename.submitSuggestion")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
