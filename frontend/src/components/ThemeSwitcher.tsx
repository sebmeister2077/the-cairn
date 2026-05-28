import { Monitor, Moon, Sun } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n";
import { useTheme } from "@/components/ThemeProvider";
import type { ThemePreference } from "@/lib/theme";

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { preference, resolved, setPreference } = useTheme();
  const TriggerIcon = preference === "auto" ? Monitor : resolved === "dark" ? Moon : Sun;
  const options: ReadonlyArray<{
    value: ThemePreference;
    label: string;
    Icon: typeof Sun;
  }> = [
    { value: "auto", label: t("common.auto"), Icon: Monitor },
    { value: "light", label: t("common.light"), Icon: Sun },
    { value: "dark", label: t("common.dark"), Icon: Moon },
  ];

  return (
    <Select value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
      <SelectTrigger aria-label={t("common.selectTheme")} className="min-w-32">
        <SelectValue>
          <span className="flex items-center gap-2">
            <TriggerIcon className="size-4" />
            {options.find((o) => o.value === preference)?.label ?? t("common.auto")}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(({ value, label, Icon }) => (
          <SelectItem key={value} value={value}>
            <Icon className="size-4" />
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
