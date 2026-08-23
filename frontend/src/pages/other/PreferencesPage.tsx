import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkerStylePicker } from "@/components/account/MarkerStylePicker";
import { TraderColorPicker } from "@/components/account/TraderColorPicker";
import { DateFormatSwitcher } from "@/components/DateFormatSwitcher";
import { useTranslation } from "@/lib/i18n";
import { useAppDispatch, useReduxState } from "@/store/hooks";
import {
  setStarfieldEnabled,
  setShowAdvancedMapOptions,
  setWCTileCacheEnabled,
} from "@/store/slices/mapView";

// Site/webmap look-and-feel preferences. These are purely local (Redux +
// localStorage) and require no account — anyone can tweak how the map looks
// without registering.
export function PreferencesPage() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const starfieldEnabled = useReduxState("mapView.starfieldEnabled");
  const showAdvancedMapOptions = useReduxState("mapView.showAdvancedMapOptions");
  const wcTileCacheEnabled = useReduxState("mapView.wcTileCacheEnabled");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("preferencesPage.title")}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">{t("preferencesPage.description")}</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("account.appearance.title")}</CardTitle>
          <CardDescription>{t("account.appearance.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="starfield-toggle">{t("account.appearance.starfieldLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("account.appearance.starfieldDescription")}
              </p>
            </div>
            <Switch
              id="starfield-toggle"
              checked={starfieldEnabled}
              onCheckedChange={(v) => dispatch(setStarfieldEnabled(v))}
            />
          </div>
          <Separator className="my-3" />
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="advanced-map-options-toggle">
                {t("account.appearance.advancedMapOptionsLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("account.appearance.advancedMapOptionsDescription")}
              </p>
            </div>
            <Switch
              id="advanced-map-options-toggle"
              checked={showAdvancedMapOptions}
              disabled
              onCheckedChange={(v) => dispatch(setShowAdvancedMapOptions(v))}
            />
          </div>
          <Separator className="my-3" />
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="wc-tile-cache-toggle">
                {t("account.appearance.wcTileCacheLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("account.appearance.wcTileCacheDescription")}
              </p>
            </div>
            <Switch
              id="wc-tile-cache-toggle"
              checked={wcTileCacheEnabled}
              onCheckedChange={(v) => dispatch(setWCTileCacheEnabled(v))}
            />
          </div>
          <Separator className="my-3" />
          <div className="space-y-2">
            <div className="space-y-0.5">
              <Label>{t("account.appearance.markerIconsTitle")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("account.appearance.markerIconsDescription")}
              </p>
            </div>
            <MarkerStylePicker />
          </div>
          <Separator className="my-3" />
          <TraderColorPicker />
          <Separator className="my-3" />
          <div className="space-y-2">
            <div className="space-y-0.5">
              <Label>{t("account.appearance.dateFormatTitle")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("account.appearance.dateFormatDescription")}
              </p>
            </div>
            <DateFormatSwitcher />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
