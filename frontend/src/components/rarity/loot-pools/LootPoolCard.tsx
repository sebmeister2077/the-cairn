import type { LootPool, LootPoolCategory, Rarity } from "@/models/loot-pools";
import { useState } from "react";
import { ChevronDown, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/helpers/utils";
import { useTranslation } from "@/lib/i18n";
import {
  prettifyItemCode,
  RARITY_COLORS,
  RARITY_LABELS,
  formatQuantity,
} from "@/lib/market/loot-pools";
import { Link } from "react-router-dom";

export const RARITY_LEGEND: Rarity[] = [
  "common",
  "uncommon",
  "rare",
  "very_rare",
  "legendary",
  "unique",
];

/**
 * Maps a loot item's bare code to its Auction House catalog id (when it has
 * appeared on the Market), so we can hint that + link to the item page.
 */
export type MarketIndex = Map<string, number>;
export function PoolCard({
  pool,
  forceOpen,
  marketIndex,
}: {
  pool: LootPool;
  forceOpen?: boolean;
  marketIndex: MarketIndex;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isOpen = open || !!forceOpen;
  return (
    <Card>
      <CardHeader className="p-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={isOpen}
          className="flex w-full cursor-pointer select-none items-center gap-2 px-6 py-4 text-left"
        >
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <CardTitle className="text-base">{pool.label}</CardTitle>
            <Badge variant="outline">
              {t(`rarityPage.lootPools.category.${pool.category}` as const)}
            </Badge>
            <Badge variant="ghost">
              {t("rarityPage.lootPools.itemsCount", { count: pool.items.length })}
            </Badge>
            {pool.draws != null && (
              <Badge variant="ghost">
                {t("rarityPage.lootPools.draws", { draws: pool.draws })}
              </Badge>
            )}
            {pool.junkChancePct != null && (
              <Badge variant="ghost">
                {t("rarityPage.lootPools.junkChance", { pct: pool.junkChancePct })}
              </Badge>
            )}
            {pool.oncePerServer && (
              <Badge
                className="border-transparent text-white"
                style={{ backgroundColor: RARITY_COLORS.unique }}
              >
                {t("rarityPage.lootPools.oncePerServer")}
              </Badge>
            )}
          </div>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              isOpen && "rotate-180",
            )}
          />
        </button>
      </CardHeader>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
        aria-hidden={!isOpen}
      >
        <div className="min-h-0 overflow-hidden">
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("rarityPage.lootPools.colItem")}</TableHead>
                  <TableHead>{t("rarityPage.lootPools.colRarity")}</TableHead>
                  <TableHead>{t("rarityPage.lootPools.colMarket")}</TableHead>
                  <TableHead className="text-right">
                    {t("rarityPage.lootPools.colChance")}
                  </TableHead>
                  <TableHead className="text-right">{t("rarityPage.lootPools.colQty")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pool.items.map((it) => {
                  const marketId = marketIndex.get(it.code);
                  return (
                    <TableRow key={it.code}>
                      <TableCell>
                        <span className="font-medium text-foreground">
                          {prettifyItemCode(it.code)}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">{it.code}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <RarityBadge rarity={it.rarity} label={RARITY_LABELS[it.rarity]} />
                          {it.uniquePerServer && (
                            <span
                              className="text-xs font-medium"
                              style={{ color: RARITY_COLORS.unique }}
                              title={t("rarityPage.lootPools.uniqueTooltip")}
                            >
                              ({RARITY_LABELS.unique})
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {marketId != null ? (
                          <Link
                            to={`/market/items/${marketId}`}
                            title={t("rarityPage.lootPools.marketTooltip")}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                          >
                            <Store className="size-3.5" aria-hidden />
                            {t("rarityPage.lootPools.onMarket")}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-foreground">
                        {it.chancePct.toFixed(2)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatQuantity(it.minQty, it.maxQty)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </div>
      </div>
    </Card>
  );
}

/** Small coloured pill for an item's rarity tier. */
function RarityBadge({ rarity, label }: { rarity: Rarity; label: string }) {
  return (
    <Badge className="text-white" style={{ backgroundColor: RARITY_COLORS[rarity] }}>
      {label}
    </Badge>
  );
}
