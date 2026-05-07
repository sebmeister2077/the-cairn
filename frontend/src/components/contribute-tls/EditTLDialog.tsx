/**
 * Edit dialog for a single user-uploaded translocator.
 * Allows tweaking either endpoint's X/Z (Y is irrelevant for matching).
 */

import { useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setEditingTLId, updateUserTL, removeUserTL } from "@/store/slices/contributeTLs";
import { reclassifyUserTL } from "@/lib/tl-matching";
import type { UserTL, UserTLEndpoint } from "@/models/contributeTLs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WorldLineSegment } from "@/components/MapViewer";

interface EditTLDialogProps {
  serverSegments: WorldLineSegment[];
}

interface FormState {
  aX: string;
  aZ: string;
  bX: string;
  bZ: string;
}

function endpointToForm(tl: UserTL): FormState {
  return {
    aX: String(tl.endpointA.x),
    aZ: String(tl.endpointA.z),
    bX: tl.endpointB ? String(tl.endpointB.x) : "",
    bZ: tl.endpointB ? String(tl.endpointB.z) : "",
  };
}

export function EditTLDialog({ serverSegments }: EditTLDialogProps) {
  const dispatch = useAppDispatch();
  const editingTLId = useAppSelector((s) => s.contributeTLs.editingTLId);
  const tl = useAppSelector(
    (s) => s.contributeTLs.userTLs.find((t) => t.localId === editingTLId) ?? null,
  );

  const [form, setForm] = useState<FormState>({ aX: "", aZ: "", bX: "", bZ: "" });
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedId, setLastSyncedId] = useState<string | null>(null);

  const currentId = tl?.localId ?? null;
  if (currentId !== lastSyncedId) {
    setLastSyncedId(currentId);
    if (tl) setForm(endpointToForm(tl));
    setError(null);
  }

  function close() {
    dispatch(setEditingTLId(null));
  }

  function handleSave() {
    if (!tl) return;
    const aX = Number(form.aX);
    const aZ = Number(form.aZ);
    if (!Number.isFinite(aX) || !Number.isFinite(aZ)) {
      setError("Endpoint A must be a valid pair of integers.");
      return;
    }
    let nextEndpointB: UserTLEndpoint | null = tl.endpointB;
    const bXTrim = form.bX.trim();
    const bZTrim = form.bZ.trim();
    if (bXTrim !== "" || bZTrim !== "") {
      const bX = Number(bXTrim);
      const bZ = Number(bZTrim);
      if (!Number.isFinite(bX) || !Number.isFinite(bZ)) {
        setError("Endpoint B must be either empty or a valid pair of integers.");
        return;
      }
      nextEndpointB = {
        x: Math.round(bX),
        z: Math.round(bZ),
        sourceWaypointIndex: tl.endpointB?.sourceWaypointIndex ?? -1,
        label: tl.endpointB?.label ?? tl.endpointA.label,
      };
    } else {
      nextEndpointB = null;
    }
    const next: UserTL = {
      ...tl,
      endpointA: {
        ...tl.endpointA,
        x: Math.round(aX),
        z: Math.round(aZ),
      },
      endpointB: nextEndpointB,
      pairConfidence: nextEndpointB ? "manual" : "none",
    };
    dispatch(updateUserTL(reclassifyUserTL(next, serverSegments)));
    close();
  }

  if (!tl) return null;

  return (
    <Dialog open={tl != null} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit translocator</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Coordinates are in world blocks (X / Z). Y is ignored.
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase">Endpoint A</Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="edit-tl-aX">X</Label>
                <Input
                  id="edit-tl-aX"
                  inputMode="numeric"
                  value={form.aX}
                  onChange={(e) => setForm((p) => ({ ...p, aX: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="edit-tl-aZ">Z</Label>
                <Input
                  id="edit-tl-aZ"
                  inputMode="numeric"
                  value={form.aZ}
                  onChange={(e) => setForm((p) => ({ ...p, aZ: e.target.value }))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground truncate">From: {tl.endpointA.label}</p>
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase">
              Endpoint B {tl.endpointB ? "" : "(currently unpaired)"}
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="edit-tl-bX">X</Label>
                <Input
                  id="edit-tl-bX"
                  inputMode="numeric"
                  value={form.bX}
                  onChange={(e) => setForm((p) => ({ ...p, bX: e.target.value }))}
                  placeholder="(empty = unpaired)"
                />
              </div>
              <div>
                <Label htmlFor="edit-tl-bZ">Z</Label>
                <Input
                  id="edit-tl-bZ"
                  inputMode="numeric"
                  value={form.bZ}
                  onChange={(e) => setForm((p) => ({ ...p, bZ: e.target.value }))}
                  placeholder="(empty = unpaired)"
                />
              </div>
            </div>
            {tl.endpointB && (
              <p className="text-xs text-muted-foreground truncate">From: {tl.endpointB.label}</p>
            )}
          </div>
          {error && (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              dispatch(removeUserTL(tl.localId));
              close();
            }}
          >
            Remove
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSave}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
