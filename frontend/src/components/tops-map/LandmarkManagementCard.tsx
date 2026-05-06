/**
 * Phase 5 — User-facing landmark management card on the TOPS Map page.
 *
 * Behaviour by account state:
 * - No API key / no account row: show a CTA pointing the user to /account.
 * - Logged in: show "Add landmark" button + lists of (a) landmarks I've
 *   added (live editable) and (b) my pending rename requests.
 *
 * Renames branch by ownership:
 * - Own landmark → applied live; the local cache and the server file both
 *   update synchronously and the parent map is told to reload.
 * - Someone else's / seeded landmark → enqueued as an admin-review request.
 *   The pending list refreshes so the user sees their submission.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Loader2, MapPin, Pencil, Plus, UserPlus } from "lucide-react";

import {
  addLandmark,
  getLandmarksUrl,
  getMyAccountSafe,
  getStoredApiKey,
  listMyLandmarkEditRequests,
  renameLandmark,
  type LandmarkEditRequest,
  type LandmarkFeature,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import { useAppSelector, userReduxState } from "@/store/hooks";

interface Props {
  /** Called after a write succeeds so the map page can reload its overlay. */
  onLandmarksChanged: () => void;
}

const LANDMARKS_QUERY_KEY = ["landmarks-geojson-features"] as const;
export const LANDMARK_LABEL_MAX_LENGTH = 50;

async function fetchLandmarkFeatures(): Promise<LandmarkFeature[]> {
  const { url } = await getLandmarksUrl();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load landmarks (${res.status})`);
  const data = await res.json();
  const feats = Array.isArray(data?.features) ? data.features : [];
  return feats as LandmarkFeature[];
}

export function LandmarkManagementCard({ onLandmarksChanged }: Props) {
  const apiKey = userReduxState("auth.apiKey");
  const accountQuery = useQuery({
    queryKey: ["account-me", apiKey ?? ""],
    queryFn: getMyAccountSafe,
    enabled: !!apiKey,
    retry: false,
  });

  // Show the CTA in two cases: no API key at all, or the key has no account.
  const hasAccount = !!accountQuery.data?.user;

  if (!apiKey) {
    return <SignInCTA reason="no-key" />;
  }
  if (accountQuery.isLoading) {
    return (
      <Card>
        <CardContent className="py-4 flex justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (!hasAccount) {
    return <SignInCTA reason="no-account" />;
  }

  const userId = accountQuery.data?.user?.id ?? null;
  return <SignedInCard userId={userId} onLandmarksChanged={onLandmarksChanged} />;
}

function SignInCTA({ reason }: { reason: "no-key" | "no-account" }) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-3 flex items-start gap-3 text-sm">
        <UserPlus className="size-4 mt-0.5 text-muted-foreground" />
        <div className="flex-1">
          <p>
            {reason === "no-key"
              ? "Set up an API key to add or rename landmarks."
              : "Create an account to add or rename landmarks."}
          </p>
          <Link to="/account" className="text-primary hover:underline text-xs">
            Go to Account →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function SignedInCard({
  userId,
  onLandmarksChanged,
}: {
  userId: string | null;
  onLandmarksChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<LandmarkFeature | null>(null);
  const [browseQuery, setBrowseQuery] = useState("");
  // Collapsed by default so the side panel doesn't get dominated by this
  // section. Persisted to localStorage so the user's preference sticks
  // across reloads / page navigations.
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem("lm-card-expanded") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("lm-card-expanded", expanded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [expanded]);

  const featuresQuery = useQuery({
    queryKey: LANDMARKS_QUERY_KEY,
    queryFn: fetchLandmarkFeatures,
  });

  const editRequestsQuery = useQuery({
    queryKey: ["my-landmark-edit-requests"],
    queryFn: () => listMyLandmarkEditRequests(50),
  });

  const myFeatures = useMemo(() => {
    if (!featuresQuery.data || !userId) return [];
    return featuresQuery.data.filter((f) => f.properties?.added_by_user_id === userId);
  }, [featuresQuery.data, userId]);

  const browseMatches = useMemo(() => {
    const q = browseQuery.trim().toLowerCase();
    if (!q || !featuresQuery.data) return [];
    return featuresQuery.data
      .filter((f) => (f.properties?.label ?? "").toLowerCase().includes(q))
      .slice(0, 20);
  }, [browseQuery, featuresQuery.data]);

  const pendingRequests = useMemo(() => {
    return (editRequestsQuery.data?.edit_requests ?? []).filter((r) => r.status === "pending");
  }, [editRequestsQuery.data]);

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: LANDMARKS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ["my-landmark-edit-requests"] });
    onLandmarksChanged();
  };

  return (
    <>
      <Card>
        <CardHeader className="cursor-pointer select-none" onClick={() => setExpanded((v) => !v)}>
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              <MapPin className="size-4" /> Landmarks added by me
              {myFeatures.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                  {myFeatures.length}
                </Badge>
              )}
              {pendingRequests.length > 0 && (
                <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px]">
                  {pendingRequests.length} pending
                </Badge>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                setAddOpen(true);
              }}
            >
              <Plus className="size-3 mr-1" />
              Add
            </Button>
          </CardTitle>
        </CardHeader>
        {expanded && (
          <CardContent className="space-y-3 text-xs">
            {featuresQuery.isLoading && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
            {featuresQuery.error && (
              <p className="text-destructive">{(featuresQuery.error as Error).message}</p>
            )}
            {featuresQuery.data && myFeatures.length === 0 && (
              <p className="text-muted-foreground italic">You haven't added any landmarks yet.</p>
            )}
            {myFeatures.map((feat) => (
              <LandmarkRow
                key={feat.properties.id}
                feature={feat}
                ownedByMe
                onEdit={() => setEditing(feat)}
              />
            ))}

            {pendingRequests.length > 0 && (
              <div className="pt-2 border-t space-y-1.5">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Pending rename requests
                </div>
                {pendingRequests.map((r) => (
                  <PendingRequestRow key={r.id} request={r} />
                ))}
              </div>
            )}

            <div className="pt-2 border-t space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Suggest a rename for any landmark
              </div>
              <Input
                value={browseQuery}
                onChange={(e) => setBrowseQuery(e.target.value)}
                placeholder="Search by label…"
                className="h-8 text-xs"
              />
              {browseQuery.trim() && browseMatches.length === 0 && (
                <p className="text-muted-foreground italic">No matches.</p>
              )}
              {browseMatches.map((feat) => (
                <LandmarkRow
                  key={feat.properties.id}
                  feature={feat}
                  ownedByMe={!!userId && feat.properties?.added_by_user_id === userId}
                  onEdit={() => setEditing(feat)}
                />
              ))}
              <p className="text-muted-foreground text-[10px]">
                Renames on landmarks you didn't add are queued for admin review.
              </p>
            </div>
          </CardContent>
        )}
      </Card>

      <AddLandmarkDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSuccess={() => {
          setAddOpen(false);
          refreshAll();
        }}
      />
      {editing && (
        <RenameLandmarkDialog
          feature={editing}
          ownedByMe={!!userId && editing.properties?.added_by_user_id === userId}
          onClose={() => setEditing(null)}
          onSuccess={() => {
            setEditing(null);
            refreshAll();
          }}
        />
      )}
    </>
  );
}

function LandmarkRow({
  feature,
  ownedByMe,
  onEdit,
}: {
  feature: LandmarkFeature;
  ownedByMe: boolean;
  onEdit: () => void;
}) {
  const [x, z] = feature.geometry.coordinates;
  const y = feature.properties.z;
  const label = feature.properties.label || "(no label)";
  return (
    <div className="flex items-start justify-between gap-2 rounded border p-2">
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium truncate">{label}</div>
        <div className="text-muted-foreground font-mono text-[11px]">
          ({x}, {z}
          {y != null ? `, y=${y}` : ""}) · {feature.properties.type}
          {!ownedByMe && (
            <Badge variant="outline" className="ml-1">
              seed
            </Badge>
          )}
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit} title="Rename">
        <Pencil className="size-3" />
      </Button>
    </div>
  );
}

function PendingRequestRow({ request }: { request: LandmarkEditRequest }) {
  return (
    <div className="rounded border p-2 space-y-0.5">
      <div className="flex items-center gap-1">
        <Badge variant="secondary" className="text-[10px]">
          {request.status}
        </Badge>
        <span className="text-muted-foreground text-[11px]">
          {new Date(request.created_at).toLocaleString()}
        </span>
      </div>
      <div className="text-[11px]">
        <span className="text-muted-foreground">"{request.current_label}"</span>
        {" → "}
        <span className="font-medium">"{request.proposed_label}"</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add dialog
// ---------------------------------------------------------------------------

function AddLandmarkDialog({
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
            <strong>Heads up:</strong> landmarks are <em>global</em> — once added,
            this landmark will appear on the map for everyone using TOPS Map. Please
            only add real, useful locations and avoid duplicates or test entries.
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

// ---------------------------------------------------------------------------
// Rename dialog
// ---------------------------------------------------------------------------

function RenameLandmarkDialog({
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
  const [label, setLabel] = useState(feature.properties.label ?? "");
  const [submitted, setSubmitted] = useState(false);

  const mut = useMutation({
    mutationFn: () => {
      if (!label.trim()) throw new Error("Label is required");
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
          <DialogTitle>{ownedByMe ? "Rename landmark" : "Suggest a new label"}</DialogTitle>
        </DialogHeader>
        {submitted ? (
          <div className="text-sm space-y-2">
            <p>
              Your suggestion has been queued for admin review. You'll see it under "Pending rename
              requests".
            </p>
            <DialogFooter>
              <Button
                onClick={() => {
                  setSubmitted(false);
                  onSuccess();
                }}
              >
                OK
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {!ownedByMe && (
                <p className="text-xs text-muted-foreground">
                  This landmark wasn't added by you. Your suggestion will be reviewed by an admin
                  before it appears.
                </p>
              )}
              <div>
                <Label htmlFor="lm-rename" className="mb-1">
                  Label
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
                Cancel
              </Button>
              <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
                {mut.isPending && <Loader2 className="size-3 animate-spin mr-1" />}
                {ownedByMe ? "Save" : "Submit suggestion"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
