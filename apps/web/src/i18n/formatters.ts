import type { UiLocale } from "./types.js";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatDate(
  value: string | Date | null | undefined,
  locale: UiLocale,
  emptyFallback = "—",
): string {
  if (!value) {
    return emptyFallback;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : emptyFallback;
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
  }).format(date);
}

export function formatDateTime(
  value: string | Date | null | undefined,
  locale: UiLocale,
  emptyFallback = "—",
): string {
  if (!value) {
    return emptyFallback;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : emptyFallback;
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

export function formatNumber(value: number, locale: UiLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatBytes(bytes: number, locale: UiLocale): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(size);
  return `${formatted} ${BYTE_UNITS[unitIndex] ?? "B"}`;
}
