import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  label: string;
  /**
   * Either a raw number (auto-formatted via `toLocaleString`) or a
   * pre-formatted string when the caller needs custom units / suffixes
   * (e.g. `"1.23×"`, `"4.5%"`).
   */
  value: number | string;
  /** Previous-period number used to compute a delta. Only honoured when `value` is numeric. */
  previous?: number;
  /** Optional secondary line of muted text shown below the value. */
  hint?: string;
}

/** Single headline number with optional period-over-period delta. */
export function StatCard({ label, value, previous, hint }: StatCardProps) {
  let deltaStr: string | null = null;
  let deltaClass = "text-muted-foreground";
  if (previous != null && typeof value === "number") {
    if (previous === 0 && value > 0) {
      deltaStr = "new";
      deltaClass = "text-emerald-600";
    } else if (previous > 0) {
      const pct = ((value - previous) / previous) * 100;
      const sign = pct >= 0 ? "+" : "";
      deltaStr = `${sign}${pct.toFixed(0)}% vs prev`;
      deltaClass = pct >= 0 ? "text-emerald-600" : "text-red-600";
    }
  }

  const displayValue = typeof value === "number" ? value.toLocaleString() : value;

  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-3xl font-semibold tabular-nums">{displayValue}</div>
        {deltaStr ? <div className={`text-xs mt-1 ${deltaClass}`}>{deltaStr}</div> : null}
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
