import { useCallback, useState } from "react";
import {
    Crosshair,
    Loader2,
    MapPin,
    Sailboat,
    Trash2,
    ArrowLeftRight,
    X,
    Ship,
    Settings2,
    ChevronDown,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { parseCoordsInput } from "./EndpointPicker";
import type { EndpointPick } from "@/store/slices/routePlanner";
import {
    clearSailboatRoute,
    setSailboatDebugTiles,
    setSailboatFrom,
    setSailboatLandPenalty,
    setSailboatMaxTiles,
    setSailboatMaxVisited,
    setSailboatOpen,
    setSailboatPickMode,
    setSailboatTlHopCost,
    setSailboatTo,
    swapSailboatEndpoints,
    type SailboatPickMode,
} from "@/store/slices/sailboatRoute";
import { useSailboatRoute } from "@/hooks/useSailboatRoute";
import type { SailboatTL, SailboatRouteFailure } from "@/lib/sailboat/sailboat-routing";

type TFn = ReturnType<typeof useTranslation>["t"];

function failureMessage(reason: SailboatRouteFailure | undefined, t: TFn): string {
    switch (reason) {
        case "no_data_at_start":
            return t("sailboatPlanner.failure.no_data_at_start");
        case "no_data_at_dest":
            return t("sailboatPlanner.failure.no_data_at_dest");
        case "search_exhausted":
            return t("sailboatPlanner.failure.search_exhausted");
        case "unreachable":
        default:
            return t("sailboatPlanner.failure.unreachable");
    }
}

interface SailboatRoutePlannerPanelProps {
    /** WebCartographer host tiles are proxied from. */
    baseUrl: string;
    /** Tile extension served by the host. */
    ext: "png" | "webp";
    /** Boat-friendly TLs (both endpoints), derived from the overlay. */
    boatTLs: SailboatTL[];
}

function formatPoint(p: EndpointPick | null): string {
    if (!p) return "";
    if (p.label) return p.label;
    return `${Math.round(p.point.x)}, ${Math.round(p.point.z)}`;
}

/** Compact From/To row with "pick on map" + coordinate paste. Self-contained
 *  (the shared EndpointPicker is bound to the walking route-planner slice). */
function SailboatEndpointRow({ slot, label }: { slot: "from" | "to"; label: string }) {
    const { t } = useTranslation();
    const dispatch = useAppDispatch();
    const value = useAppSelector((s) => (slot === "from" ? s.sailboatRoute.from : s.sailboatRoute.to));
    const pickMode = useAppSelector((s) => s.sailboatRoute.pickMode);
    const isPicking = pickMode === (slot as SailboatPickMode);
    const [text, setText] = useState("");
    const [err, setErr] = useState<string | null>(null);

    const setSlot = useCallback(
        (next: EndpointPick | null) => {
            dispatch(slot === "from" ? setSailboatFrom(next) : setSailboatTo(next));
        },
        [dispatch, slot],
    );

    const applyPaste = useCallback(() => {
        const parsed = parseCoordsInput(text);
        if (!parsed) {
            setErr(t("sailboatPlanner.invalidCoords"));
            return;
        }
        setErr(null);
        setText("");
        setSlot({ point: parsed, source: "paste" });
    }, [text, setSlot, t]);

    return (
        <div className="space-y-1.5">
            <Label className="text-xs font-medium">{label}</Label>
            <div className="flex items-center gap-1.5">
                <Button
                    type="button"
                    size="sm"
                    variant={isPicking ? "default" : "secondary"}
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() =>
                        dispatch(setSailboatPickMode(isPicking ? null : (slot as SailboatPickMode)))
                    }
                    aria-pressed={isPicking}
                >
                    <Crosshair className="h-3 w-3" />
                    {slot === "from" ? t("sailboatPlanner.pickFrom") : t("sailboatPlanner.pickTo")}
                </Button>
                {value && (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3 shrink-0" />
                        <span className="truncate font-mono">{formatPoint(value)}</span>
                        <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            className="h-5 w-5"
                            onClick={() => setSlot(null)}
                            aria-label={t("sailboatPlanner.clearPoint")}
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    </span>
                )}
            </div>
            <div className="flex items-center gap-1.5">
                <Input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") applyPaste();
                    }}
                    placeholder="x, z"
                    className="h-7 text-xs"
                />
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    onClick={applyPaste}
                    disabled={!text.trim()}
                >
                    {t("sailboatPlanner.set")}
                </Button>
            </div>
            {err && <p className="text-[11px] text-red-600">{err}</p>}
        </div>
    );
}

export function SailboatRoutePlannerPanel({ baseUrl, ext, boatTLs }: SailboatRoutePlannerPanelProps) {
    const { t } = useTranslation();
    const dispatch = useAppDispatch();
    const isOpen = useAppSelector((s) => s.sailboatRoute.isOpen);
    const from = useAppSelector((s) => s.sailboatRoute.from);
    const to = useAppSelector((s) => s.sailboatRoute.to);
    const route = useAppSelector((s) => s.sailboatRoute.route);
    const isComputing = useAppSelector((s) => s.sailboatRoute.isComputing);
    const progressVisited = useAppSelector((s) => s.sailboatRoute.progressVisited);
    const error = useAppSelector((s) => s.sailboatRoute.error);
    const debugTiles = useAppSelector((s) => s.sailboatRoute.debugTiles);
    const landPenalty = useAppSelector((s) => s.sailboatRoute.landPenalty);
    const tlHopCost = useAppSelector((s) => s.sailboatRoute.tlHopCost);
    const maxTiles = useAppSelector((s) => s.sailboatRoute.maxTiles);
    const maxVisited = useAppSelector((s) => s.sailboatRoute.maxVisited);
    const [settingsOpen, setSettingsOpen] = useState(false);

    const { compute, cancel } = useSailboatRoute({ baseUrl, ext, boatTLs });

    if (!isOpen) return null;

    const canCompute = !!from && !!to && !isComputing;

    return (
        <aside
            className="fixed right-3 top-3 bottom-3 z-40 flex w-[min(440px,calc(100vw-1.5rem))] flex-col gap-0 rounded-lg border bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10"
            role="dialog"
            aria-label={t("sailboatPlanner.panelAriaLabel")}
        >
            <header className="flex items-start gap-2 border-b px-4 py-3">
                <div className="min-w-0 flex-1">
                    <h2 className="flex items-center gap-2 text-base font-medium leading-none">
                        <Sailboat className="h-4 w-4 text-sky-500" />
                        {t("sailboatPlanner.title")}
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {t("sailboatPlanner.description")}
                    </p>
                </div>
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => dispatch(setSailboatOpen(false))}
                    aria-label={t("sailboatPlanner.close")}
                >
                    <X className="h-4 w-4" />
                </Button>
            </header>

            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
                <SailboatEndpointRow slot="from" label={t("sailboatPlanner.from")} />
                <div className="flex items-center justify-center gap-1">
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-xs"
                        onClick={() => dispatch(swapSailboatEndpoints())}
                        disabled={!from && !to}
                    >
                        <ArrowLeftRight className="h-3 w-3" />
                        {t("sailboatPlanner.swap")}
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-xs text-red-600 hover:text-red-700"
                        onClick={() => dispatch(clearSailboatRoute())}
                        disabled={!from && !to && !route}
                    >
                        <Trash2 className="h-3 w-3" />
                        {t("sailboatPlanner.clear")}
                    </Button>
                </div>
                <SailboatEndpointRow slot="to" label={t("sailboatPlanner.to")} />

                <div className="pt-1">
                    {isComputing ? (
                        <Button
                            type="button"
                            variant="secondary"
                            className="w-full gap-2"
                            onClick={cancel}
                        >
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t("sailboatPlanner.cancel")}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            className="w-full gap-2 bg-sky-600 text-white hover:bg-sky-700"
                            onClick={() => void compute()}
                            disabled={!canCompute}
                        >
                            <Sailboat className="h-4 w-4" />
                            {t("sailboatPlanner.findRoute")}
                        </Button>
                    )}
                </div>

                {!from && <p className="text-xs text-muted-foreground">{t("sailboatPlanner.noFrom")}</p>}
                {from && !to && (
                    <p className="text-xs text-muted-foreground">{t("sailboatPlanner.noTo")}</p>
                )}

                {isComputing && (
                    <p className="text-[11px] text-muted-foreground">
                        {t("sailboatPlanner.computing")}{" "}
                        <span className="font-mono tabular-nums">
                            {progressVisited.toLocaleString()}
                        </span>
                    </p>
                )}

                {error && <p className="text-xs text-red-600">{error}</p>}

                {route && !isComputing && (
                    <div
                        className={cn(
                            "space-y-1.5 rounded-md border p-3 text-xs",
                            route.found
                                ? "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-100"
                                : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100",
                        )}
                    >
                        {route.found ? (
                            <>
                                <p className="flex items-center gap-1.5 font-medium">
                                    <Ship className="h-3.5 w-3.5" />
                                    {t("sailboatPlanner.resultFound")}
                                </p>
                                <p className="flex items-center justify-between">
                                    <span className="text-muted-foreground">
                                        {t("sailboatPlanner.waterDistance")}
                                    </span>
                                    <span className="font-mono tabular-nums">
                                        {t("sailboatPlanner.blocks", {
                                            count: Math.round(route.waterBlocks),
                                        })}
                                    </span>
                                </p>
                                {route.terrainBlocks > 0 && (
                                    <p className="flex items-center justify-between">
                                        <span className="text-muted-foreground">
                                            {t("sailboatPlanner.terrainDistance")}
                                        </span>
                                        <span className="font-mono tabular-nums text-amber-700 dark:text-amber-300">
                                            {t("sailboatPlanner.blocks", {
                                                count: Math.round(route.terrainBlocks),
                                            })}
                                        </span>
                                    </p>
                                )}
                                {route.tlHops > 0 && (
                                    <p className="flex items-center justify-between">
                                        <span className="text-muted-foreground">
                                            {t("sailboatPlanner.tlHops")}
                                        </span>
                                        <span className="font-mono tabular-nums">{route.tlHops}</span>
                                    </p>
                                )}
                                {route.terrainBlocks > 0 && (
                                    <p className="pt-0.5 text-[11px] text-muted-foreground">
                                        {t("sailboatPlanner.terrainNote")}
                                    </p>
                                )}
                            </>
                        ) : (
                            <p>{failureMessage(route.reason, t)}</p>
                        )}
                    </div>
                )}

                {/* Cost-model + search-budget settings (collapsible, mirrors
                    the route planner). Sliders dispatch immediately; changing
                    any clears the stale route via the slice. */}
                <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-muted-foreground">
                        {t("sailboatPlanner.settingsSummary", {
                            landPenalty,
                            tlHopCost,
                        })}
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={() => setSettingsOpen((v) => !v)}
                        aria-expanded={settingsOpen}
                    >
                        <Settings2 className="h-3 w-3" /> {t("sailboatPlanner.settings")}
                        <ChevronDown
                            className={cn(
                                "h-3 w-3 transition-transform duration-200",
                                settingsOpen && "rotate-180",
                            )}
                        />
                    </Button>
                </div>

                <div
                    data-open={settingsOpen}
                    className={cn(
                        "grid transition-[grid-template-rows] duration-200 ease-out",
                        settingsOpen ? "grid-rows-[1fr]" : "mt-0! grid-rows-[0fr]",
                    )}
                    aria-hidden={!settingsOpen}
                >
                    <div className="overflow-hidden">
                        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                            <div className="space-y-1">
                                <Label className="flex items-center justify-between text-xs">
                                    <span>{t("sailboatPlanner.landPenalty")}</span>
                                    <span className="font-mono text-muted-foreground">
                                        {t("sailboatPlanner.landPenaltyValue", {
                                            value: landPenalty,
                                        })}
                                    </span>
                                </Label>
                                <Slider
                                    min={1}
                                    max={30}
                                    step={1}
                                    value={landPenalty}
                                    onValueChange={(v) => dispatch(setSailboatLandPenalty(v))}
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    {t("sailboatPlanner.landPenaltyHelp")}
                                </p>
                            </div>
                            <div className="space-y-1">
                                <Label className="flex items-center justify-between text-xs">
                                    <span>{t("sailboatPlanner.tlHopCost")}</span>
                                    <span className="font-mono text-muted-foreground">
                                        {t("sailboatPlanner.tlHopCostValue", {
                                            value: tlHopCost,
                                        })}
                                    </span>
                                </Label>
                                <Slider
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={tlHopCost}
                                    onValueChange={(v) => dispatch(setSailboatTlHopCost(v))}
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    {t("sailboatPlanner.tlHopCostHelp")}
                                </p>
                            </div>
                            <div className="space-y-1">
                                <Label className="flex items-center justify-between text-xs">
                                    <span>{t("sailboatPlanner.maxTiles")}</span>
                                    <span className="font-mono text-muted-foreground">
                                        {t("sailboatPlanner.maxTilesValue", {
                                            value: maxTiles,
                                        })}
                                    </span>
                                </Label>
                                <Slider
                                    min={50}
                                    max={1000}
                                    step={50}
                                    value={maxTiles}
                                    onValueChange={(v) => dispatch(setSailboatMaxTiles(v))}
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    {t("sailboatPlanner.maxTilesHelp")}
                                </p>
                            </div>
                            <div className="space-y-1">
                                <Label className="flex items-center justify-between text-xs">
                                    <span>{t("sailboatPlanner.maxVisited")}</span>
                                    <span className="font-mono text-muted-foreground">
                                        {t("sailboatPlanner.maxVisitedValue", {
                                            value: (maxVisited / 1_000_000).toFixed(1),
                                        })}
                                    </span>
                                </Label>
                                <Slider
                                    min={500_000}
                                    max={10_000_000}
                                    step={500_000}
                                    value={maxVisited}
                                    onValueChange={(v) => dispatch(setSailboatMaxVisited(v))}
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    {t("sailboatPlanner.maxVisitedHelp")}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mt-1 space-y-1.5 rounded-md border border-dashed border-muted-foreground/30 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="sailboat-debug-tiles" className="text-xs font-medium">
                            {t("sailboatPlanner.debugTiles")}
                        </Label>
                        <Switch
                            id="sailboat-debug-tiles"
                            checked={debugTiles}
                            onCheckedChange={(v) => dispatch(setSailboatDebugTiles(v))}
                        />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        {t("sailboatPlanner.debugTilesHint")}
                    </p>
                </div>
            </div>
        </aside>
    );
}
