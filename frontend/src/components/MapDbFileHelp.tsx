import { HelpCircle } from "lucide-react";

interface MapDbFileHelpProps {
  /**
   * When true, the help text references the "Server Map ID shown above" so the
   * user knows which specific .db file to pick. When false, the wording is
   * generic (any cached map .db file works).
   */
  showServerIdHint?: boolean;
}

export function MapDbFileHelp({ showServerIdHint = false }: MapDbFileHelpProps) {
  return (
    <details className="group rounded-md border text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-muted-foreground hover:text-foreground select-none [&::-webkit-details-marker]:hidden list-none">
        <HelpCircle className="h-4 w-4 shrink-0" />
        <span>Where can I find this file?</span>
        <svg
          className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <div className="border-t px-3 py-3 space-y-3 text-muted-foreground">
        {showServerIdHint ? (
          <p>
            Vintage Story stores a{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> map cache
            file for each server you've visited. Look for the file whose name matches the{" "}
            <strong>Server Map ID</strong> shown above.
          </p>
        ) : (
          <p>
            Vintage Story stores a{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> map cache
            file for each multiplayer server you've visited. Pick any of them to render and explore
            the world tiles your client has cached.
          </p>
        )}
        <div className="space-y-2">
          <div>
            <p className="font-medium text-foreground">Windows</p>
            <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
              %appdata%\VintagestoryData\Maps\
            </code>
          </div>
          <div>
            <p className="font-medium text-foreground">Linux</p>
            <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
              ~/.config/VintagestoryData/Maps/
            </code>
          </div>
          <div>
            <p className="font-medium text-foreground">macOS</p>
            <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
              ~/Library/Application Support/VintagestoryData/Maps/
            </code>
          </div>
        </div>
        <p className="text-xs">
          {showServerIdHint ? (
            <>
              Each <code className="rounded bg-muted px-1 py-0.5 font-mono">.db</code> file is named
              after the server's map ID. Copy the file matching the ID above and upload it below.
            </>
          ) : (
            <>
              Each <code className="rounded bg-muted px-1 py-0.5 font-mono">.db</code> file is named
              after the server's map ID.
            </>
          )}
        </p>
      </div>
    </details>
  );
}
