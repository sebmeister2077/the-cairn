import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  label: string;
  value: number;
  previous?: number;
}

/** Single headline number with optional period-over-period delta. */
export function StatCard({ label, value, previous }: StatCardProps) {
  let deltaStr: string | null = null;
  let deltaClass = "text-muted-foreground";
  if (previous != null) {
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

  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-3xl font-semibold tabular-nums">{value.toLocaleString()}</div>
        {deltaStr ? <div className={`text-xs mt-1 ${deltaClass}`}>{deltaStr}</div> : null}
      </CardContent>
    </Card>
  );
}
