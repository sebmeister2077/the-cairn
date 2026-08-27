import { memo } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CollapsibleSection } from "@/components/tops-map/CollapsibleSection";
import { PlayerClaimsControl } from "@/components/tops-map/PlayerClaimsControl";
import {
  AuctionHeatmapControl,
  type AuctionLayer,
} from "@/components/tops-map/AuctionHeatmapControl";
import { RockStrataLegendPanel } from "@/components/tops-map/RockStrataLegendPanel";
import { ClimateControlsPanel } from "@/components/tops-map/ClimateControlsPanel";
import { ClimateHoverReadout } from "@/components/tops-map/ClimateHoverReadout";
import { TemporalStabilityPanel } from "@/components/tops-map/TemporalStabilityPanel";
import { OCEANS_TOTAL_COUNT } from "@/components/tops-map/FullScreenOverlay";
import type { useRockStrataOverlay } from "@/hooks/useRockStrataOverlay";
import type { ClimateSampleResult, useClimateOverlay } from "@/hooks/useClimateOverlay";
import type { useTemporalStabilityOverlay } from "@/hooks/useTemporalStabilityOverlay";
import { useTranslation } from "@/lib/i18n";

interface AdvancedLayersSectionProps {
  showAdvancedMapOptions: boolean;
  showOceans: boolean;
  setShowOceans: (next: boolean) => void;
  showRecordedBrokenTLs: boolean;
  setShowRecordedBrokenTLs: (next: boolean) => void;
  recordedBrokenTLsCount: number;
  showRapids: boolean;
  setShowRapids: (next: boolean) => void;
  rapidsCount: number;
  showTraderClaims: boolean;
  setShowTraderClaims: (next: boolean) => void;
  traderClaimsCount: number;
  auctionLayer: AuctionLayer;
  setAuctionLayer: (next: AuctionLayer) => void;
  auctionOpacity: number;
  setAuctionOpacity: (next: number) => void;
  showRockStrata: boolean;
  setShowRockStrata: (next: boolean) => void;
  rockStrataKind: "rock" | "geo";
  setRockStrataKind: (next: "rock" | "geo") => void;
  rockStrataKeepCodes: string[] | null;
  setRockStrataKeepCodes: (next: string[] | null) => void;
  rockStrataHalfBlocks: number;
  setRockStrataHalfBlocks: (next: number) => void;
  rockStrataOpacity: number;
  setRockStrataOpacity: (next: number) => void;
  rockStrataLegend: ReturnType<typeof useRockStrataOverlay>["legend"];
  rockStrataWarnBlocky: ReturnType<typeof useRockStrataOverlay>["warnBlocky"];
  rockStrataSourceBlocksPerPixel: ReturnType<typeof useRockStrataOverlay>["sourceBlocksPerPixel"];
  rockStrataStatus: ReturnType<typeof useRockStrataOverlay>["status"];
  rockStrataError: ReturnType<typeof useRockStrataOverlay>["error"];
  usingWebCartographer: boolean;
  climateLayerMeta: ReturnType<typeof useClimateOverlay>["layerMeta"];
  climateStatus: ReturnType<typeof useClimateOverlay>["status"];
  climateError: ReturnType<typeof useClimateOverlay>["error"];
  climateVisible: boolean;
  climateHoverCoords: { x: number; z: number } | null;
  climateHoverSample: ClimateSampleResult | null;
  climateAltitudeY: number;
  stabilitySliceMeta: ReturnType<typeof useTemporalStabilityOverlay>["sliceMeta"];
  stabilityStatus: ReturnType<typeof useTemporalStabilityOverlay>["status"];
  stabilityError: ReturnType<typeof useTemporalStabilityOverlay>["error"];
}

/** Advanced-only overlay controls (oceans, broken TLs, rapids, claims,
 *  auction, rock strata, climate). Gated by `showAdvancedMapOptions`. */
export const AdvancedLayersSection = memo(function AdvancedLayersSection({
  showAdvancedMapOptions,
  showOceans,
  setShowOceans,
  showRecordedBrokenTLs,
  setShowRecordedBrokenTLs,
  recordedBrokenTLsCount,
  showRapids,
  setShowRapids,
  rapidsCount,
  showTraderClaims,
  setShowTraderClaims,
  traderClaimsCount,
  auctionLayer,
  setAuctionLayer,
  auctionOpacity,
  setAuctionOpacity,
  showRockStrata,
  setShowRockStrata,
  rockStrataKind,
  setRockStrataKind,
  rockStrataKeepCodes,
  setRockStrataKeepCodes,
  rockStrataHalfBlocks,
  setRockStrataHalfBlocks,
  rockStrataOpacity,
  setRockStrataOpacity,
  rockStrataLegend,
  rockStrataWarnBlocky,
  rockStrataSourceBlocksPerPixel,
  rockStrataStatus,
  rockStrataError,
  usingWebCartographer,
  climateLayerMeta,
  climateStatus,
  climateError,
  climateVisible,
  climateHoverCoords,
  climateHoverSample,
  climateAltitudeY,
  stabilitySliceMeta,
  stabilityStatus,
  stabilityError,
}: AdvancedLayersSectionProps) {
  const { t } = useTranslation();
  return (
    <CollapsibleSection
      title={t("topsMap.layerGroups.advanced")}
      icon={<SlidersHorizontal className="size-4 text-muted-foreground" />}
    >
      {showAdvancedMapOptions && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Switch
            checked={showOceans}
            onCheckedChange={setShowOceans}
            aria-label={t("topsMap.showOceansOverlay")}
          />
          <Label>{t("topsMap.oceans")}</Label>
          <span className="text-xs text-muted-foreground ml-2">
            {t("topsMap.totalCount", { count: OCEANS_TOTAL_COUNT.toLocaleString() })}
          </span>
        </div>
      )}
      {showAdvancedMapOptions && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Switch
            checked={showRecordedBrokenTLs}
            onCheckedChange={setShowRecordedBrokenTLs}
            aria-label={t("topsMap.showRecordedBrokenTLsOverlay")}
          />
          <Label>{t("topsMap.showRecordedBrokenTLs")}</Label>
          <span className="text-xs text-muted-foreground ml-2">
            {t("topsMap.recordedBrokenTLsFound")}{" "}
            <span className="font-medium text-foreground">
              {recordedBrokenTLsCount.toLocaleString()}
            </span>
          </span>
        </div>
      )}
      {showAdvancedMapOptions && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Switch
            checked={showRapids}
            onCheckedChange={setShowRapids}
            aria-label={t("topsMap.showRapidsOverlay")}
          />
          <Label>{t("topsMap.showRapids")}</Label>
          <span className="text-xs text-muted-foreground ml-2">
            {t("topsMap.rapidsFound")}{" "}
            <span className="font-medium text-foreground">{rapidsCount.toLocaleString()}</span>
          </span>
        </div>
      )}
      {showAdvancedMapOptions && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Switch
            checked={showTraderClaims}
            onCheckedChange={setShowTraderClaims}
            aria-label={t("topsMap.showTraderClaimsOverlay")}
          />
          <Label>{t("topsMap.showTraderClaims")}</Label>
          <span className="text-xs text-muted-foreground ml-2">
            {t("topsMap.traderClaimsFound")}{" "}
            <span className="font-medium text-foreground">
              {traderClaimsCount.toLocaleString()}
            </span>
          </span>
        </div>
      )}
      <PlayerClaimsControl />
      <AuctionHeatmapControl
        layer={auctionLayer}
        onLayerChange={setAuctionLayer}
        opacity={auctionOpacity}
        onOpacityChange={setAuctionOpacity}
      />
      <RockStrataLegendPanel
        enabled={showRockStrata}
        onEnabledChange={setShowRockStrata}
        layerKind={rockStrataKind}
        onLayerKindChange={setRockStrataKind}
        halfBlocks={rockStrataHalfBlocks}
        onHalfBlocksChange={setRockStrataHalfBlocks}
        opacity={rockStrataOpacity}
        onOpacityChange={setRockStrataOpacity}
        keepCodes={rockStrataKeepCodes}
        onKeepCodesChange={setRockStrataKeepCodes}
        legend={rockStrataLegend}
        warnBlocky={rockStrataWarnBlocky}
        sourceBlocksPerPixel={rockStrataSourceBlocksPerPixel}
        status={rockStrataStatus}
        error={rockStrataError}
      />
      {usingWebCartographer && (
        <ClimateControlsPanel
          layerMeta={climateLayerMeta}
          status={climateStatus}
          error={climateError}
        />
      )}
      {usingWebCartographer && (
        <TemporalStabilityPanel
          sliceMeta={stabilitySliceMeta}
          status={stabilityStatus}
          error={stabilityError}
        />
      )}
      {climateVisible && (
        <ClimateHoverReadout
          hoverCoords={climateHoverCoords}
          sample={climateHoverSample}
          visible={climateVisible}
          altitudeY={climateAltitudeY}
        />
      )}
    </CollapsibleSection>
  );
});
