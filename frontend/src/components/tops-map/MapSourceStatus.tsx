import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MapSourceSelector } from "@/components/tops-map/MapSourceSelector";
import { useReduxState } from "@/store/hooks";
import { CAIRN_BACKUP_MAP_URL, WEBCARTOGRAPHER_PRESETS } from "@/store/slices/mapView";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface MapSourceStatusProps {
  className?: string;
}

/** Compact "Map source: TOPS ● Connected" status with a gear that opens the
 *  full host/preset selector in a popover. Demotes the infrastructure picker
 *  from a prominent top-level control to an on-demand setting. */
export function MapSourceStatus({ className }: MapSourceStatusProps) {
  const { t } = useTranslation();
  const mapSource = useReduxState("mapView.mapSource");
  const storedUrl = useReduxState("mapView.webCartographerUrl");

  const friendlyName =
    mapSource === "cairn" && CAIRN_BACKUP_MAP_URL
      ? "Cairn"
      : (WEBCARTOGRAPHER_PRESETS.find((p) => p.url === storedUrl)?.label ?? "Custom");

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm",
        className,
      )}
    >
      <span className="text-muted-foreground">{t("topsMap.mapSourceLabel")}:</span>
      <span className="font-medium text-foreground">{friendlyName}</span>
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <span aria-hidden className="inline-block size-2 rounded-full bg-emerald-500" />
        {t("topsMap.mapSourceConnected")}
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
