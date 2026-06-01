import { useState } from "react";
import { Crosshair, MapPin, Star, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/lib/i18n";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { removeRoutePlayer, setRoutePickMode, setRoutePlayer } from "@/store/slices/routePlanner";

import { parseCoordsInput } from "./EndpointPicker";

interface PlayerPickerProps {
  /** Zero-based slot into `state.routePlanner.players`. */
  index: number;
}

/**
 * Compact slot widget for one party member in rendezvous mode. Mirrors
 * the relevant subset of `EndpointPicker` (pick / paste / favorite home)
 * but stays narrow enough to stack 2–8 of them in the panel. Landmark
 * search is intentionally omitted — players typically know where they
 * currently are (map click or `/whereami` paste) and don't pick a
 * Terminus as their position.
 */
export function PlayerPicker({ index }: PlayerPickerProps) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const value = useAppSelector((s) => s.routePlanner.players[index] ?? null);
  const pickMode = useAppSelector((s) => s.routePlanner.pickMode);
  const favorite = useAppSelector((s) => s.mapView.favoriteStartingPosition);
  const canRemove = useAppSelector((s) => s.routePlanner.players.length > 2);

  const slotKey = `player:${index}` as const;
  const isPicking = pickMode === slotKey;

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  const togglePickMode = () => {
    dispatch(setRoutePickMode(isPicking ? null : slotKey));
  };

  const handleUseFavorite = () => {
    if (!favorite) return;
    dispatch(
      setRoutePlayer({
        index,
        pick: {
          point: { x: favorite.x, z: favorite.z },
          label: t("routePlanner.favoriteHome"),
          source: "favorite",
        },
      }),
    );
  };

  const handlePasteApply = () => {
    const parsed = parseCoordsInput(pasteText);
    if (!parsed) {
      setPasteError(t("routePlanner.parseCoordsError"));
      return;
    }
    dispatch(
      setRoutePlayer({
        index,
        pick: {
          point: parsed,
          label: `${parsed.x}, ${parsed.z}`,
          source: "paste",
        },
      }),
    );
    setPasteOpen(false);
    setPasteText("");
    setPasteError(null);
  };

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/20 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("routePlanner.playerLabel", { index: index + 1 })}
        </span>
        <div className="flex items-center gap-1">
          {value && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-xs"
              onClick={() => dispatch(setRoutePlayer({ index, pick: null }))}
              title={t("routePlanner.clearPlayerPosition")}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
          {canRemove && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-xs text-red-600 hover:text-red-700"
              onClick={() => dispatch(removeRoutePlayer(index))}
              title={t("routePlanner.removePlayerTitle")}
            >
              {t("routePlanner.removePlayer")}
            </Button>
          )}
        </div>
      </div>

      {/* Current value chip — colored marker so a populated row reads at a
          glance as "this player has been placed". */}
      <div className="rounded-md border bg-background px-2 py-1.5 text-xs">
        {value ? (
          <div className="flex items-center gap-2">
            <MapPin className="h-3 w-3 shrink-0 text-emerald-600" />
            <div className="min-w-0 flex-1 truncate">
              <span className="font-medium">{value.label ?? t("routePlanner.pickedPoint")}</span>
              <span className="ml-1 text-muted-foreground">
                ({value.point.x}, {value.point.z})
              </span>
            </div>
            <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
              {value.source}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">{t("routePlanner.notSet")}</span>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant={isPicking ? "default" : "outline"}
          className="h-7 flex-1 gap-1 px-2 text-xs"
          onClick={togglePickMode}
        >
          <Crosshair className="h-3 w-3" />
          {isPicking ? t("routePlanner.clickMap") : t("routePlanner.pickOnMap")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs flex-1"
          onClick={() => setPasteOpen((v) => !v)}
        >
          {t("routePlanner.input")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          disabled={!favorite}
          onClick={handleUseFavorite}
          title={favorite ? t("routePlanner.useFavoriteHome") : t("routePlanner.noFavoriteHome")}
        >
          <Star className="h-3 w-3" /> {t("routePlanner.home")}
        </Button>
      </div>

      {pasteOpen && (
        <div className="space-y-1 rounded border bg-background p-2">
          <Input
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              if (pasteError) setPasteError(null);
            }}
            placeholder={t("routePlanner.pasteCoordsPlaceholderShort")}
            className="h-7 font-mono text-xs"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") handlePasteApply();
            }}
          />
          {pasteError && <p className="text-[10px] text-red-600 dark:text-red-400">{pasteError}</p>}
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setPasteOpen(false);
                setPasteText("");
                setPasteError(null);
              }}
            >
              {t("routePlanner.cancel")}
            </Button>
            <Button
              size="sm"
              variant="default"
              className="h-6 px-2 text-xs"
              onClick={handlePasteApply}
            >
              {t("routePlanner.apply")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
