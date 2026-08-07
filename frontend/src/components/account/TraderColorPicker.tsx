// Per-trader-type color customization for the Preferences → Appearance panel.
// Writes overrides to the `mapView.traderColors` slice (persisted via the
// root envelope once storage consent is granted). Each row shows a native
// color picker seeded with the effective color; a per-row reset appears once
// a type has been customized.

import { useTranslation } from "@/lib/i18n";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useReduxState } from "@/store/hooks";
import { resetTraderColors, setTraderColor } from "@/store/slices/mapView";
import { useTraderColors } from "@/hooks/useTraderColors";
import { TRADER_TYPES, TRADER_TYPE_LABELS } from "@/lib/trader-types";

export function TraderColorPicker() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const overrides = useReduxState("mapView.traderColors");
  const colors = useTraderColors();
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <Label>{t("account.appearance.traderColorsTitle")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("account.appearance.traderColorsDescription")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!hasOverrides}
          onClick={() => dispatch(resetTraderColors())}
        >
          {t("account.appearance.traderColorsResetAll")}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {TRADER_TYPES.map((type) => {
          const value = colors[type];
          const customized = overrides[type] != null;
          const inputId = `trader-color-${type}`;
          return (
            <div
              key={type}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5"
            >
              <input
                id={inputId}
                type="color"
                value={value}
                onChange={(e) => dispatch(setTraderColor({ type, color: e.target.value }))}
                aria-label={TRADER_TYPE_LABELS[type]}
                className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
              />
              <Label
                htmlFor={inputId}
                className="flex-1 cursor-pointer truncate text-xs font-medium"
              >
                {TRADER_TYPE_LABELS[type]}
              </Label>
              {customized && (
                <button
                  type="button"
                  onClick={() => dispatch(setTraderColor({ type, color: null }))}
                  className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t("account.appearance.traderColorsResetOne")}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
