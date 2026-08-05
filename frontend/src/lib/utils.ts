import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { formatDateTime } from "@/lib/dateFormat"
import { LOCALE_META } from "@/lib/i18n"
import { store } from "@/store"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatTimestamp(s: string | number | null | undefined): string {
  if (!s) return "—";
  const { i18n, dateFormat } = store.getState();
  return formatDateTime(s, dateFormat.pref, LOCALE_META[i18n.locale].intlCode);
}