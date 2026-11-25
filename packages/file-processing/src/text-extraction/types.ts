export type SupportedTextExtractionMime =
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "application/json"
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/bmp"
  | "image/tiff";

export type TextExtractorKind =
  | "plain_text"
  | "structured_text"
  | "pdf_basic"
  | "pdf_poppler"
  | "docx_xml"
  | "xlsx_xml"
  | "pptx_xml"
  | "ocr_image"
  | "ocr_pdf";

export type PostgresFtsConfig = "portuguese" | "simple" | "english";

export interface TextOcrPolicy {
  readonly enabled: boolean;
  readonly languages: readonly string[];
  readonly maxPdfPages: number;
  readonly timeoutMs: number;
  readonly minNativePdfCharsForSkipOcr: number;
}

export interface TextOcrEnginePort {
  extractPdfText?(input: {
    readonly buffer: Buffer;
    readonly timeoutMs: number;
  }): Promise<string | null>;
  recognizeImageBuffer(input: {
    readonly buffer: Buffer;
    readonly mimeType: string;
    readonly languages: readonly string[];
    readonly timeoutMs: number;
  }): Promise<string>;
  recognizePdfBuffer(input: {
    readonly buffer: Buffer;
    readonly languages: readonly string[];
    readonly maxPages: number;
    readonly timeoutMs: number;
  }): Promise<string>;
}

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
  readonly ocr: TextOcrPolicy;
}

export const DEFAULT_TEXT_EXTRACTION_MIME_TYPES: readonly SupportedTextExtractionMime[] = [
  "text/plain",
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export const DEFAULT_OCR_IMAGE_MIME_TYPES: readonly SupportedTextExtractionMime[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
] as const;

export const DEFAULT_FULL_CONTENT_EXTRACTION_MIME_TYPES: readonly SupportedTextExtractionMime[] = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ...DEFAULT_OCR_IMAGE_MIME_TYPES,
] as const;

export const DEFAULT_TEXT_OCR_POLICY: TextOcrPolicy = {
  enabled: false,
  languages: ["por", "eng"],
  maxPdfPages: 20,
  timeoutMs: 45_000,
  minNativePdfCharsForSkipOcr: 30,
};

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
  ocr: DEFAULT_TEXT_OCR_POLICY,
};

export interface TextExtractionPolicyOverrides extends Omit<Partial<TextExtractionPolicy>, "ocr"> {
  readonly ocr?: Partial<TextOcrPolicy> | undefined;
}

export function createTextExtractionPolicy(
  overrides: TextExtractionPolicyOverrides = {},
): TextExtractionPolicy {
  return {
    ...DEFAULT_TEXT_EXTRACTION_POLICY,
    ...overrides,
    allowedMimeTypes: overrides.allowedMimeTypes ?? DEFAULT_TEXT_EXTRACTION_POLICY.allowedMimeTypes,
    ocr: {
      ...DEFAULT_TEXT_OCR_POLICY,
      ...overrides.ocr,
      languages: overrides.ocr?.languages ?? DEFAULT_TEXT_OCR_POLICY.languages,
    },
  };
}

/**
 * Builds an enabled policy covering all Papyrus document formats
 * (text, JSON/Markdown/CSV, PDF with scanned OCR fallback, Office XML, and OCR images).
 */
export function createFullContentExtractionPolicy(
  overrides: TextExtractionPolicyOverrides = {},
): TextExtractionPolicy {
  return createTextExtractionPolicy({
    enabled: true,
    maxInputBytes: 25 * 1024 * 1024,
    timeoutMs: 45_000,
    allowedMimeTypes: DEFAULT_FULL_CONTENT_EXTRACTION_MIME_TYPES,
    ...overrides,
    ocr: {
      enabled: true,
      ...overrides.ocr,
    },
  });
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
  | { readonly status: "OCR_UNAVAILABLE"; readonly reason: string }
  | { readonly status: "TIMED_OUT"; readonly timeoutMs: number }
  | { readonly status: "FAILED"; readonly reason: string };
