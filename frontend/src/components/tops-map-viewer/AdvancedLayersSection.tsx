import { memo } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CollapsibleSection } from "@/components/tops-map/CollapsibleSection";
import { PlayerClaimsControl } from "@/components/tops-map/PlayerClaimsControl";
import { RapidsControl } from "@/components/tops-map/RapidsControl";
import {
  AuctionHeatmapControl,
  type AuctionLayer,
} from "@/components/tops-map/AuctionHeatmapControl";
import { RockStrataLegendPanel } from "@/components/tops-map/RockStrataLegendPanel";
import { ClimateControlsPanel } from "@/components/tops-map/ClimateControlsPanel";
import { ClimateHoverReadout } from "@/components/tops-map/ClimateHoverReadout";
import { TemporalStabilityPanel } from "@/components/tops-map/TemporalStabilityPanel";
import { ElevationPanel } from "@/components/tops-map/ElevationPanel";
import { ElevationHoverReadout } from "@/components/tops-map/ElevationHoverReadout";
import { OCEANS_TOTAL_COUNT } from "@/components/tops-map/FullScreenOverlay";
import type { useRockStrataOverlay } from "@/hooks/useRockStrataOverlay";
import type { ClimateSampleResult, useClimateOverlay } from "@/hooks/useClimateOverlay";
import type { useTemporalStabilityOverlay } from "@/hooks/useTemporalStabilityOverlay";
import type { useElevationOverlay } from "@/hooks/useElevationOverlay";
import type { ElevationSample } from "@/lib/elevation/types";
import { useTranslation } from "@/lib/i18n";

interface AdvancedLayersSectionProps {
  showAdvancedMapOptions: boolean;
  showOceans: boolean;
  setShowOceans: (next: boolean) => void;
  showRecordedBrokenTLs: boolean;
  setShowRecordedBrokenTLs: (next: boolean) => void;
  recordedBrokenTLsCount: number;
  /** Only registered account holders (not API-key-only users) see the broken TL toggle. */
  hasAccount: boolean;
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
  elevationStatus: ReturnType<typeof useElevationOverlay>["status"];
  elevationError: ReturnType<typeof useElevationOverlay>["error"];
  elevationVisible: boolean;
  elevationHoverCoords: { x: number; z: number } | null;
  elevationHoverSample: ElevationSample | null;
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
  hasAccount,
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
  elevationStatus,
  elevationError,
  elevationVisible,
  elevationHoverCoords,
  elevationHoverSample,
}: AdvancedLayersSectionProps) {
  const { t } = useTranslation();
  return (
    <CollapsibleSection
      title={t("topsMap.layerGroups.worldData")}
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
      {/* Analyze-first ordering: headline world-data layers, then niche overlays. */}
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
      {usingWebCartographer && <ElevationPanel status={elevationStatus} error={elevationError} />}
      {climateVisible && (
        <ClimateHoverReadout
          hoverCoords={climateHoverCoords}
          sample={climateHoverSample}
          visible={climateVisible}
          altitudeY={climateAltitudeY}
        />
      )}
      {usingWebCartographer && elevationVisible && (
        <ElevationHoverReadout hoverCoords={elevationHoverCoords} sample={elevationHoverSample} />
      )}
      <AuctionHeatmapControl
        layer={auctionLayer}
        onLayerChange={setAuctionLayer}
        opacity={auctionOpacity}
        onOpacityChange={setAuctionOpacity}
      />
      {showAdvancedMapOptions && hasAccount && (
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
      {showAdvancedMapOptions && <RapidsControl />}
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
    </CollapsibleSection>
  );
});
