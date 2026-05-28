import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { useTheme } from "@/components/ThemeProvider";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface ThemeSwitcherProps {
  className?: string;
}

export function ThemeSwitcher({ className }: ThemeSwitcherProps) {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();

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
    <div
      role="radiogroup"
      aria-label={t("common.selectTheme")}
      className={cn(
        "inline-flex h-8 items-center gap-0.5 rounded-full border border-border bg-muted/40 p-0.5",
        className,
      )}
    >
      {options.map(({ value, label, Icon }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setPreference(value)}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-all outline-none cursor-pointer",
              "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              active && "bg-background text-foreground shadow-sm ring-1 ring-border/60",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
