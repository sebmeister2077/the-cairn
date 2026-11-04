import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MapSourceSelector } from "@/components/tops-map/MapSourceSelector";
import { useReduxState } from "@/store/hooks";
import { CAIRN_BACKUP_MAP_URL, WEBCARTOGRAPHER_PRESETS } from "@/store/slices/mapView";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/helpers/utils";

/** Live reachability of the active map source, derived from the overlay
 *  geojson fetches on the page. `connecting` covers the initial load,
 *  `down` means the proxied/direct fetch is failing (e.g. an upstream 502). */
export type MapSourceConnection = "connected" | "connecting" | "down";

interface MapSourceStatusProps {
  className?: string;
  /** Real connection health of the active source. Defaults to `connecting`
   *  so we never falsely claim "Connected" before a fetch has resolved. */
  status?: MapSourceConnection;
  /** Optional upstream status code (e.g. 502) shown alongside "Unavailable". */
  statusCode?: number | null;
}

/** Compact "Map source: TOPS ● Connected" status with a gear that opens the
 *  full host/preset selector in a popover. Demotes the infrastructure picker
 *  from a prominent top-level control to an on-demand setting. The status dot
 *  reflects the live reachability of the source rather than a hardcoded
 *  "Connected", so an upstream outage (e.g. a 502 from the WC proxy) is shown
 *  accurately. */
export function MapSourceStatus({
  className,
  status = "connecting",
  statusCode,
}: MapSourceStatusProps) {
  const { t } = useTranslation();
  const mapSource = useReduxState("mapView.mapSource");
  const storedUrl = useReduxState("mapView.webCartographerUrl");

  const friendlyName =
    mapSource === "cairn" && CAIRN_BACKUP_MAP_URL
      ? "Cairn"
      : (WEBCARTOGRAPHER_PRESETS.find((p) => p.url === storedUrl)?.label ?? "Custom");

  const statusMeta: Record<
    MapSourceConnection,
    { dot: string; text: string; label: string }
  > = {
    connected: {
      dot: "bg-emerald-500",
      text: "text-emerald-600 dark:text-emerald-400",
      label: t("topsMap.mapSourceConnected"),
    },
    connecting: {
      dot: "bg-amber-500",
      text: "text-amber-600 dark:text-amber-400",
      label: t("topsMap.mapSourceConnecting"),
    },
    down: {
      dot: "bg-red-500",
      text: "text-red-600 dark:text-red-400",
      label:
        statusCode != null
          ? `${t("topsMap.mapSourceDown")} (HTTP ${statusCode})`
          : t("topsMap.mapSourceDown"),
    },
  };
  const current = statusMeta[status];

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm",
        className,
      )}
    >
      <span className="text-muted-foreground">{t("topsMap.mapSourceLabel")}:</span>
      <span className="font-medium text-foreground">{friendlyName}</span>
      <span className={cn("inline-flex items-center gap-1 text-xs", current.text)}>
        <span aria-hidden className={cn("inline-block size-2 rounded-full", current.dot)} />
        {current.label}
      </span>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label={t("topsMap.changeMapSource")}
              title={t("topsMap.changeMapSource")}
            >
              <Settings className="size-4" />
            </Button>
          }
        />
        <PopoverContent side="bottom" align="end" className="w-80">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("topsMap.mapSettings")}
          </p>
          <MapSourceSelector />
        </PopoverContent>
      </Popover>
    </div>
  );
}
