import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslation } from "@/lib/i18n";
import { computeRockPricing, type RarityCurve } from "@/lib/rockstrata/pricing";
import { getLayerLegend } from "@/lib/rockstrata/loader";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  resetRockPricing,
  setRockBase,
  setRockBoost,
  setRockCracked,
  setRockCurve,
  setRockPolished,
} from "@/store/slices/rockPricing";
import { formatGears } from "@/lib/auction";

const CURVES: RarityCurve[] = ["linear", "sqrt", "log"];

/** A number input bound to the store, with a labelled hint. */
function ConfigField({
  id,
  label,
  hint,
  value,
  min,
  step,
  onCommit,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  step: number;
  onCommit: (n: number) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onCommit(n);
        }}
        className="bg-amber-50 dark:bg-amber-950/30"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function RockRarityPage() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const config = useAppSelector((s) => s.rockPricing);

  // The legend is bundled with the app (same source the tops-map rock
  // overlay uses), so this is a synchronous read.
  const legend = getLayerLegend("rock") ?? [];
  const rows = useMemo(() => computeRockPricing(legend, config), [legend, config]);

  const nf = useMemo(() => new Intl.NumberFormat(), []);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("rarityPage.rocks.title")}</CardTitle>
          <CardDescription>{t("rarityPage.rocks.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>{t("rarityPage.rocks.intro")}</p>
          <p>{t("rarityPage.rocks.igneousNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("rarityPage.rocks.inputsTitle")}</CardTitle>
          <CardDescription>{t("rarityPage.rocks.inputsSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ConfigField
              id="rock-base"
              label={t("rarityPage.rocks.basePrice")}
              hint={t("rarityPage.rocks.basePriceHint")}
              value={config.base}
              min={0}
              step={1}
              onCommit={(n) => dispatch(setRockBase(n))}
            />
            <ConfigField
              id="rock-boost"
              label={t("rarityPage.rocks.igneousBoost")}
              hint={t("rarityPage.rocks.igneousBoostHint")}
              value={config.boost}
              min={1}
              step={0.5}
              onCommit={(n) => dispatch(setRockBoost(n))}
            />
            <ConfigField
              id="rock-polished"
              label={t("rarityPage.rocks.polishedMult")}
              hint={t("rarityPage.rocks.polishedMultHint")}
              value={config.polished}
              min={0}
              step={0.5}
              onCommit={(n) => dispatch(setRockPolished(n))}
            />
            <ConfigField
              id="rock-cracked"
              label={t("rarityPage.rocks.crackedMult")}
              hint={t("rarityPage.rocks.crackedMultHint")}
              value={config.cracked}
              min={0}
              step={0.5}
              onCommit={(n) => dispatch(setRockCracked(n))}
            />
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {t("rarityPage.rocks.curveLabel")}
              </span>
              <Tabs
                value={config.curve}
                onValueChange={(v) => dispatch(setRockCurve(v as RarityCurve))}
              >
                <TabsList variant="line">
                  {CURVES.map((c) => (
                    <TabsTrigger key={c} value={c}>
                      {t(`rarityPage.rocks.curve.${c}` as const)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {config.curve === "sqrt" && (
                <Badge variant="secondary">{t("rarityPage.rocks.recommended")}</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(`rarityPage.rocks.curveDesc.${config.curve}` as const)}
            </p>
          </div>

          <div>
            <Button variant="outline" size="sm" onClick={() => dispatch(resetRockPricing())}>
              {t("rarityPage.rocks.reset")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("rarityPage.rocks.tableTitle")}</CardTitle>
          <CardDescription>{t("rarityPage.rocks.tableSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("rarityPage.rocks.noData")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("rarityPage.rocks.colRock")}</TableHead>
                  <TableHead className="text-right">{t("rarityPage.rocks.colRarity")}</TableHead>
                  <TableHead className="text-right">{t("rarityPage.rocks.colRatio")}</TableHead>
                  <TableHead className="text-right">{t("rarityPage.rocks.colAshlar")}</TableHead>
                  <TableHead className="text-right">{t("rarityPage.rocks.colPolished")}</TableHead>
                  <TableHead className="text-right">{t("rarityPage.rocks.colCracked")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.code}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-block size-3.5 shrink-0 rounded-sm border border-border"
                          style={{ backgroundColor: r.hexcolor }}
                        />
                        <span className="font-medium text-foreground">{r.label}</span>
                        {r.isIgneous && (
                          <Badge variant="outline">{t("rarityPage.rocks.igneous")}</Badge>
                        )}
                        {r.isReference && (
                          <Badge variant="ghost">{t("rarityPage.rocks.reference")}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(r.boostedPct * 100).toFixed(2)}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.ratio.toFixed(2)}×</TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-foreground">
                      {formatGears(r.ashlar)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGears(r.polished)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGears(r.cracked)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {t("rarityPage.rocks.tableFootnote")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
