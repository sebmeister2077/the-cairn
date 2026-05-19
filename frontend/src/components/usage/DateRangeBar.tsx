import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DateRangeBarProps {
  value: { from: string; to: string };
  onChange: (next: { from: string; to: string }) => void;
}

/**
 * Date-range picker for the Usage dashboard. Offers quick presets +
 * raw datetime-local inputs for ad-hoc windows. All values are stored
 * as ISO strings in UTC; the inputs round-trip through ``toLocalInput``
 * so the user sees their browser's local time but we send UTC upstream.
 */
const PRESETS: Array<{ label: string; days: number }> = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "180d", days: 180 },
];

export function DateRangeBar({ value, onChange }: DateRangeBarProps) {
  const setPreset = (days: number) => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    onChange({ from: from.toISOString(), to: to.toISOString() });
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <Button key={p.label} variant="outline" size="sm" onClick={() => setPreset(p.days)}>
            {p.label}
          </Button>
        ))}
      </div>
      <label className="flex flex-col text-xs text-muted-foreground">
        From
        <Input
          type="datetime-local"
          value={toLocalInput(value.from)}
          onChange={(e) => {
            const d = fromLocalInput(e.target.value);
            if (d) onChange({ ...value, from: d });
          }}
          className="h-8 w-50"
        />
      </label>
      <label className="flex flex-col text-xs text-muted-foreground">
        To
        <Input
          type="datetime-local"
          value={toLocalInput(value.to)}
          onChange={(e) => {
            const d = fromLocalInput(e.target.value);
            if (d) onChange({ ...value, to: d });
          }}
          className="h-8 w-50"
        />
      </label>
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // datetime-local expects "YYYY-MM-DDTHH:mm" in *local* time, no timezone.
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalInput(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
