import { LOCALE_META, useTranslation, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const OPTIONS = [
  LOCALE_META.en,
  LOCALE_META.ru,
  LOCALE_META.nl,
  LOCALE_META.es,
  LOCALE_META.fr,
] as const;

interface LanguageSwitcherProps {
  className?: string;
}

export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useTranslation();

  return (
    <div
      role="radiogroup"
      aria-label={t("common.selectLanguage")}
      className={cn(
        "inline-flex h-8 items-center gap-0.5 rounded-full border border-border bg-muted/40 p-0.5",
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const active = locale === option.code;
        return (
          <button
            key={option.code}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.nativeLabel}
            title={option.nativeLabel}
            onClick={() => setLocale(option.code as Locale)}
            className={cn(
              "inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground transition-all outline-none cursor-pointer",
              "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              active && "bg-background text-foreground shadow-sm ring-1 ring-border/60",
            )}
          >
            {option.code}
          </button>
        );
      })}
    </div>
  );
}
