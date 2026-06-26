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

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, MapPin, Pencil, Plus, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  deleteLandmark,
  getLandmarksUrl,
  getMyAccountSafe,
  listMyLandmarkEditRequests,
  type LandmarkEditRequest,
  type LandmarkFeature,
} from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { useReduxState } from "@/store/hooks";
import { LandmarkAddDialog } from "./LandmarkAddDialog";
import { LandmarkRenameDialog } from "./LandmarkRenameDialog";
import { LandmarkRow, PendingRequestRow } from "./LandmarkRow";
import { landmarkQueries } from "@/lib/constants/react-query";

type Props = {
  /** Called after a write succeeds so the map page can reload its overlay. */
  onLandmarksChanged: () => void;
};

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
  const apiKey = useReduxState("auth.apiKey");
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
        <CardContent className="py-1.5 flex justify-center">
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
  const { t } = useTranslation();
  return (
    <Card className="border-dashed">
      <CardContent className="py-3 flex items-start gap-3 text-sm">
        <UserPlus className="size-4 mt-0.5 text-muted-foreground" />
        <div className="flex-1">
          <p>
            {reason === "no-key"
              ? t("topsMap.landmarksCard.signInCtaNoKey")
              : t("topsMap.landmarksCard.signInCtaNoAccount")}
          </p>
          <Link to="/account" className="text-primary hover:underline text-xs">
            {t("topsMap.landmarksCard.goToAccount")}
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isEditing, setIsEditing] = useState<LandmarkFeature | null>(null);
  const [isDeleting, setIsDeleting] = useState<LandmarkFeature | null>(null);
  const [browseQuery, setBrowseQuery] = useState("");
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  const featuresQuery = useQuery(landmarkQueries.geojsonFeatures);

  const editRequestsQuery = useQuery(landmarkQueries.editRequest);

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
    queryClient.invalidateQueries({ queryKey: landmarkQueries.geojsonFeatures.queryKey });
    queryClient.invalidateQueries({ queryKey: landmarkQueries.editRequest.queryKey });
    onLandmarksChanged();
  };

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteLandmark(id),
    onSuccess: () => {
      setIsDeleting(null);
      refreshAll();
    },
  });

  return (
    <>
      <Card className="gap-0">
        <CardHeader className="cursor-pointer select-none" onClick={() => setIsExpanded((v) => !v)}>
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              {isExpanded ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
              <MapPin className="size-4" /> {t("topsMap.landmarksCard.title")}
              {myFeatures.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                  {myFeatures.length}
                </Badge>
              )}
              {pendingRequests.length > 0 && (
                <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px]">
                  {t("topsMap.landmarksCard.pendingCount", {
                    count: pendingRequests.length,
                  })}
                </Badge>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                setIsAddOpen(true);
              }}
            >
              <Plus className="size-3 mr-1" />
              {t("topsMap.landmarksCard.add")}
            </Button>
          </CardTitle>
        </CardHeader>
        <div
          className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${
            isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
          aria-hidden={!isExpanded}
        >
          <div className="overflow-hidden">
            <CardContent
              className={`space-y-3 text-xs pt-4 transition-opacity duration-200 ${
                isExpanded ? "opacity-100 delay-100" : "opacity-0"
              }`}
            >
              {featuresQuery.isLoading && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
              {featuresQuery.error && (
                <p className="text-destructive">{(featuresQuery.error as Error).message}</p>
              )}
              {featuresQuery.data && myFeatures.length === 0 && (
                <p className="text-muted-foreground italic">{t("topsMap.landmarksCard.empty")}</p>
              )}
              {myFeatures.map((feat) => (
                <LandmarkRow
                  key={feat.properties.id}
                  feature={feat}
                  ownedByMe
                  onEdit={() => setIsEditing(feat)}
                  onDelete={() => setIsDeleting(feat)}
                />
              ))}

              {pendingRequests.length > 0 && (
                <div className="pt-2 border-t space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("topsMap.landmarksCard.pendingRenameRequests")}
                  </div>
                  {pendingRequests.map((r) => (
                    <PendingRequestRow key={r.id} request={r} />
                  ))}
                </div>
              )}

              <div className="pt-2 border-t space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t("topsMap.landmarksCard.suggestRename")}
                </div>
                <Input
                  value={browseQuery}
                  onChange={(e) => setBrowseQuery(e.target.value)}
                  placeholder={t("topsMap.landmarksCard.searchByLabel")}
                  className="h-8 text-xs"
                />
                {browseQuery.trim() && browseMatches.length === 0 && (
                  <p className="text-muted-foreground italic">
                    {t("topsMap.landmarksCard.noMatches")}
                  </p>
                )}
                {browseMatches.map((feat) => (
                  <LandmarkRow
                    key={feat.properties.id}
                    feature={feat}
                    ownedByMe={!!userId && feat.properties?.added_by_user_id === userId}
                    onEdit={() => setIsEditing(feat)}
                    onDelete={
                      !!userId && feat.properties?.added_by_user_id === userId
                        ? () => setIsDeleting(feat)
                        : undefined
                    }
                  />
                ))}
                <p className="text-muted-foreground text-[10px]">
                  {t("topsMap.landmarksCard.reviewNotice")}
                </p>
              </div>
            </CardContent>
          </div>
        </div>
      </Card>

      <LandmarkAddDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        onSuccess={() => {
          setIsAddOpen(false);
          refreshAll();
        }}
      />
      {isEditing && (
        <LandmarkRenameDialog
          feature={isEditing}
          ownedByMe={!!userId && isEditing.properties?.added_by_user_id === userId}
          onClose={() => setIsEditing(null)}
          onSuccess={() => {
            setIsEditing(null);
            refreshAll();
          }}
        />
      )}
      <ConfirmDialog
        open={!!isDeleting}
        title={t("topsMap.landmarksCard.deleteConfirmTitle")}
        description={
          isDeleting ? (
            <>
              {t("topsMap.landmarksCard.deleteConfirmBody", {
                label: isDeleting.properties.label || "",
              })}
              {deleteMut.error && (
                <p className="mt-2 text-destructive">
                  {t("topsMap.landmarksCard.deleteFailed", {
                    message: (deleteMut.error as Error).message,
                  })}
                </p>
              )}
            </>
          ) : undefined
        }
        confirmLabel={t("topsMap.landmarksCard.deleteConfirm")}
        cancelLabel={t("topsMap.cancel")}
        variant="destructive"
        loading={deleteMut.isPending}
        onConfirm={() => {
          if (isDeleting) deleteMut.mutate(isDeleting.properties.id);
        }}
        onCancel={() => {
          deleteMut.reset();
          setIsDeleting(null);
        }}
      />
    </>
  );
}
