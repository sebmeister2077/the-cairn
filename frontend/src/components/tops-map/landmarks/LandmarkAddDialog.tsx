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
import { addLandmark, type LandmarkFeature, renameLandmark } from "@/lib/api";
import { userReduxState } from "@/store/hooks";
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
  const isAdmin = userReduxState("auth.isAdmin");
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
        throw new Error("X and Z must be integers");
      }
      if (yn !== undefined && !Number.isFinite(yn)) {
        throw new Error("Y must be an integer");
      }
      if (!label.trim()) throw new Error("Label is required");
      //   Remove numbers with scientific notation (e.g. "1e3") because the backend expects integers and would reject those.
      if (x.includes("e") || z.includes("e") || y.includes("e")) {
        throw new Error("Coordinates must be integers (no scientific notation)");
      }

      return addLandmark({ label: label.trim(), type: kind, x: xn, z: zn, y: yn });
    },
    onSuccess,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a landmark</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-900 dark:text-amber-200">
            <strong>Heads up:</strong> landmarks are <em>global</em> — once added, this landmark
            will appear on the map for everyone using TOPS Map. Please only add real, useful
            locations and avoid duplicates or test entries.
          </div>
          <div>
            <Label htmlFor="lm-label" className="mb-1">
              Label
            </Label>
            <Input
              id="lm-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={LANDMARK_LABEL_MAX_LENGTH}
              placeholder="My base / Server spawn / …"
            />
          </div>
          {isAdmin && (
            <div>
              <Label htmlFor="lm-type" className="mb-1">
                Type
              </Label>
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger id="lm-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Base">Base</SelectItem>
                  <SelectItem value="Server">Server</SelectItem>
                  <SelectItem value="Terminus">Terminus</SelectItem>
                  <SelectItem value="Misc">Misc (hidden by default)</SelectItem>
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
                Y (optional)
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
          <p className="text-[11px] text-muted-foreground">
            Coordinates are in absolute world block coords (the same numbers shown in{" "}
            <code>/whereami</code> in-game).
          </p>
          {mut.error && <p className="text-xs text-destructive">{(mut.error as Error).message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mut.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="size-3 animate-spin mr-1" />}
            Add landmark
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
