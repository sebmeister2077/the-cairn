import { Monitor, Moon, Sun } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "@/components/ThemeProvider";
import type { ThemePreference } from "@/lib/theme";

const OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  Icon: typeof Sun;
}> = [
  { value: "auto", label: "Auto", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

export function ThemeSwitcher() {
  const { preference, resolved, setPreference } = useTheme();
  const TriggerIcon = preference === "auto" ? Monitor : resolved === "dark" ? Moon : Sun;

  return (
    <Select value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
      <SelectTrigger aria-label="Select theme" className="min-w-32">
        <SelectValue>
          <span className="flex items-center gap-2">
            <TriggerIcon className="size-4" />
            {OPTIONS.find((o) => o.value === preference)?.label ?? "Auto"}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map(({ value, label, Icon }) => (
          <SelectItem key={value} value={value}>
            <Icon className="size-4" />
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
