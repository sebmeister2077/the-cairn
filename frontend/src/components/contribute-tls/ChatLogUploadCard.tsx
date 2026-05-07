import { useState } from "react";
import { useAppDispatch } from "@/store/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileUpload } from "@/components/FileUpload";
import { Loader2 } from "lucide-react";
import { parseChatLogWaypoints, extractTLs } from "@/lib/tl-parser";
import { pairUserTLs } from "@/lib/tl-matching";
import { setUserTLs } from "@/store/slices/contributeTLs";
import type { WorldLineSegment } from "@/components/MapViewer";
import { FilePathHelp, type FilePathHelpItem } from "../FilePathHelp";
import { MaintenanceChip } from "../MaintenanceChip";

interface ChatLogUploadCardProps {
  serverSegments: WorldLineSegment[];
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

export function ChatLogUploadCard({ serverSegments, onParsed }: ChatLogUploadCardProps) {
  const dispatch = useAppDispatch();
  const [file, setFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ParseSummary | null>(null);

  async function handleParse() {
    if (!file) return;
    setWorking(true);
    setError(null);
    setSummary(null);
    try {
      const text = await file.text();
      const all = parseChatLogWaypoints(text);
      const tls = extractTLs(all);
      if (tls.length === 0) {
        setError(
          "No translocator waypoints (icon \u201Cspiral\u201D) found in this file. " +
            "Make sure you typed /waypoint list details in-game first.",
        );
        return;
      }
      const userTLs = pairUserTLs(tls, serverSegments);
      const existing = userTLs.filter((t) => t.status === "existing").length;
      const paired = userTLs.filter((t) => t.endpointB != null).length;
      const unpaired = userTLs.length - paired;
      setSummary({
        totalWaypoints: all.length,
        totalTLs: tls.length,
        paired,
        unpaired,
        existing,
      });
      dispatch(setUserTLs(userTLs));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to parse the chat-log");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
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
          <p>Step 3. Upload the file below. The Y coordinate is ignored — only X/Z matter.</p>
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
            setSummary(null);
            setError(null);
          }}
        />

        {error && (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        )}

        {summary && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
            <p>
              Parsed <strong>{summary.totalWaypoints}</strong> waypoints, of which{" "}
              <strong>{summary.totalTLs}</strong> translocators.
            </p>
            <p className="text-muted-foreground">
              <span className="text-emerald-600">{summary.existing} already on the map</span> ·{" "}
              <span>{summary.paired - summary.existing} new pairs</span> ·{" "}
              <span className="text-red-500">{summary.unpaired} unpaired</span>
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            disabled={!file || working}
            onClick={handleParse}
            variant={summary ? "outline" : "default"}
          >
            {working && <Loader2 className="mr-2 size-4 animate-spin" />}
            {summary ? "Re-parse file" : "Parse file"}
          </Button>
          {summary && (
            <Button type="button" onClick={onParsed}>
              Continue to review
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
