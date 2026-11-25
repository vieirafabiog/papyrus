export const DEFAULT_MAX_IMAGE_PREVIEW_BYTES = 15 * 1024 * 1024;
export const DEFAULT_MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;

export const ALLOWED_IMAGE_PREVIEW_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

export const ALLOWED_TEXT_PREVIEW_MIME_TYPES = new Set<string>([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

export type DocumentPreviewKind =
  | "pdf"
  | "image"
  | "csv"
  | "json"
  | "markdown"
  | "text"
  | "unsupported";

/**
 * Resolves the safe browser preview mode from the backend-verified MIME type
 * and (only for text/plain subtypes like Markdown) the original file extension.
 */
export function resolveDocumentPreviewKind(
  detectedMime: string,
  originalFileName: string,
): DocumentPreviewKind {
  const normalizedMime = detectedMime.trim().toLowerCase();
  const normalizedName = originalFileName.trim().toLowerCase();

  if (normalizedMime === "application/pdf") {
    return "pdf";
  }
  if (ALLOWED_IMAGE_PREVIEW_MIME_TYPES.has(normalizedMime)) {
    return "image";
  }
  if (normalizedMime === "text/csv") {
    return "csv";
  }
  if (normalizedMime === "application/json") {
    return "json";
  }
  if (
    normalizedMime === "text/markdown" ||
    (normalizedMime === "text/plain" &&
      (normalizedName.endsWith(".md") || normalizedName.endsWith(".markdown")))
  ) {
    return "markdown";
  }
  if (normalizedMime === "text/plain") {
    return "text";
  }
  return "unsupported";
}

export function isTextPreviewKind(kind: DocumentPreviewKind): boolean {
  return kind === "csv" || kind === "json" || kind === "markdown" || kind === "text";
}

export function stripUtf8Bom(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}
