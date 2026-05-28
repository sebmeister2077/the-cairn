import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useAppDispatch } from "@/store/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileUpload } from "@/components/FileUpload";
import { Loader2, Loader2Icon, LoaderIcon } from "lucide-react";
import { parseChatLogWaypoints, extractTLs } from "@/lib/tl-parser";
import { pairUserTLs } from "@/lib/tl-matching";
import { setUserTLs } from "@/store/slices/contributeTLs";
import { useTranslation } from "@/lib/i18n";
import type { WorldLineSegment } from "@/components/MapViewer";
import { FilePathHelp, type FilePathHelpItem } from "../FilePathHelp";
import { MaintenanceChip } from "../MaintenanceChip";
import { useTranslocatorsOverlay } from "@/hooks/useOverlayData";
import { Spinner } from "../ui/spinner";

interface ChatLogUploadCardProps {
  // serverSegments: WorldLineSegment[];
  onParsed: () => void;
}

interface ParseSummary {
  totalWaypoints: number;
  totalTLs: number;
  paired: number;
  unpaired: number;
  existing: number;
}

const LOG_FILE_PATHS: FilePathHelpItem[] = [
  { label: "Windows", path: "%appdata%\\VintagestoryData\\Logs\\" },
  { label: "Linux", path: "~/.config/VintagestoryData/Logs/" },
  { label: "macOS", path: "~/Library/Application Support/VintagestoryData/Logs/" },
];

export function ChatLogUploadCard({ onParsed }: ChatLogUploadCardProps) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [parseErrorMessage, setParseErrorMessage] = useState<string | null>(null);
  const [parseSummary, setParseSummary] = useState<ParseSummary | null>(null);

  const translocatorsQuery = useTranslocatorsOverlay();
  const isServerLoadingMoreThanOnce =
    translocatorsQuery.isFetching && translocatorsQuery.failureCount > 0;
  const serverSegments = translocatorsQuery.data?.data ?? [];
  const noServerTLsAvailable = serverSegments.length === 0;
  const isServerError = translocatorsQuery.isError && noServerTLsAvailable;

  async function handleParse() {
    if (!file) return;
    setWorking(true);
    setParseErrorMessage(null);
    setParseSummary(null);
    try {
      const text = await file.text();
      const all = parseChatLogWaypoints(text);
      const tls = extractTLs(all);
      if (tls.length === 0) {
        setParseErrorMessage(t("contributeTLsPage.chatLogUpload.noTranslocatorWaypointsFound"));
        return;
      }
      const userTLs = pairUserTLs(tls, serverSegments);
      const existing = userTLs.filter((t) => t.status === "existing").length;
      const paired = userTLs.filter((t) => t.endpointB != null).length;
      const unpaired = userTLs.length - paired;
      setParseSummary({
        totalWaypoints: all.length,
        totalTLs: tls.length,
        paired,
        unpaired,
        existing,
      });
      dispatch(setUserTLs(userTLs));
    } catch (e: unknown) {
      setParseErrorMessage(
        e instanceof Error ? e.message : t("contributeTLsPage.chatLogUpload.parseFailed"),
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("contributeTLsPage.chatLogUpload.title")}
          <MaintenanceChip component="tops_contribute_tls_log" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            {t("contributeTLsPage.chatLogUpload.step1Prefix")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              /waypoint list details
            </code>
            {t("contributeTLsPage.chatLogUpload.step1Suffix")}
          </p>
          <p>
            {t("contributeTLsPage.chatLogUpload.step2Prefix")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              client-chat.log
            </code>{" "}
            {t("contributeTLsPage.chatLogUpload.step2Suffix")}
          </p>
          <p>{t("contributeTLsPage.chatLogUpload.step3")}</p>
          <p>
            {t("contributeTLsPage.chatLogUpload.guidePrefix")}{" "}
            <NavLink
              to="/blog/adding-translocators-using-waypoints"
              className="underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              {t("contributeTLsPage.chatLogUpload.guide")}
            </NavLink>
            .
          </p>
          <FilePathHelp
            summary={t("contributeTLsPage.chatLogUpload.fileHelpSummary")}
            items={LOG_FILE_PATHS}
          />
        </div>

        <div
          className="rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          role="note"
        >
          <strong>{t("contributeTLsPage.chatLogUpload.headsUp")}</strong>{" "}
          {t("contributeTLsPage.chatLogUpload.headsUpPrefix")}{" "}
          <code className="rounded bg-amber-500/15 px-1 py-0.5 font-mono text-xs">spiral</code>{" "}
          {t("contributeTLsPage.chatLogUpload.headsUpMiddle")}{" "}
          <strong>{t("contributeTLsPage.chatLogUpload.headsUpIgnored")}</strong>{" "}
          {t("contributeTLsPage.chatLogUpload.headsUpSuffix")}
        </div>

        <FileUpload
          id="contribute-tls-chatlog"
          label={t("contributeTLsPage.chatLogUpload.fileLabel")}
          accept=".log,.txt,text/plain"
          onChange={(f) => {
            setFile(f);
            setParseSummary(null);
            setParseErrorMessage(null);
          }}
        />

        {parseErrorMessage && (
          <p className="text-sm text-red-500" role="alert">
            {parseErrorMessage}
          </p>
        )}

        {parseSummary && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
            <p>
              {t("contributeTLsPage.chatLogUpload.parsedWaypoints", {
                waypoints: parseSummary.totalWaypoints,
                translocators: parseSummary.totalTLs,
              })}
            </p>
            <p className="text-muted-foreground">
              <span className="text-emerald-600">
                {t("contributeTLsPage.chatLogUpload.parsedBreakdown", {
                  existing: parseSummary.existing,
                  newPairs: parseSummary.paired - parseSummary.existing,
                  unpaired: parseSummary.unpaired,
                })}
              </span>
            </p>
          </div>
        )}
        {isServerLoadingMoreThanOnce && noServerTLsAvailable && (
          <div className="flex gap-2 items-center text-sm">
            <Spinner />
            <span className="text-xs text-muted-foreground">
              {t("contributeTLsPage.chatLogUpload.loadingServerFile")}
            </span>
          </div>
        )}
        {isServerError && (
          <div
            className="rounded-md border border-red-500/60 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-200"
            role="alert"
          >
            <strong>{t("contributeTLsPage.chatLogUpload.serverDataLoadFailedTitle")}</strong>{" "}
            {t("contributeTLsPage.chatLogUpload.serverDataLoadFailedBody")}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            disabled={!file || working || noServerTLsAvailable}
            onClick={handleParse}
            variant={parseSummary ? "outline" : "default"}
          >
            {working && <Spinner className="mr-2" />}
            {parseSummary
              ? t("contributeTLsPage.chatLogUpload.reparseFile")
              : t("contributeTLsPage.chatLogUpload.parseFile")}
          </Button>
          {parseSummary && (
            <Button
              type="button"
              onClick={() => {
                if (noServerTLsAvailable) return;
                onParsed();
              }}
              disabled={noServerTLsAvailable}
            >
              {t("contributeTLsPage.chatLogUpload.continueToReview")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
