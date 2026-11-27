/**
 * Drives the TOPS map advanced-layer usage telemetry (see
 * `lib/mapLayerTelemetry.ts`). Builds the canonical advanced-layer state from
 * the `mapView` slice (plus the component-local auction layer) and feeds it to
 * the diff engine on every change. Also wires the lifecycle flush so a
 * session's buffered events + open dwell intervals are sent on tab hide.
 *
 * Mounted once by TOPSMapViewPage — the only place these layers change. Inert
 * unless the account has advanced map options enabled.
 */

import { useEffect, useMemo } from "react";
import { useAppSelector } from "@/store/hooks";
import {
    syncLayerState,
    closeOpenDwell,
    resumeOpenDwell,
    flush,
    type AdvancedLayersState,
    type LayerSettings,
} from "@/lib/tops-map-view/mapLayerTelemetry";
import type { AuctionLayer } from "@/components/tops-map/AuctionHeatmapControl";

export function useMapLayerTelemetry(auctionLayer: AuctionLayer): void {
    const showAdvancedMapOptions = useAppSelector((s) => s.mapView.showAdvancedMapOptions);

    const showOceans = useAppSelector((s) => s.mapView.showOceans);
    const showRecordedBrokenTLs = useAppSelector((s) => s.mapView.showRecordedBrokenTLs);
    const showRapids = useAppSelector((s) => s.mapView.showRapids);
    const rapidsShowPredicted = useAppSelector((s) => s.mapView.rapidsShowPredicted);
    const rapidsMinLikelihood = useAppSelector((s) => s.mapView.rapidsMinLikelihood);
    const rapidsShowClaimed = useAppSelector((s) => s.mapView.rapidsShowClaimed);
    const showTraderClaims = useAppSelector((s) => s.mapView.showTraderClaims);

    const showPlayerClaims = useAppSelector((s) => s.mapView.showPlayerClaims);
    const playerClaimsMode = useAppSelector((s) => s.mapView.playerClaimsMode);
    const playerClaimsOpacity = useAppSelector((s) => s.mapView.playerClaimsOpacity);

    const showRockStrata = useAppSelector((s) => s.mapView.showRockStrata);
    const rockStrataKind = useAppSelector((s) => s.mapView.rockStrataKind);
    const rockStrataKeepCodes = useAppSelector((s) => s.mapView.rockStrataKeepCodes);
    const rockStrataHalfBlocks = useAppSelector((s) => s.mapView.rockStrataHalfBlocks);
    const rockStrataOpacity = useAppSelector((s) => s.mapView.rockStrataOpacity);

    const climateSubToggle = useAppSelector((s) => s.mapView.climateSubToggle);
    const climateTempVariant = useAppSelector((s) => s.mapView.climateTempVariant);
    const climateThresholdMode = useAppSelector((s) => s.mapView.climateThresholdMode);
    const climateCropIds = useAppSelector((s) => s.mapView.climateCropIds);
    const climateAltitudeY = useAppSelector((s) => s.mapView.climateAltitudeY);
    const climateOpacity = useAppSelector((s) => s.mapView.climateOpacity);

    const stabilityEnabled = useAppSelector((s) => s.mapView.stabilityEnabled);
    const stabilityYSlice = useAppSelector((s) => s.mapView.stabilityYSlice);
    const stabilityOpacity = useAppSelector((s) => s.mapView.stabilityOpacity);

    const elevationEnabled = useAppSelector((s) => s.mapView.elevationEnabled);
    const elevationMode = useAppSelector((s) => s.mapView.elevationMode);
    const elevationBandMin = useAppSelector((s) => s.mapView.elevationBandMin);
    const elevationBandMax = useAppSelector((s) => s.mapView.elevationBandMax);
    const elevationOpacity = useAppSelector((s) => s.mapView.elevationOpacity);

    const auctionHeatmapOpacity = useAppSelector((s) => s.mapView.auctionHeatmapOpacity);

    const state = useMemo<AdvancedLayersState>(
        () => ({
            oceans: { enabled: showOceans, settings: {} },
            broken_tls: { enabled: showRecordedBrokenTLs, settings: {} },
            rapids: {
                enabled: showRapids,
                settings: {
                    showPredicted: rapidsShowPredicted,
                    minLikelihood: rapidsMinLikelihood,
                    showClaimed: rapidsShowClaimed,
                },
            },
            trader_claims: { enabled: showTraderClaims, settings: {} },
            player_claims: {
                enabled: showPlayerClaims,
                settings: { mode: playerClaimsMode, opacity: playerClaimsOpacity },
            },
            rock_strata: {
                enabled: showRockStrata,
                settings: {
                    kind: rockStrataKind,
                    halfBlocks: rockStrataHalfBlocks,
                    opacity: rockStrataOpacity,
                    keepCount: rockStrataKeepCodes ? rockStrataKeepCodes.length : 0,
                },
            },
            climate: {
                enabled: climateSubToggle !== "off",
                settings: {
                    subToggle: climateSubToggle,
                    tempVariant: climateTempVariant,
                    thresholdMode: climateThresholdMode,
                    cropCount: climateCropIds.length,
                    altitudeY: climateAltitudeY,
                    opacity: climateOpacity,
                },
            },
            temporal_stability: {
                enabled: stabilityEnabled,
                settings: { ySlice: stabilityYSlice, opacity: stabilityOpacity },
            },
            elevation: {
                enabled: elevationEnabled,
                settings: (elevationMode === "band"
                    ? {
                          mode: elevationMode,
                          bandMin: elevationBandMin,
                          bandMax: elevationBandMax,
                          opacity: elevationOpacity,
                      }
                    : { mode: elevationMode, opacity: elevationOpacity }) as LayerSettings,
            },
            auction_heatmap: {
                enabled: auctionLayer !== "off",
                settings: { layer: auctionLayer, opacity: auctionHeatmapOpacity },
            },
        }),
        [
            showOceans,
            showRecordedBrokenTLs,
            showRapids,
            rapidsShowPredicted,
            rapidsMinLikelihood,
            rapidsShowClaimed,
            showTraderClaims,
            showPlayerClaims,
            playerClaimsMode,
            playerClaimsOpacity,
            showRockStrata,
            rockStrataKind,
            rockStrataKeepCodes,
            rockStrataHalfBlocks,
            rockStrataOpacity,
            climateSubToggle,
            climateTempVariant,
            climateThresholdMode,
            climateCropIds,
            climateAltitudeY,
            climateOpacity,
            stabilityEnabled,
            stabilityYSlice,
            stabilityOpacity,
            elevationEnabled,
            elevationMode,
            elevationBandMin,
            elevationBandMax,
            elevationOpacity,
            auctionLayer,
            auctionHeatmapOpacity,
        ],
    );

    // Only meaningful when the advanced-layers UI is available to the user.
    useEffect(() => {
        if (!showAdvancedMapOptions) return;
        syncLayerState(state);
    }, [showAdvancedMapOptions, state]);

    // Flush buffered events + close open dwell intervals when the tab hides or
    // unloads (mirrors PageViewTracker's lifecycle handling).
    useEffect(() => {
        const onHide = () => {
            closeOpenDwell();
            void flush(true);
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") onHide();
            else resumeOpenDwell();
        };
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", onHide);
        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("pagehide", onHide);
            onHide();
        };
    }, []);
}
