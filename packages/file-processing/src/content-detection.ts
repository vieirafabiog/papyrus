import type { Readable } from "node:stream";

export const DEFAULT_HEADER_SAMPLE_BYTES = 65_536;
export const SAFE_REJECTION_MAX_LENGTH = 255;

export const DEFAULT_ALLOWED_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/tiff",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export type ContentRejectionCode =
  | "EMPTY_CONTENT"
  | "INVALID_FILENAME"
  | "DANGEROUS_EXTENSION"
  | "EXTENSION_NOT_ALLOWED"
  | "POLYGLOT_DETECTED"
  | "DANGEROUS_CONTENT"
  | "ARCHIVE_EXPANSION_RISK"
  | "UNRECOGNIZED_CONTENT"
  | "EXTENSION_MISMATCH"
  | "DECLARED_TYPE_MISMATCH"
  | "MIME_NOT_ALLOWED";

const SAFE_REJECTION_MESSAGES: Readonly<Record<ContentRejectionCode, string>> = {
  EMPTY_CONTENT: "O arquivo enviado está vazio e não pode ser aceito.",
  INVALID_FILENAME: "O nome do arquivo contém caracteres ou estrutura não permitida.",
  DANGEROUS_EXTENSION: "A extensão do arquivo é bloqueada pela política de segurança.",
  EXTENSION_NOT_ALLOWED: "A extensão do arquivo não faz parte dos formatos permitidos.",
  POLYGLOT_DETECTED: "O arquivo apresenta assinaturas incompatíveis ou conteúdo híbrido suspeito.",
  DANGEROUS_CONTENT: "Conteúdo executável ou ativo bloqueado pela política de segurança.",
  ARCHIVE_EXPANSION_RISK: "Arquivo compactado rejeitado por risco de expansão excessiva.",
  UNRECOGNIZED_CONTENT: "Não foi possível identificar com segurança o formato do arquivo.",
  EXTENSION_MISMATCH: "A extensão do arquivo diverge do formato real identificado no conteúdo.",
  DECLARED_TYPE_MISMATCH: "O tipo MIME declarado diverge do formato real identificado no conteúdo.",
  MIME_NOT_ALLOWED: "O formato de arquivo identificado não é permitido pela política configurada.",
};

const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".msp",
  ".scr",
  ".pif",
  ".lnk",
  ".hta",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".mjs",
  ".cjs",
  ".wsf",
  ".wsh",
  ".ps1",
  ".psm1",
  ".sh",
  ".bash",
  ".zsh",
  ".php",
  ".phtml",
  ".asp",
  ".aspx",
  ".jsp",
  ".py",
  ".rb",
  ".pl",
  ".cgi",
  ".jar",
  ".war",
  ".html",
  ".htm",
  ".xhtml",
  ".svg",
  ".swf",
]);

const MIME_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "application/x-pdf": "application/pdf",
  "application/acrobat": "application/pdf",
  "application/csv": "text/csv",
  "text/x-csv": "text/csv",
  "application/vnd.ms-excel": "text/csv",
  "text/json": "application/json",
};

interface MimeFormatRule {
  readonly allowedExtensions: readonly string[];
  readonly dangerous?: boolean | undefined;
}

const MIME_FORMAT_RULES: Readonly<Record<string, MimeFormatRule>> = {
  "application/pdf": { allowedExtensions: [".pdf"] },
  "image/png": { allowedExtensions: [".png"] },
  "image/jpeg": { allowedExtensions: [".jpg", ".jpeg"] },
  "image/gif": { allowedExtensions: [".gif"] },
  "image/webp": { allowedExtensions: [".webp"] },
  "image/tiff": { allowedExtensions: [".tif", ".tiff"] },
  "image/bmp": { allowedExtensions: [".bmp"] },
  "text/plain": { allowedExtensions: [".txt", ".log", ".md"] },
  "text/csv": { allowedExtensions: [".csv"] },
  "application/json": { allowedExtensions: [".json"] },
  "application/zip": { allowedExtensions: [".zip"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    allowedExtensions: [".docx"],
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    allowedExtensions: [".xlsx"],
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    allowedExtensions: [".pptx"],
  },
  "application/x-ole-storage": { allowedExtensions: [".doc", ".xls", ".ppt"] },
  "image/svg+xml": { allowedExtensions: [".svg"], dangerous: true },
  "text/html": { allowedExtensions: [".html", ".htm"], dangerous: true },
  "application/vnd.microsoft.portable-executable": {
    allowedExtensions: [".exe", ".dll"],
    dangerous: true,
  },
  "application/x-elf": { allowedExtensions: [], dangerous: true },
  "application/x-mach-binary": { allowedExtensions: [], dangerous: true },
  "application/x-sh": { allowedExtensions: [".sh"], dangerous: true },
};

export interface FileContentInspectionInput {
  readonly originalFileName: string;
  readonly declaredContentType: string;
  readonly allowEmptyContent?: boolean | undefined;
}

export interface ContentDetectionPolicy {
  readonly allowedMimeTypes?: readonly string[] | undefined;
  readonly allowedExtensions?: readonly string[] | undefined;
  readonly requireExtensionMatch?: boolean | undefined;
  readonly requireDeclaredTypeMatch?: boolean | undefined;
  readonly allowGenericOctetStreamDeclaration?: boolean | undefined;
  readonly allowUnrecognizedBinary?: boolean | undefined;
  readonly maxZipExpansionRatio?: number | undefined;
  readonly maxHeaderSampleBytes?: number | undefined;
}

export interface DetectedContentSignature {
  readonly mimeType: string;
  readonly isPolyglot: boolean;
  readonly suspiciousCompressionRatio: boolean;
}

export interface ContentRejectionRecord {
  readonly code: ContentRejectionCode;
  readonly safeMessage: string;
  readonly metadata: Readonly<{
    rejectionCode: ContentRejectionCode;
    detectedMime: string | null;
    declaredMime: string | null;
    normalizedExtension: string | null;
  }>;
}

export interface FileContentInspectionAccepted {
  readonly accepted: true;
  readonly detectedMime: string;
  readonly declaredMime: string;
  readonly normalizedExtension: string;
  readonly rejection: null;
}

export interface FileContentInspectionRejected {
  readonly accepted: false;
  readonly detectedMime: string | null;
  readonly declaredMime: string | null;
  readonly normalizedExtension: string | null;
  readonly rejection: ContentRejectionRecord;
}

export type FileContentInspectionResult =
  | FileContentInspectionAccepted
  | FileContentInspectionRejected;

export interface SafeRejectionRecorderPort {
  recordRejection(record: ContentRejectionRecord): Promise<void> | void;
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[offset + i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function startsWithAscii(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (bytes.length < offset + text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function indexOfAscii(bytes: Uint8Array, needle: string, maxOffset: number): number {
  const limit = Math.min(bytes.length - needle.length, maxOffset);
  for (let i = 0; i <= limit; i += 1) {
    if (startsWithAscii(bytes, needle, i)) {
      return i;
    }
  }
  return -1;
}

function skipBomAndAsciiWhitespace(bytes: Uint8Array, maxBytes = 64): number {
  let offset = 0;
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) {
    offset = 3;
  }
  const limit = Math.min(bytes.length, maxBytes);
  while (offset < limit) {
    const b = bytes[offset];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
      offset += 1;
      continue;
    }
    break;
  }
  return offset;
}

function inspectZipSample(
  bytes: Uint8Array,
  maxExpansionRatio: number,
): { readonly mimeType: string; readonly suspiciousCompressionRatio: boolean } {
  let offset = 0;
  let ooxmlKind: "word" | "xl" | "ppt" | null = null;
  let hasContentTypesXml = false;
  let suspiciousRatio = false;
  let entriesInspected = 0;

  while (offset + 30 <= bytes.length && entriesInspected < 64) {
    if (!startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04], offset)) {
      break;
    }
    entriesInspected += 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 30);
    const compressedSize = view.getUint32(18, true);
    const uncompressedSize = view.getUint32(22, true);
    const fileNameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);

    if (
      compressedSize > 0 &&
      uncompressedSize > 0 &&
      uncompressedSize / compressedSize > maxExpansionRatio
    ) {
      suspiciousRatio = true;
    }

    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLen;
    if (nameEnd > bytes.length) {
      break;
    }

    const entryName = Buffer.from(bytes.subarray(nameStart, nameEnd)).toString("utf8");
    if (entryName === "[Content_Types].xml") {
      hasContentTypesXml = true;
    } else if (entryName.startsWith("word/")) {
      ooxmlKind = "word";
    } else if (entryName.startsWith("xl/")) {
      ooxmlKind = "xl";
    } else if (entryName.startsWith("ppt/")) {
      ooxmlKind = "ppt";
    }

    if (compressedSize === 0 && uncompressedSize === 0 && extraLen === 0) {
      break;
    }
    const nextOffset = nameEnd + extraLen + compressedSize;
    if (nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  let mimeType = "application/zip";
  if (ooxmlKind === "word" && (hasContentTypesXml || entriesInspected >= 1)) {
    mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else if (ooxmlKind === "xl" && (hasContentTypesXml || entriesInspected >= 1)) {
    mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else if (ooxmlKind === "ppt" && (hasContentTypesXml || entriesInspected >= 1)) {
    mimeType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }

  return { mimeType, suspiciousCompressionRatio: suspiciousRatio };
}

function tryDecodeUtf8Text(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === undefined) {
      continue;
    }
    if (b === 0x00) {
      return null;
    }
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      return null;
    }
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Inspects leading content bytes to detect the true MIME type without relying on client
 * headers or filenames, and flags dangerous polyglots or zip expansion risks.
 */
export function detectMimeFromBytes(
  sample: Uint8Array,
  options: { readonly maxZipExpansionRatio?: number | undefined } = {},
): DetectedContentSignature | null {
  if (sample.length === 0) {
    return null;
  }

  const maxExpansionRatio = options.maxZipExpansionRatio ?? 100;
  const embeddedPdfOffset = indexOfAscii(sample, "%PDF-", 2048);

  // 1. Executable / script binaries detected first so they can never masquerade as docs
  if (startsWithBytes(sample, [0x7f, 0x45, 0x4c, 0x46])) {
    return {
      mimeType: "application/x-elf",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (startsWithBytes(sample, [0x4d, 0x5a])) {
    return {
      mimeType: "application/vnd.microsoft.portable-executable",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (
    startsWithBytes(sample, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWithBytes(sample, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWithBytes(sample, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWithBytes(sample, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWithBytes(sample, [0xca, 0xfe, 0xba, 0xbe])
  ) {
    return {
      mimeType: "application/x-mach-binary",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (startsWithAscii(sample, "#!")) {
    return {
      mimeType: "application/x-sh",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }

  // 2. Active markup/scripts (HTML / SVG) checked before generic XML or PDF
  const textLeadOffset = skipBomAndAsciiWhitespace(sample, 128);
  const headTextSlice = Buffer.from(
    sample.subarray(textLeadOffset, Math.min(sample.length, textLeadOffset + 256)),
  )
    .toString("utf8")
    .toLowerCase();

  if (
    headTextSlice.startsWith("<svg") ||
    (headTextSlice.startsWith("<?xml") && headTextSlice.includes("<svg"))
  ) {
    return {
      mimeType: "image/svg+xml",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (
    headTextSlice.startsWith("<!doctype html") ||
    headTextSlice.startsWith("<html") ||
    headTextSlice.startsWith("<script")
  ) {
    return {
      mimeType: "text/html",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }

  // 3. Standard images
  if (startsWithBytes(sample, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return {
      mimeType: "image/png",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (startsWithBytes(sample, [0xff, 0xd8, 0xff])) {
    return {
      mimeType: "image/jpeg",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (startsWithAscii(sample, "GIF87a") || startsWithAscii(sample, "GIF89a")) {
    return {
      mimeType: "image/gif",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (startsWithAscii(sample, "RIFF") && startsWithAscii(sample, "WEBP", 8)) {
    return {
      mimeType: "image/webp",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (
    startsWithBytes(sample, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(sample, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return {
      mimeType: "image/tiff",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }
  if (startsWithBytes(sample, [0x42, 0x4d])) {
    return {
      mimeType: "image/bmp",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }

  // 4. PDF (only allowed near offset 0 after BOM/whitespace, blocking prepended polyglots)
  const pdfLeadOffset = skipBomAndAsciiWhitespace(sample, 64);
  if (
    startsWithAscii(sample, "%PDF-1.", pdfLeadOffset) ||
    startsWithAscii(sample, "%PDF-2.", pdfLeadOffset)
  ) {
    return { mimeType: "application/pdf", isPolyglot: false, suspiciousCompressionRatio: false };
  }
  if (embeddedPdfOffset > 64) {
    return { mimeType: "application/pdf", isPolyglot: true, suspiciousCompressionRatio: false };
  }

  // 5. ZIP / OOXML containers
  if (
    startsWithBytes(sample, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(sample, [0x50, 0x4b, 0x05, 0x06])
  ) {
    const zipInfo = inspectZipSample(sample, maxExpansionRatio);
    return {
      mimeType: zipInfo.mimeType,
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: zipInfo.suspiciousCompressionRatio,
    };
  }

  // 6. Legacy OLE2 container
  if (startsWithBytes(sample, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return {
      mimeType: "application/x-ole-storage",
      isPolyglot: embeddedPdfOffset >= 0,
      suspiciousCompressionRatio: false,
    };
  }

  // 7. Strict UTF-8 plain text / JSON fallback
  const decodedText = tryDecodeUtf8Text(sample);
  if (decodedText !== null) {
    const trimmed = decodedText.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed);
        return {
          mimeType: "application/json",
          isPolyglot: false,
          suspiciousCompressionRatio: false,
        };
      } catch {
        // Large JSON truncated at header sample or regular text starting with brace -> text/plain
      }
    }
    return { mimeType: "text/plain", isPolyglot: false, suspiciousCompressionRatio: false };
  }

  return null;
}

export function normalizeDeclaredMimeType(rawMimeType: string): string | null {
  const base = rawMimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    base.length === 0 ||
    base.length > 127 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)
  ) {
    return null;
  }
  return MIME_ALIASES[base] ?? base;
}

function analyzeFileName(
  rawName: string,
):
  | { readonly valid: true; readonly extension: string; readonly dangerousExtension: boolean }
  | { readonly valid: false } {
  if (
    rawName.length === 0 ||
    rawName.length > 255 ||
    rawName.includes("/") ||
    rawName.includes("\\")
  ) {
    return { valid: false };
  }

  for (let i = 0; i < rawName.length; i += 1) {
    const code = rawName.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return { valid: false };
    }
  }

  const trimmed = rawName.trim();
  if (trimmed.length === 0 || trimmed === "." || trimmed === ".." || trimmed.endsWith(".")) {
    return { valid: false };
  }

  const dotParts = trimmed.split(".");
  if (dotParts.length < 2) {
    return { valid: true, extension: "", dangerousExtension: false };
  }

  const normalizedFinalExt = `.${(dotParts[dotParts.length - 1] ?? "").toLowerCase()}`;
  let hasDangerousExtension = false;
  for (let i = 1; i < dotParts.length; i += 1) {
    const candidateExt = `.${(dotParts[i] ?? "").toLowerCase()}`;
    if (DANGEROUS_EXTENSIONS.has(candidateExt)) {
      hasDangerousExtension = true;
      break;
    }
  }

  return {
    valid: true,
    extension: normalizedFinalExt,
    dangerousExtension: hasDangerousExtension,
  };
}

function buildSafeRejection(
  code: ContentRejectionCode,
  detectedMime: string | null,
  declaredMime: string | null,
  normalizedExtension: string | null,
): FileContentInspectionRejected {
  const safeMessage = SAFE_REJECTION_MESSAGES[code].slice(0, SAFE_REJECTION_MAX_LENGTH);
  return {
    accepted: false,
    detectedMime,
    declaredMime,
    normalizedExtension,
    rejection: {
      code,
      safeMessage,
      metadata: {
        rejectionCode: code,
        detectedMime,
        declaredMime,
        normalizedExtension,
      },
    },
  };
}

function resolveEffectiveDetectedMime(
  rawDetectedMime: string,
  normalizedExtension: string,
  normalizedDeclaredMime: string | null,
): string {
  if (rawDetectedMime === "text/plain") {
    if (normalizedExtension === ".csv") {
      return "text/csv";
    }
    if (normalizedExtension === ".json" && normalizedDeclaredMime === "application/json") {
      return "application/json";
    }
  }
  return rawDetectedMime;
}

/**
 * Inspects file header bytes against declared Content-Type, filename extension,
 * dangerous/polyglot rules, and a configurable MIME allowlist, returning safe rejection
 * details suitable for storage/audit without exposing unsafe technical details.
 */
export function inspectFileContent(
  sample: Uint8Array,
  input: FileContentInspectionInput,
  policy: ContentDetectionPolicy = {},
): FileContentInspectionResult {
  const declaredMime = normalizeDeclaredMimeType(input.declaredContentType);
  const nameInfo = analyzeFileName(input.originalFileName);

  if (!nameInfo.valid) {
    return buildSafeRejection("INVALID_FILENAME", null, declaredMime, null);
  }
  if (nameInfo.dangerousExtension) {
    return buildSafeRejection(
      "DANGEROUS_EXTENSION",
      null,
      declaredMime,
      nameInfo.extension || null,
    );
  }

  if (sample.length === 0 && !input.allowEmptyContent) {
    return buildSafeRejection("EMPTY_CONTENT", null, declaredMime, nameInfo.extension || null);
  }

  const signature = detectMimeFromBytes(sample, {
    maxZipExpansionRatio: policy.maxZipExpansionRatio,
  });

  if (!signature) {
    if (policy.allowUnrecognizedBinary) {
      const fallbackAllowedSet = new Set(
        (policy.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES)
          .map((m) => normalizeDeclaredMimeType(m))
          .filter((m): m is string => m !== null),
      );
      if (declaredMime && fallbackAllowedSet.has(declaredMime)) {
        return {
          accepted: true,
          detectedMime: declaredMime,
          declaredMime,
          normalizedExtension: nameInfo.extension,
          rejection: null,
        };
      }
    }
    return buildSafeRejection(
      "UNRECOGNIZED_CONTENT",
      null,
      declaredMime,
      nameInfo.extension || null,
    );
  }

  if (signature.isPolyglot) {
    return buildSafeRejection(
      "POLYGLOT_DETECTED",
      signature.mimeType,
      declaredMime,
      nameInfo.extension || null,
    );
  }

  if (signature.suspiciousCompressionRatio) {
    return buildSafeRejection(
      "ARCHIVE_EXPANSION_RISK",
      signature.mimeType,
      declaredMime,
      nameInfo.extension || null,
    );
  }

  const effectiveMime = resolveEffectiveDetectedMime(
    signature.mimeType,
    nameInfo.extension,
    declaredMime,
  );

  const rule = MIME_FORMAT_RULES[effectiveMime];
  if (rule?.dangerous) {
    return buildSafeRejection(
      "DANGEROUS_CONTENT",
      effectiveMime,
      declaredMime,
      nameInfo.extension || null,
    );
  }

  const allowedSet = new Set(
    (policy.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES)
      .map((item) => normalizeDeclaredMimeType(item))
      .filter((item): item is string => item !== null),
  );

  if (policy.allowedExtensions && policy.allowedExtensions.length > 0) {
    const allowedExtSet = new Set(
      policy.allowedExtensions.map((ext) => {
        const lower = ext.trim().toLowerCase();
        return lower.startsWith(".") ? lower : `.${lower}`;
      }),
    );
    if (!nameInfo.extension || !allowedExtSet.has(nameInfo.extension)) {
      return buildSafeRejection(
        "EXTENSION_NOT_ALLOWED",
        effectiveMime,
        declaredMime,
        nameInfo.extension || null,
      );
    }
  }

  if (!allowedSet.has(effectiveMime)) {
    return buildSafeRejection(
      "MIME_NOT_ALLOWED",
      effectiveMime,
      declaredMime,
      nameInfo.extension || null,
    );
  }

  const requireExtensionMatch = policy.requireExtensionMatch ?? true;
  if (requireExtensionMatch && rule && !rule.allowedExtensions.includes(nameInfo.extension)) {
    return buildSafeRejection(
      "EXTENSION_MISMATCH",
      effectiveMime,
      declaredMime,
      nameInfo.extension || null,
    );
  }

  const requireDeclaredTypeMatch = policy.requireDeclaredTypeMatch ?? true;
  if (requireDeclaredTypeMatch) {
    const allowedGenericOctet =
      policy.allowGenericOctetStreamDeclaration === true &&
      declaredMime === "application/octet-stream";

    if (!allowedGenericOctet && declaredMime !== effectiveMime) {
      return buildSafeRejection(
        "DECLARED_TYPE_MISMATCH",
        effectiveMime,
        declaredMime,
        nameInfo.extension || null,
      );
    }
  }

  return {
    accepted: true,
    detectedMime: effectiveMime,
    declaredMime: declaredMime ?? effectiveMime,
    normalizedExtension: nameInfo.extension,
    rejection: null,
  };
}

/**
 * Reads up to `maxHeaderSampleBytes` from a Node stream without buffering the whole file,
 * detects content type, enforces allowlist policy, and records any safe rejection.
 */
export async function inspectFileContentFromStream(
  stream: Readable,
  input: FileContentInspectionInput,
  policy: ContentDetectionPolicy = {},
  recorder?: SafeRejectionRecorderPort,
): Promise<FileContentInspectionResult> {
  const maxBytes = Math.max(512, policy.maxHeaderSampleBytes ?? DEFAULT_HEADER_SAMPLE_BYTES);
  const chunks: Buffer[] = [];
  let collectedBytes = 0;

  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      if (chunk.length === 0) {
        continue;
      }
      const remaining = maxBytes - collectedBytes;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        collectedBytes += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, remaining));
        collectedBytes += remaining;
      }

      if (collectedBytes >= maxBytes) {
        break;
      }
    }
  } finally {
    if (!stream.destroyed) {
      stream.destroy();
    }
  }

  const sample = Buffer.concat(chunks, collectedBytes);
  const result = inspectFileContent(sample, input, policy);
  if (!result.accepted && recorder) {
    await recorder.recordRejection(result.rejection);
  }
  return result;
}
