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
        setParseErrorMessage(
          "No translocator waypoints (icon \u201Cspiral\u201D) found in this file. " +
            "Make sure you typed /waypoint list details in-game first.",
        );
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
      setParseErrorMessage(e instanceof Error ? e.message : "Failed to parse the chat-log");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Upload your client-chat.log
          <MaintenanceChip component="tops_contribute_tls" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            Step 1. In-game, type{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              /waypoint list details
            </code>
            . The server will print the full list of your waypoints into the chat (only visible to
            you).
          </p>
          <p>
            Step 2. Find your{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              client-chat.log
            </code>{" "}
            file.
          </p>
          <p>
            Step 3. Upload the file below. The Y coordinate is ignored — only X/Z matter, and the
            automatic linker only works when each TL waypoint label includes the approximate X/Z
            coordinates of the other end. The coordinates do not need to be exact, as long as both
            labels point near their matching exits.
          </p>
          <p>
            Need the full walkthrough? Read the{" "}
            <NavLink
              to="/blog/adding-translocators-using-waypoints"
              className="underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              Contribute waypoints guide
            </NavLink>
            .
          </p>
          <FilePathHelp summary="Where can I find this file?" items={LOG_FILE_PATHS} />
        </div>

        <div
          className="rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          role="note"
        >
          <strong>Heads up:</strong> only translocator waypoints (the ones with the{" "}
          <code className="rounded bg-amber-500/15 px-1 py-0.5 font-mono text-xs">spiral</code>{" "}
          icon) are read from your chat-log. Every other waypoint marking — bases, landmarks, notes,
          custom icons, etc. — is <strong>ignored</strong> and never uploaded.
        </div>

        <FileUpload
          id="contribute-tls-chatlog"
          label="client-chat.log"
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
              Parsed <strong>{parseSummary.totalWaypoints}</strong> waypoints, of which{" "}
              <strong>{parseSummary.totalTLs}</strong> translocators.
            </p>
            <p className="text-muted-foreground">
              <span className="text-emerald-600">{parseSummary.existing} already on the map</span> ·{" "}
              <span>{parseSummary.paired - parseSummary.existing} new pairs</span> ·{" "}
              <span className="text-red-500">{parseSummary.unpaired} unpaired</span>
            </p>
          </div>
        )}
        {isServerLoadingMoreThanOnce && noServerTLsAvailable && (
          <div className="flex gap-2 items-center text-sm">
            <Spinner />
            <span className="text-xs text-muted-foreground">Loading Server TL file</span>
          </div>
        )}
        {isServerError && (
          <div
            className="rounded-md border border-red-500/60 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-200"
            role="alert"
          >
            <strong>Could not load the server translocator data.</strong> This file is required to
            match your waypoints against the known TL network. Please try refreshing the page — if
            the problem persists, check back later.
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
            {parseSummary ? "Re-parse file" : "Parse file"}
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
              Continue to review
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
