import { useMemo, useState } from "react";

import { MaintenanceChip } from "@/components/other/MaintenanceChip";
import {
  type MarketIndex,
  PoolCard,
  RARITY_LEGEND,
} from "@/components/rarity/loot-pools/LootPoolCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useItemCatalog } from "@/lib/market/auction";
import { useTranslation } from "@/lib/i18n";
import {
  getLootPools,
  getLootPoolsMeta,
  LOOT_CATEGORY_ORDER,
  prettifyItemCode,
  RARITY_COLORS,
  RARITY_LABELS,
} from "@/lib/market/loot-pools";
import { bareItemCode } from "@/lib/tops-map-view/trader-wares";
import type { LootPoolCategory, Rarity } from "@/models/loot-pools";

type CategoryFilter = "all" | LootPoolCategory;
type RarityFilter = "all" | Rarity;

export function LootPoolRarityPage() {
  const { t } = useTranslation();
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [rarity, setRarity] = useState<RarityFilter>("all");
  const [query, setQuery] = useState("");

  const allPools = useMemo(() => getLootPools(), []);
  const meta = useMemo(() => getLootPoolsMeta(), []);

  // Which loot items have shown up on the Auction House ("Market"). The catalog
  // is fetched from the market dataset; while it loads (or if it fails) the map
  // is empty and the column simply shows no hints.
  const catalogQ = useItemCatalog();
  const marketIndex = useMemo<MarketIndex>(() => {
    const index: MarketIndex = new Map();
    const catalog = catalogQ.data;
    if (!catalog) return index;
    for (const [idStr, entry] of Object.entries(catalog)) {
      if (!entry.code) continue;
      const bare = bareItemCode(entry.code);
      if (!index.has(bare)) index.set(bare, Number(idStr));
    }
    return index;
  }, [catalogQ.data]);

  const pools = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = category === "all" ? allPools : allPools.filter((p) => p.category === category);
    if (q || rarity !== "all") {
      list = list
        .map((p) => ({
          ...p,
          items: p.items.filter(
            (it) =>
              (rarity === "all" ||
                (rarity === "unique" ? it.uniquePerServer === true : it.rarity === rarity)) &&
              (!q ||
                it.code.toLowerCase().includes(q) ||
                prettifyItemCode(it.code).toLowerCase().includes(q)),
          ),
        }))
        .filter((p) => p.items.length > 0);
    }
    return list;
  }, [allPools, category, rarity, query]);

  const tabs: CategoryFilter[] = useMemo(() => ["all", ...LOOT_CATEGORY_ORDER], []);
  const filtersActive = rarity !== "all" || query.trim() !== "";
  const generated = useMemo(
    () => (meta.generatedUtc ? new Date(meta.generatedUtc).toLocaleDateString() : ""),
    [meta.generatedUtc],
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>{t("rarityPage.lootPools.title")}</CardTitle>
            <MaintenanceChip component="rarity_loot_pools" />
          </div>
          <CardDescription>{t("rarityPage.lootPools.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>{t("rarityPage.lootPools.intro")}</p>
          <p>{t("rarityPage.lootPools.uniqueNote")}</p>
          <p>{t("rarityPage.lootPools.marketNote")}</p>
          <p>{t("rarityPage.lootPools.fishingNote")}</p>
          <div className="flex flex-wrap items-center gap-2">
            {RARITY_LEGEND.map((r) => (
              <span key={r} className="inline-flex items-center gap-1.5 text-xs">
                <span
                  aria-hidden
                  className="inline-block size-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: RARITY_COLORS[r] }}
                />
                {RARITY_LABELS[r]}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <Tabs value={category} onValueChange={(v) => setCategory(v as CategoryFilter)}>
              <TabsList variant="line">
                {tabs.map((c) => (
                  <TabsTrigger key={c} value={c}>
                    {t(`rarityPage.lootPools.category.${c}` as const)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">
                  {t("rarityPage.lootPools.colRarity")}
                </Label>
                <Select
                  value={rarity}
                  onValueChange={(v) => setRarity((v as RarityFilter) ?? "all")}
                >
                  <SelectTrigger className="h-9 w-40">
                    <SelectValue>
                      {(value) =>
                        value === "all"
                          ? t("rarityPage.lootPools.allRarities")
                          : (RARITY_LABELS[value as Rarity] ??
                            t("rarityPage.lootPools.allRarities"))
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("rarityPage.lootPools.allRarities")}</SelectItem>
                    {RARITY_LEGEND.map((r) => (
                      <SelectItem key={r} value={r}>
                        <span
                          aria-hidden
                          className="inline-block size-3 shrink-0 rounded-sm"
                          style={{ backgroundColor: RARITY_COLORS[r] }}
                        />
                        {RARITY_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("rarityPage.lootPools.searchPlaceholder")}
                className="sm:w-64"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {pools.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("rarityPage.lootPools.noResults")}
          </CardContent>
        </Card>
      ) : (
        pools.map((pool) => (
          <PoolCard key={pool.id} pool={pool} forceOpen={filtersActive} marketIndex={marketIndex} />
        ))
      )}

      <p className="text-xs text-muted-foreground">
        {t("rarityPage.lootPools.footnote", { count: meta.poolCount, date: generated })}
      </p>
    </div>
  );
}
