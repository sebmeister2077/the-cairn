import { FilePathHelp } from "@/components/FilePathHelp";
import { Trans, useTranslation } from "@/lib/i18n";

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
  const { t } = useTranslation();

  return (
    <FilePathHelp
      summary={t("mapDbFileHelp.summary")}
      intro={
        showServerIdHint ? (
          <p>
            <Trans
              path="mapDbFileHelp.serverIdIntro"
              components={{
                code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                strong: <strong />,
              }}
            />
          </p>
        ) : (
          <p>
            <Trans
              path="mapDbFileHelp.genericIntro"
              components={{
                code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
              }}
            />
          </p>
        )
      }
      items={MAP_DB_PATHS}
      footer={
        <p className="text-xs">
          {showServerIdHint ? (
            <Trans
              path="mapDbFileHelp.serverIdFooter"
              components={{
                code: <code className="rounded bg-muted px-1 py-0.5 font-mono" />,
              }}
            />
          ) : (
            <Trans
              path="mapDbFileHelp.genericFooter"
              components={{
                code: <code className="rounded bg-muted px-1 py-0.5 font-mono" />,
              }}
            />
          )}
        </p>
      }
    />
  );
}
