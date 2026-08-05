import { useTranslation } from "@/lib/i18n";
import { useDateFormat } from "@/hooks/useDateFormat";
import type { DateFormatPref } from "@/lib/dateFormat";
import { cn } from "@/lib/utils";

interface DateFormatSwitcherProps {
  className?: string;
}

export function DateFormatSwitcher({ className }: DateFormatSwitcherProps) {
  const { t } = useTranslation();
  const { pref, setPref, formatDate } = useDateFormat();

  const options: ReadonlyArray<{
    value: DateFormatPref;
    short: string;
    label: string;
  }> = [
    { value: "system", short: t("common.auto"), label: t("common.dateFormatSystem") },
    { value: "dmy", short: "D M Y", label: t("common.dateFormatDMY") },
    { value: "mdy", short: "M D Y", label: t("common.dateFormatMDY") },
    { value: "ymd", short: "Y M D", label: t("common.dateFormatYMD") },
  ];

  return (
    <div className={cn("space-y-2", className)}>
      <div
        role="radiogroup"
        aria-label={t("common.selectDateFormat")}
        className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
      >
        {options.map((option) => {
          const active = pref === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.label}
              title={option.label}
              onClick={() => setPref(option.value)}
              className={cn(
                "inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-semibold uppercase tracking-wide transition-all outline-none cursor-pointer",
                "focus-visible:ring-2 focus-visible:ring-ring/50",
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background hover:text-foreground",
              )}
            >
              {option.short}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("common.example")}:{" "}
        <span className="font-medium text-foreground">{formatDate(new Date())}</span>
      </p>
    </div>
  );
}
