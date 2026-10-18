import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { formatDateTime } from "@/lib/formatting/dateFormat"
import { LOCALE_META } from "@/lib/i18n"
import { store } from "@/store"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}


export function capitalize(str: string): string {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}