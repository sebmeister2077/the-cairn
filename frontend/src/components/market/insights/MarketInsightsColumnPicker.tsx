import {
  HIDEABLE_INSIGHTS_COLUMNS,
  showAllInsightsColumns,
  toggleInsightsColumn,
} from "@/hooks/useInsightsColumns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Columns3 } from "lucide-react";

// --------------------------------------------------------------------------- //
// Column visibility picker
// --------------------------------------------------------------------------- //
export function MarketInsightsColumnPicker({ hidden }: { hidden: string[] }) {
  const shown = HIDEABLE_INSIGHTS_COLUMNS.length - hidden.length;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="gap-1.5" />}>
        <Columns3 className="size-4" />
        Columns
        {hidden.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {shown}/{HIDEABLE_INSIGHTS_COLUMNS.length}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-52 p-1">
        <div className="max-h-[min(20rem,60vh)] overflow-y-auto">
          {HIDEABLE_INSIGHTS_COLUMNS.map((c) => (
            <label
              key={c.key}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
            >
              <Checkbox
                checked={!hidden.includes(c.key)}
                onCheckedChange={() => toggleInsightsColumn(c.key)}
              />
              {c.label}
            </label>
          ))}
        </div>
        {hidden.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-7 w-full text-xs text-muted-foreground"
            onClick={() => showAllInsightsColumns()}
          >
            Show all
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
