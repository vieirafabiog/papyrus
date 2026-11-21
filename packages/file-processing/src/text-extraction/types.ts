export type SupportedTextExtractionMime =
  | "text/plain"
  | "text/csv"
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type TextExtractorKind = "plain_text" | "pdf_basic" | "docx_xml";

export type PostgresFtsConfig = "portuguese" | "simple" | "english";

export interface TextExtractionPolicy {
  readonly enabled: boolean;
  readonly maxInputBytes: number;
  readonly maxExtractedChars: number;
  readonly maxZipEntryBytes: number;
  readonly maxCompressionRatio: number;
  readonly timeoutMs: number;
  readonly minPrintableRatio: number;
  readonly minReadableChars: number;
  readonly postgresFtsConfig: PostgresFtsConfig;
  readonly allowedMimeTypes: readonly string[];
}

export const DEFAULT_TEXT_EXTRACTION_MIME_TYPES: readonly SupportedTextExtractionMime[] = [
  "text/plain",
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export const DEFAULT_TEXT_EXTRACTION_POLICY: TextExtractionPolicy = {
  enabled: false,
  maxInputBytes: 5 * 1024 * 1024,
  maxExtractedChars: 200_000,
  maxZipEntryBytes: 2 * 1024 * 1024,
  maxCompressionRatio: 25,
  timeoutMs: 3_000,
  minPrintableRatio: 0.7,
  minReadableChars: 8,
  postgresFtsConfig: "portuguese",
  allowedMimeTypes: DEFAULT_TEXT_EXTRACTION_MIME_TYPES,
};

export function createTextExtractionPolicy(
  overrides: Partial<TextExtractionPolicy> = {},
): TextExtractionPolicy {
  return {
    ...DEFAULT_TEXT_EXTRACTION_POLICY,
    ...overrides,
    allowedMimeTypes: overrides.allowedMimeTypes ?? DEFAULT_TEXT_EXTRACTION_POLICY.allowedMimeTypes,
  };
}

export type TextExtractionOutcome =
  | { readonly status: "DISABLED" }
  | {
      readonly status: "EXTRACTED";
      readonly text: string;
      readonly truncated: boolean;
      readonly charCount: number;
      readonly printableRatio: number;
      readonly mimeType: string;
      readonly extractorKind: TextExtractorKind;
    }
  | { readonly status: "UNSUPPORTED_MIME"; readonly mimeType: string }
  | {
      readonly status: "SKIPPED_TOO_LARGE";
      readonly sizeBytes: number;
      readonly maxInputBytes: number;
    }
  | {
      readonly status: "LOW_QUALITY";
      readonly reason: string;
      readonly printableRatio: number;
      readonly charCount: number;
    }
  | { readonly status: "TIMED_OUT"; readonly timeoutMs: number }
  | { readonly status: "FAILED"; readonly reason: string };
