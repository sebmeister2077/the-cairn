import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LOCALE_META, useTranslation, type Locale } from "@/lib/i18n";

const OPTIONS = [LOCALE_META.en, LOCALE_META.ru] as const;

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useTranslation();

  return (
    <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
      <SelectTrigger aria-label={t("common.selectLanguage")} className="min-w-32">
        <SelectValue>
          {OPTIONS.find((option) => option.code === locale)?.nativeLabel ??
            LOCALE_META.en.nativeLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((option) => (
          <SelectItem key={option.code} value={option.code}>
            {option.nativeLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
