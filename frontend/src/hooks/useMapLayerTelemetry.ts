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
    flush,
    type AdvancedLayersState,
} from "@/lib/mapLayerTelemetry";
import type { AuctionLayer } from "@/components/tops-map/AuctionHeatmapControl";

export function useMapLayerTelemetry(auctionLayer: AuctionLayer): void {
    const showAdvancedMapOptions = useAppSelector((s) => s.mapView.showAdvancedMapOptions);

    const showOceans = useAppSelector((s) => s.mapView.showOceans);
    const showRecordedBrokenTLs = useAppSelector((s) => s.mapView.showRecordedBrokenTLs);
    const showRapids = useAppSelector((s) => s.mapView.showRapids);
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

    const auctionHeatmapOpacity = useAppSelector((s) => s.mapView.auctionHeatmapOpacity);

    const state = useMemo<AdvancedLayersState>(
        () => ({
            oceans: { enabled: showOceans, settings: {} },
            broken_tls: { enabled: showRecordedBrokenTLs, settings: {} },
            rapids: { enabled: showRapids, settings: {} },
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
            auction_heatmap: {
                enabled: auctionLayer !== "off",
                settings: { layer: auctionLayer, opacity: auctionHeatmapOpacity },
            },
        }),
        [
            showOceans,
            showRecordedBrokenTLs,
            showRapids,
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
