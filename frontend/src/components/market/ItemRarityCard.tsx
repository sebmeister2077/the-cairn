import { BookOpen, Gem, Hammer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { lookupItemSources, RARITY_COLORS, RARITY_LABELS } from "@/lib/item-sources";

/** Shows an item's rarity tier and the loot sources it drops from (with drop
 *  chances). Renders nothing for items that aren't loot-table drops. */
export function ItemRarityCard({ code }: { code: string | null | undefined }) {
  const info = lookupItemSources(code);
  if (!info) return null;

  // Lore rewards are handed to every player, so we skip rarity/drop % entirely.
  if (info.loreReward) {
    return (
      <Card className="h-full">
        <CardContent className="flex h-full flex-col gap-2 py-3">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Gem className="size-4" aria-hidden />
            <h2 className="text-sm font-semibold text-foreground">Rarity &amp; loot</h2>
            <Badge className="ml-auto bg-sky-500 text-white hover:bg-sky-500">Lore reward</Badge>
          </div>
          <div className="mt-auto flex items-center gap-1.5 text-sm text-sky-600 dark:text-sky-400">
            <BookOpen className="size-4 shrink-0" aria-hidden />
            <span>Available to everyone after completing the Lore — not a rare drop.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-3 py-3">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Gem className="size-4" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">Rarity &amp; loot</h2>
          <Badge
            className="ml-auto text-white"
            style={{ backgroundColor: RARITY_COLORS[info.rarity] }}
          >
            {RARITY_LABELS[info.rarity]}
          </Badge>
        </div>
        <ul className="space-y-1 text-sm">
          {info.sources.map((s) => (
            <li key={s.pool} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                {s.label}
                {s.oncePerServer ? (
                  <span
                    className="ml-1 text-xs text-muted-foreground"
                    title="The Lazaret chest can only be looted once per server."
                  >
                    (once per server)
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-medium tabular-nums text-muted-foreground">
                ~{s.chancePct}%
              </span>
            </li>
          ))}
        </ul>
        {info.craftable ? (
          <div className="mt-auto flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
            <Hammer className="size-4" aria-hidden />
            <span className="font-medium">Also craftable</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
