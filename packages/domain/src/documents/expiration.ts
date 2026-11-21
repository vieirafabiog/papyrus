export const DOCUMENT_EXPIRATION_STATES = [
  "EXPIRED",
  "EXPIRING_SOON",
  "UP_TO_DATE",
  "NO_DATE",
] as const;

export type DocumentExpirationState = (typeof DOCUMENT_EXPIRATION_STATES)[number];

export const DOCUMENT_EXPIRATION_BUCKETS = ["ALL", ...DOCUMENT_EXPIRATION_STATES] as const;

export type DocumentExpirationBucket = (typeof DOCUMENT_EXPIRATION_BUCKETS)[number];

export const DEFAULT_EXPIRATION_TIMEZONE = "America/Sao_Paulo" as const;
export const DEFAULT_EXPIRATION_WINDOW_DAYS = 30;
export const MAX_EXPIRATION_WINDOW_DAYS = 365;

const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validates whether a string represents a valid IANA time zone identifier.
 */
export function isValidIanaTimeZone(timeZone: string): boolean {
  const trimmed = timeZone.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the civil YYYY-MM-DD calendar date of `referenceNow` in `timeZone`.
 */
export function resolveLocalCalendarDate(referenceNow: Date, timeZone: string): string {
  const effectiveTimeZone = isValidIanaTimeZone(timeZone)
    ? timeZone.trim()
    : DEFAULT_EXPIRATION_TIMEZONE;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: effectiveTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceNow);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return referenceNow.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

function parseIsoDateUtcMs(isoDate: string): number {
  const match = ISO_DATE_ONLY_REGEX.exec(isoDate);
  if (!match) {
    throw new Error(`Invalid ISO calendar date: ${isoDate}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Date.UTC(year, month - 1, day);
}

/**
 * Adds a positive or negative integer number of calendar days to a YYYY-MM-DD date string.
 */
export function addCalendarDays(isoDate: string, days: number): string {
  const baseMs = parseIsoDateUtcMs(isoDate);
  const target = new Date(baseMs + days * 86_400_000);
  return target.toISOString().slice(0, 10);
}

/**
 * Returns `(targetIsoDate - referenceIsoDate)` in whole calendar days.
 */
export function diffCalendarDays(targetIsoDate: string, referenceIsoDate: string): number {
  const targetMs = parseIsoDateUtcMs(targetIsoDate);
  const refMs = parseIsoDateUtcMs(referenceIsoDate);
  return Math.round((targetMs - refMs) / 86_400_000);
}

/**
 * Classifies a civil document expiration date relative to a localized reference date
 * and configurable look-ahead window.
 */
export function classifyExpirationState(
  expirationDate: string | null,
  referenceIsoDate: string,
  windowDays: number,
): DocumentExpirationState {
  if (expirationDate === null) {
    return "NO_DATE";
  }
  if (expirationDate < referenceIsoDate) {
    return "EXPIRED";
  }
  const windowEndIsoDate = addCalendarDays(referenceIsoDate, windowDays);
  if (expirationDate <= windowEndIsoDate) {
    return "EXPIRING_SOON";
  }
  return "UP_TO_DATE";
}
