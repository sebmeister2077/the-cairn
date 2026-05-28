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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addLandmark } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { useReduxState } from "@/store/hooks";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { LANDMARK_LABEL_MAX_LENGTH } from "./LandmarkManagementCard";

export function LandmarkAddDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const isAdmin = useReduxState("auth.isAdmin");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"Base" | "Server" | "Misc" | "Terminus">("Base");
  const [x, setX] = useState<string>("0");
  const [z, setZ] = useState<string>("0");
  const [y, setY] = useState<string>("");

  useEffect(() => {
    if (!open) {
      // Reset on close.
      setLabel("");
      setKind("Base");
      setX("0");
      setZ("0");
      setY("");
    }
  }, [open]);

  const mut = useMutation({
    mutationFn: () => {
      const xn = Number.parseInt(x, 10);
      const zn = Number.parseInt(z, 10);
      const yn = y.trim() === "" ? undefined : Number.parseInt(y, 10);
      if (!Number.isFinite(xn) || !Number.isFinite(zn)) {
        throw new Error(t("topsMap.landmarkDialogs.add.coordinatesMustBeIntegers"));
      }
      if (yn !== undefined && !Number.isFinite(yn)) {
        throw new Error(t("topsMap.landmarkDialogs.add.yMustBeInteger"));
      }
      if (!label.trim()) throw new Error(t("topsMap.landmarkDialogs.rename.labelRequired"));
      //   Remove numbers with scientific notation (e.g. "1e3") because the backend expects integers and would reject those.
      if (x.includes("e") || z.includes("e") || y.includes("e")) {
        throw new Error(t("topsMap.landmarkDialogs.add.coordinatesNoScientificNotation"));
      }

      return addLandmark({ label: label.trim(), type: kind, x: xn, z: zn, y: yn });
    },
    onSuccess,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("topsMap.landmarkDialogs.add.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-900 dark:text-amber-200">
            <strong>{t("topsMap.landmarkDialogs.add.headsUpTitle")}</strong>{" "}
            {t("topsMap.landmarkDialogs.add.headsUpBody")}
          </div>
          <div>
            <Label htmlFor="lm-label" className="mb-1">
              {t("topsMap.landmarkDialogs.rename.label")}
            </Label>
            <Input
              id="lm-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={LANDMARK_LABEL_MAX_LENGTH}
              placeholder={t("topsMap.landmarkDialogs.add.labelPlaceholder")}
            />
          </div>
          {isAdmin && (
            <div>
              <Label htmlFor="lm-type" className="mb-1">
                {t("topsMap.landmarkDialogs.add.type")}
              </Label>
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger id="lm-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Base">
                    {t("topsMap.landmarkDialogs.add.types.base")}
                  </SelectItem>
                  <SelectItem value="Server">
                    {t("topsMap.landmarkDialogs.add.types.server")}
                  </SelectItem>
                  <SelectItem value="Terminus">
                    {t("topsMap.landmarkDialogs.add.types.terminus")}
                  </SelectItem>
                  <SelectItem value="Misc">
                    {t("topsMap.landmarkDialogs.add.types.misc")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {!isAdmin && (
            <div>
              <Label htmlFor="lm-type" className="mb-1">
                {t("topsMap.landmarkDialogs.add.type")}
              </Label>
              <Select
                value={kind === "Terminus" ? "Terminus" : "Base"}
                onValueChange={(v) => setKind(v as typeof kind)}
              >
                <SelectTrigger id="lm-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Base">
                    {t("topsMap.landmarkDialogs.add.types.base")}
                  </SelectItem>
                  <SelectItem value="Terminus">
                    {t("topsMap.landmarkDialogs.add.types.terminus")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="lm-x" className="mb-1">
                X
              </Label>
              <Input
                id="lm-x"
                inputMode="numeric"
                value={x}
                type="number"
                onChange={(e) => setX(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="lm-z" className="mb-1">
                Z
              </Label>
              <Input
                id="lm-z"
                inputMode="numeric"
                value={z}
                type="number"
                onChange={(e) => setZ(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="lm-y" className="mb-1">
                {t("topsMap.landmarkDialogs.add.yOptional")}
              </Label>
              <Input
                id="lm-y"
                inputMode="numeric"
                value={y}
                type="number"
                onChange={(e) => setY(e.target.value)}
              />
            </div>
          </div>
          {/* <p className="text-[11px] text-muted-foreground">
            Coordinates are in absolute world block coords (the same numbers shown in{" "}
            <code>/whereami</code> in-game).
          </p> */}
          {mut.error && <p className="text-xs text-destructive">{(mut.error as Error).message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mut.isPending}>
            {t("topsMap.cancel")}
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="size-3 animate-spin mr-1" />}
            {t("topsMap.landmarkDialogs.add.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
