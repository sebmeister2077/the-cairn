import type { UsageGranularity } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface GranularityToggleProps {
  value: UsageGranularity;
  onChange: (next: UsageGranularity) => void;
}

const OPTIONS: { value: UsageGranularity; label: string }[] = [
  { value: "hour", label: "Hour" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
];

export function GranularityToggle({ value, onChange }: GranularityToggleProps) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as UsageGranularity)}>
      <TabsList>
        {OPTIONS.map((o) => (
          <TabsTrigger key={o.value} value={o.value}>
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
