/**
 * Side-panel list of the user's translocators grouped by status.
 * Clicking a row selects the TL in the map; the edit/remove buttons
 * dispatch into the slice.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  navigateToTL,
  setEditingTLId,
  removeUserTL,
  updateUserTL,
} from "@/store/slices/contributeTLs";
import type { UserTL, TLStatus } from "@/models/contributeTLs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Pencil, Trash2 } from "lucide-react";

const STATUS_ORDER: TLStatus[] = [
  "new-confirmed",
  "new-unconfirmed",
  "unpaired",
  "invalid",
  "existing",
];

const STATUS_LABEL: Record<TLStatus, string> = {
  "new-confirmed": "New \u2014 confirmed",
  "new-unconfirmed": "New \u2014 needs review",
  unpaired: "Unpaired",
  invalid: "Invalid",
  existing: "Already on map",
};

const STATUS_VARIANT: Record<TLStatus, "default" | "secondary" | "destructive" | "outline"> = {
  "new-confirmed": "default",
  "new-unconfirmed": "secondary",
  unpaired: "destructive",
  invalid: "destructive",
  existing: "outline",
};

/**
 * Short, actionable hint shown directly below each section header so the
 * user knows what to do without opening the full "What to do now?" dialog.
 */
const STATUS_HINT: Partial<Record<TLStatus, string>> = {
  "new-unconfirmed":
    "Multiple possible partners — open Edit to confirm, drag a handle on the map, or use Link two TLs.",
  unpaired:
    "These have no partner yet. Use Link two TLs in the map toolbar, type the partner coords via Edit, or remove if you only have one side.",
  invalid: "Fix the inline reason via Edit, or remove the entry. These are skipped at submit-time.",
  existing: "Already on the map — skipped at submit-time. Shown for reference only.",
};

export function TLReviewList() {
  const dispatch = useAppDispatch();
  const userTLs = useAppSelector((s) => s.contributeTLs.userTLs);
  const selectedTLId = useAppSelector((s) => s.contributeTLs.selectedTLId);
  const navTick = useAppSelector((s) => s.contributeTLs.navTick);

  const grouped = useMemo(() => {
    const out = new Map<TLStatus, UserTL[]>();
    for (const status of STATUS_ORDER) out.set(status, []);
    for (const tl of userTLs) {
      const arr = out.get(tl.status);
      if (arr) arr.push(tl);
    }
    return out;
  }, [userTLs]);

  // Scroll the selected row into view + flash whenever the user navigates
  // (clicked a row themselves, or clicked an endpoint on the map).
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedTLId) return;
    const el = rowRefs.current.get(selectedTLId);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setFlashId(selectedTLId);
    const t = window.setTimeout(() => setFlashId(null), 900);
    return () => window.clearTimeout(t);
  }, [selectedTLId, navTick]);

  /** Mark a `new-unconfirmed` TL as user-confirmed without opening a dialog. */
  function confirmTL(tl: UserTL) {
    dispatch(
      updateUserTL({
        ...tl,
        status: "new-confirmed",
        pairConfidence: "manual",
      }),
    );
  }

  return (
    <Card className="h-full overflow-hidden flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Translocators ({userTLs.length})</CardTitle>
      </CardHeader>
      <CardContent ref={scrollRootRef} className="flex-1 overflow-y-auto space-y-4">
        {STATUS_ORDER.map((status) => {
          const items = grouped.get(status) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={status} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
                <span>{items.length}</span>
              </h3>
              {STATUS_HINT[status] && (
                <p className="text-xs text-muted-foreground leading-snug">{STATUS_HINT[status]}</p>
              )}
              <ul className="space-y-1">
                {items.map((tl) => (
                  <li
                    key={tl.localId}
                    ref={(el) => {
                      if (el) rowRefs.current.set(tl.localId, el);
                      else rowRefs.current.delete(tl.localId);
                    }}
                    className={`group flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                      tl.localId === selectedTLId
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted/50"
                    } ${tl.localId === flashId ? "ring-2 ring-primary/60 animate-pulse" : ""}`}
                    onClick={() => dispatch(navigateToTL(tl.localId))}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs">
                        ({tl.endpointA.x}, {tl.endpointA.z})
                        {tl.endpointB && (
                          <>
                            {" \u2194 "}({tl.endpointB.x}, {tl.endpointB.z})
                          </>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {tl.endpointA.label}
                      </div>
                      {tl.invalidReason && (
                        <div className="text-xs text-red-500">{tl.invalidReason}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                      {tl.status === "new-unconfirmed" && (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmTL(tl);
                          }}
                          aria-label="Confirm pairing"
                          title="Confirm this pairing as-is"
                        >
                          <Check className="size-3.5 text-emerald-600" />
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch(setEditingTLId(tl.localId));
                        }}
                        aria-label="Edit translocator"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch(removeUserTL(tl.localId));
                        }}
                        aria-label="Remove translocator"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {userTLs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No translocators yet. Upload a chat-log to get started.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
