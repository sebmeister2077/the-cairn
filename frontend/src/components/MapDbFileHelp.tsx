import { FilePathHelp } from "@/components/FilePathHelp";

interface MapDbFileHelpProps {
  /**
   * When true, the help text references the "Server Map ID shown above" so the
   * user knows which specific .db file to pick. When false, the wording is
   * generic (any cached map .db file works).
   */
  showServerIdHint?: boolean;
}

const MAP_DB_PATHS = [
  { label: "Windows", path: "%appdata%\\VintagestoryData\\Maps\\" },
  { label: "Linux", path: "~/.config/VintagestoryData/Maps/" },
  { label: "macOS", path: "~/Library/Application Support/VintagestoryData/Maps/" },
];

export function MapDbFileHelp({ showServerIdHint = false }: MapDbFileHelpProps) {
  return (
    <FilePathHelp
      summary="Where can I find this file?"
      intro={
        showServerIdHint ? (
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
            the world chunks your client has cached.
          </p>
        )
      }
      items={MAP_DB_PATHS}
      footer={
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
      }
    />
  );
}
