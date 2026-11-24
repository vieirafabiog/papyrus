import { apiErrorResponseSchema } from "@docuflow/contracts";
import { type MessageKey, getCurrentUiLocale, translate } from "./index.js";
import type { UiLocale } from "./types.js";

const TECHNICAL_JARGON_PATTERNS: readonly RegExp[] = [
  /\bHTTP\s*\d{3}\b/i,
  /\b(API|SQL|PostgreSQL|Drizzle|Fastify|stack|trace|errno|ECONNREFUSED|ETIMEDOUT)\b/i,
  /\b(worker|proxy|payload|endpoint|CSRF|cookie|Blob URL|UUID|IANA|snake_case|magic bytes)\b/i,
  /[<>]/,
];

const ERROR_CODE_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  UNAUTHORIZED: "common.errors.unauthorized",
  FORBIDDEN: "common.errors.forbidden",
  NOT_FOUND: "common.errors.notFound",
  CONFLICT: "common.errors.conflict",
  DOCUMENT_VERSION_CONFLICT: "common.errors.versionConflict",
  UPLOAD_TOO_LARGE: "common.errors.uploadTooLarge",
  UNSUPPORTED_MEDIA_TYPE: "common.errors.unsupportedMediaType",
  FILE_QUARANTINED: "common.errors.fileQuarantined",
  FILE_REJECTED: "common.errors.fileRejected",
  STORAGE_UNAVAILABLE: "common.errors.storageUnavailable",
  RETENTION_HOLD_ACTIVE: "common.errors.retentionHoldActive",
  RATE_LIMITED: "common.errors.rateLimited",
  VALIDATION_ERROR: "common.errors.validation",
  INTERNAL_ERROR: "common.errors.internal",
};

export function containsTechnicalJargon(message: string): boolean {
  return TECHNICAL_JARGON_PATTERNS.some((pattern) => pattern.test(message));
}

export function getLocalizedApiErrorMessage(
  code: string | undefined,
  status: number,
  serverMessage?: string,
  locale: UiLocale = getCurrentUiLocale(),
): string {
  if (code && code in ERROR_CODE_MESSAGE_KEYS) {
    const key = ERROR_CODE_MESSAGE_KEYS[code];
    if (key) {
      return translate(key, undefined, locale);
    }
  }

  if (status === 401) {
    return translate("common.errors.unauthorized", undefined, locale);
  }
  if (status === 403) {
    return translate("common.errors.forbidden", undefined, locale);
  }
  if (status === 404) {
    return translate("common.errors.notFound", undefined, locale);
  }
  if (status === 409) {
    return translate("common.errors.conflict", undefined, locale);
  }
  if (status === 429) {
    return translate("common.errors.rateLimited", undefined, locale);
  }

  if (
    serverMessage &&
    serverMessage.trim().length > 0 &&
    !containsTechnicalJargon(serverMessage) &&
    locale === "pt-BR"
  ) {
    return serverMessage.trim();
  }

  return translate("common.errors.internal", undefined, locale);
}

export async function extractUserErrorMessage(
  response: Response,
  fallbackKey: MessageKey = "common.errors.internal",
  locale: UiLocale = getCurrentUiLocale(),
): Promise<string> {
  try {
    const rawJson: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(rawJson);
    if (parsed.success) {
      return getLocalizedApiErrorMessage(
        parsed.data.error.code,
        response.status,
        parsed.data.error.message,
        locale,
      );
    }
  } catch {
    // Non-JSON response falls through to status-based localized error.
  }

  if (response.status >= 400) {
    const byStatus = getLocalizedApiErrorMessage(undefined, response.status, undefined, locale);
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 429
    ) {
      return byStatus;
    }
  }

  return translate(fallbackKey, undefined, locale);
}
