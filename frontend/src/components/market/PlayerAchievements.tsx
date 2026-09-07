// Compact, all-time achievements strip for the player-profile header.
//
// Kept to a single inline row so it never pushes the profile's main content
// down: a trophy pill (earned/total) plus the earned medallions, opening a
// popover with the full grid — earned tiers highlighted, locked ones greyed
// with a progress bar toward the next threshold.

import { Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { usePlayerAchievements } from "@/hooks/usePlayerAchievements";
import type { AchievementProgress } from "@/lib/achievements";
import type { AuctionListing } from "@/models/auction";

/** Roman-ish tier marker (I / II / III …) for the reached tier. */
const TIER_MARKS = ["I", "II", "III", "IV", "V"];

function tierLabel(a: AchievementProgress): string {
  if (a.tierIndex < 0) return "Locked";
  const mark = TIER_MARKS[a.tierIndex] ?? String(a.tierIndex + 1);
  return a.nextTarget == null ? `${mark} · Max` : mark;
}

function AchievementTile({ a }: { a: AchievementProgress }) {
  const fmt = a.def.format ?? ((n: number) => Math.round(n).toLocaleString());
  const target = a.nextTarget ?? a.def.tiers[a.def.tiers.length - 1];
  const Icon = a.def.icon;
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        a.earned ? "bg-amber-50 dark:bg-amber-950/30 border-amber-400/50" : "bg-muted/30",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            "size-4 shrink-0",
            a.earned ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/50",
          )}
          aria-hidden
        />
        <span className="text-sm font-medium">{a.def.title}</span>
        <span
          className={cn(
            "ml-auto text-xs tabular-nums",
            a.earned ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
          )}
        >
          {tierLabel(a)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{a.def.desc}</p>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", a.earned ? "bg-amber-500" : "bg-primary/60")}
          style={{ width: `${Math.round(a.progress * 100)}%` }}
        />
      </div>
      <div className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">
        {a.nextTarget == null ? "Complete" : `${fmt(a.value)} / ${fmt(target)}`}
      </div>
    </div>
  );
}

export function PlayerAchievementsBar({
  listings,
  uid,
}: {
  listings: AuctionListing[] | undefined;
  uid: string;
}) {
  const achievements = usePlayerAchievements(listings, uid);
  const earned = achievements.filter((a) => a.earned);
  const total = achievements.length;

  // Show the earned medallions inline (a small taste), full grid in the popover.
  const preview = earned.slice(0, 4);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full cursor-pointer border bg-muted/40 px-2 py-0.5 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Achievements"
            title="Achievements"
          >
            <Trophy className="size-3.5 text-amber-500" aria-hidden />
            <span className="tabular-nums font-medium">
              {earned.length}/{total}
            </span>
            {preview.length > 0 && (
              <span className="ml-0.5 flex items-center gap-0.5" aria-hidden>
                {preview.map((a) => {
                  const Icon = a.def.icon;
                  return (
                    <Icon key={a.def.id} className="size-3.5 text-amber-600 dark:text-amber-400" />
                  );
                })}
              </span>
            )}
          </button>
        }
      />
      <PopoverContent align="start" className="w-80 overflow-hidden">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Achievements</p>
          <Badge variant="secondary" className="tabular-nums">
            {earned.length}/{total}
          </Badge>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Permanent, all-time feats — independent of the selected time range.
        </p>
        <div className="max-h-96 space-y-2 overflow-y-auto pr-0.5">
          {achievements.map((a) => (
            <AchievementTile key={a.def.id} a={a} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
