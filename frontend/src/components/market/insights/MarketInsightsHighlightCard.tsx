// --------------------------------------------------------------------------- //
// Highlight cards
// --------------------------------------------------------------------------- //

import type { InsightsRow } from "@/models/auction";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// How many items each highlight card shows inline, and the max it keeps for the
// "show all" popup.
const HIGHLIGHT_PREVIEW = 5;

export type MarketInsightsHighlight = {
  title: string;
  hint: string;
  rows: InsightsRow[];
  value: (r: InsightsRow) => string;
};

export function MarketInsightsHighlightCard({
  highlight,
  onSelect,
}: {
  highlight: MarketInsightsHighlight;
  onSelect: (itemId: number) => void;
}) {
  const preview = highlight.rows.slice(0, HIGHLIGHT_PREVIEW);
  const hasMore = highlight.rows.length > HIGHLIGHT_PREVIEW;

  const renderRow = (r: InsightsRow, i: number) => (
    <li key={r.itemId}>
      <button
        type="button"
        onClick={() => onSelect(r.itemId)}
        className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-muted/50"
      >
        <span className="min-w-0 truncate">
          <span className="mr-1 text-muted-foreground tabular-nums">{i + 1}.</span>
          {r.name}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{highlight.value(r)}</span>
      </button>
    </li>
  );

  return (
    <Card className="h-full">
      <CardContent className="py-4">
        <div className="font-medium">{highlight.title}</div>
        <p className="mb-2 text-xs text-muted-foreground">{highlight.hint}</p>
        {highlight.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not enough data.</p>
        ) : (
          <>
            <ol className="space-y-1">{preview.map(renderRow)}</ol>
            {hasMore ? (
              <Dialog>
                <DialogTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7 w-full text-xs text-muted-foreground"
                    />
                  }
                >
                  Show all {highlight.rows.length}
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>{highlight.title}</DialogTitle>
                    <DialogDescription>{highlight.hint}</DialogDescription>
                  </DialogHeader>
                  <ol className="max-h-[60vh] space-y-1 overflow-y-auto">
                    {highlight.rows.map(renderRow)}
                  </ol>
                </DialogContent>
              </Dialog>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
