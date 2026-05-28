import { Upload, ShieldCheck, Loader2, Map } from "lucide-react";
import { NavLink } from "react-router-dom";
import {
  ContributionRegionField,
  isRegionSelectionValid,
  type ContributionMode,
} from "./ContributionRegionField";
import { FileUpload } from "../FileUpload";
import { MapDbFileHelp } from "../MapDbFileHelp";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { ContributeInfo } from "@/models/contributions";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "../ui/input";
import {
  contributeMap,
  getMyAccountSafe,
  getStoredApiKey,
  getTopsMapStats,
  type ContributionRegion,
} from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { contributeQueries } from "@/lib/constants/react-query";
import { useTranslation } from "@/lib/i18n";
import { useReduxState } from "@/store/hooks";
import { MaintenanceChip } from "../MaintenanceChip";

export function ContributeUploadCard({
  contributionInfo,
  infoLoading,
  canContributeFromData,
  isAdmin,
  cooldownDays,
  nextAllowed,
  reason,
}: {
  contributionInfo: ContributeInfo | null;
  isAdmin: boolean;
  infoLoading: boolean;
  canContributeFromData: boolean;
  cooldownDays: number;

  nextAllowed: Date | null;
  reason: "pending" | "cooldown" | null;
}) {
  const { t } = useTranslation();
  // Current account — used to honour the user's "Show Contributions" preference.
  // Key/queryFn must match AppContent + AccountPage so the three observers
  // share a single in-flight request (otherwise /account/me is fetched twice
  // on reload of /contribute).
  const accountApiKey = useReduxState("auth.apiKey");
  const accountQuery = useQuery({
    queryKey: ["account-me", accountApiKey ?? ""],
    queryFn: getMyAccountSafe,
    enabled: !!accountApiKey,
    retry: false,
  });

  // Phase 2 — fetch the multi-resolution TOPS map metadata so the region
  // picker can pick the cheapest complete level. We only enable this query
  // when the contributor is actually allowed to use region-overwrite, to
  // avoid hammering the endpoint for everyone.
  const regionPickerEnabled = contributionInfo?.can_use_region_overwrite === true;
  const topsStatsQuery = useQuery<{
    resolutions?: Array<{
      level: number;
      max_dimension: number;
      status: "complete" | "generating" | "not_generated" | "failed";
      generated_at?: string | null;
      size_bytes?: number | null;
      progress?: number;
    }>;
  }>({
    queryKey: ["tops-map-stats"],
    queryFn: getTopsMapStats,
    enabled: regionPickerEnabled,
    retry: false,
  });
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState("");
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dbFile, setDbFile] = useState<File | null>(null);
  const [contributor, setContributor] = useState("");

  // Phase 2 / Phase D — region-restricted update state. `mode === "gap_fill"`
  // is the legacy behaviour (region is forced to null before submit); in
  // `"overwrite"` mode the contributor must pick a rectangle.
  const [mode, setMode] = useState<ContributionMode>("gap_fill");
  const [region, setRegion] = useState<ContributionRegion | null>(null);
  const queryClient = useQueryClient();

  const availableLevels = topsStatsQuery.data?.resolutions ?? [];
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dbFile) return;

    setUploading(true);
    setUploadProgress(0);
    setError("");
    setUploadResult(null);

    try {
      const data = await contributeMap(
        dbFile,
        contributor,
        (pct) => setUploadProgress(pct),
        mode === "overwrite" ? region : null,
      );
      setUploadResult(data.message as string);
      setDbFile(null);
      setFileInputKey((prev) => prev + 1);
      setMode("gap_fill");
      setRegion(null);
      queryClient.invalidateQueries({ queryKey: contributeQueries.contributeInfo.queryKey });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("contributePage.upload.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          {t("contributePage.upload.title")}
          <MaintenanceChip component="tops_contribute_map" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("contributePage.upload.descriptionPrefix")}{" "}
          <NavLink
            to="/blog/contributing-to-the-tops-map"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {t("contributePage.upload.guide")}
          </NavLink>
          .
        </p>

        <div className="flex items-center gap-3 rounded-md border p-3 bg-muted/50">
          <Map className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="text-sm">
            <span className="text-muted-foreground">{t("contributePage.upload.serverMapId")}</span>{" "}
            {infoLoading ? (
              <span className="text-muted-foreground">{t("contributePage.upload.loading")}</span>
            ) : (
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                {contributionInfo?.map_id ?? "—"}
              </code>
            )}
          </div>
        </div>

        <MapDbFileHelp showServerIdHint />

        <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-foreground" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {t("contributePage.upload.whatGetsUploadedTitle")}
            </p>
            <p>{t("contributePage.upload.whatGetsUploaded")}</p>
          </div>
        </div>

        {!infoLoading && contributionInfo && (
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary">{contributionInfo.total_tiles.toLocaleString()}</Badge>
              <span className="text-muted-foreground">
                {t("contributePage.upload.chunksInCombinedMap")}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary">{contributionInfo.pending.length}</Badge>
              <span className="text-muted-foreground">
                {t("contributePage.upload.pendingReview")}
              </span>
            </div>
          </div>
        )}

        <Separator />

        {isAdmin || contributionInfo?.is_admin ? null : (
          <div
            className={
              "rounded-md border p-3 text-sm space-y-1 " +
              (canContributeFromData
                ? "bg-muted/30 text-muted-foreground"
                : "bg-warning/10 border-warning/30 text-warning")
            }
          >
            <p className="font-medium text-foreground">
              {t("contributePage.upload.contributionLimitsTitle")}
            </p>
            <p>{t("contributePage.upload.contributionLimits", { days: cooldownDays })}</p>
            {/* {!canContributeFromData && reason === "pending" && (
              <p>
                You already have a pending contribution awaiting review. Withdraw it below before
                submitting a new one.
              </p>
            )} */}
            {!canContributeFromData && reason === "cooldown" && nextAllowed && (
              <p>
                {t("contributePage.upload.cooldownNotice", {
                  date: nextAllowed.toLocaleString(),
                })}
              </p>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <FileUpload
            key={fileInputKey}
            id="contribute-db"
            label={t("contributePage.upload.mapDatabaseLabel")}
            accept=".db"
            required
            onChange={setDbFile}
            disabled={!isAdmin && contributionInfo?.can_contribute === false}
          />

          <div className="space-y-2">
            <Label htmlFor="contributor-name">{t("contributePage.upload.yourNameLabel")}</Label>
            <div className="flex gap-2">
              <Input
                id="contributor-name"
                placeholder={t("contributePage.upload.anonymousPlaceholder")}
                value={contributor}
                onChange={(e) => setContributor(e.target.value)}
                maxLength={50}
                disabled={!isAdmin && contributionInfo?.can_contribute === false}
                className="flex-1"
              />
              {accountQuery.data?.user?.display_name && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setContributor(accountQuery.data?.user?.display_name ?? "")}
                  disabled={
                    (!isAdmin && contributionInfo?.can_contribute === false) ||
                    contributor === accountQuery.data.user.display_name
                  }
                  title={t("contributePage.upload.useMyNameTitle")}
                >
                  {t("contributePage.upload.useMyName")}
                </Button>
              )}
            </div>
          </div>

          {regionPickerEnabled && (
            <ContributionRegionField
              info={contributionInfo}
              isAdmin={isAdmin}
              availableLevels={availableLevels}
              mode={mode}
              onModeChange={setMode}
              region={region}
              onRegionChange={setRegion}
              disabled={uploading}
            />
          )}

          <Button
            type="submit"
            disabled={
              !dbFile ||
              uploading ||
              (!isAdmin && contributionInfo?.can_contribute === false) ||
              !isRegionSelectionValid(
                mode,
                region,
                isAdmin
                  ? null
                  : ((
                      contributionInfo as
                        | (ContributeInfo & {
                            region_chunk_area_cap_non_admin?: number;
                          })
                        | null
                    )?.region_chunk_area_cap_non_admin ??
                      contributionInfo?.region_tile_cap_non_admin ??
                      null),
              )
            }
          >
            {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("contributePage.upload.uploadForReview")}
          </Button>

          {uploading && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t("contributePage.upload.uploading")}</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {uploadResult && (
          <div className="rounded-md border p-3 bg-muted/30">
            <p className="text-sm font-medium text-green-600 dark:text-green-400">{uploadResult}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
