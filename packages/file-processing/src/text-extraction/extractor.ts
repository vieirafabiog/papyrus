import type { Readable } from "node:stream";
import { inflateSync } from "node:zlib";
import {
  extractDocxXmlText,
  extractJsonText,
  extractMarkdownText,
  extractPptxXmlText,
  extractXlsxXmlText,
} from "./office-zip.js";
import { evaluateAndNormalizeExtractedText } from "./quality.js";
import {
  DEFAULT_OCR_IMAGE_MIME_TYPES,
  type TextExtractionOutcome,
  type TextExtractionPolicy,
  type TextExtractorKind,
  type TextOcrEnginePort,
} from "./types.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const OCR_IMAGE_MIME_SET = new Set<string>(DEFAULT_OCR_IMAGE_MIME_TYPES);

export interface ExtractTextOptions {
  readonly ocrEngine?: TextOcrEnginePort | undefined;
}

function unescapePdfLiteral(literal: string): string {
  let out = "";
  for (let i = 0; i < literal.length; i += 1) {
    const ch = literal[i] ?? "";
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = literal[i + 1];
    if (next === undefined) {
      break;
    }
    i += 1;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "\\":
      case "(":
      case ")":
        out += next;
        break;
      default:
        out += next;
        break;
    }
  }
  return out;
}

function extractPdfOperatorsText(contentStreamText: string): string {
  const parts: string[] = [];

  const tjMatches = contentStreamText.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g);
  for (const match of tjMatches) {
    if (match[1]) {
      parts.push(unescapePdfLiteral(match[1]));
    }
  }

  const tjArrayMatches = contentStreamText.matchAll(/\[([\s\S]*?)\]\s*TJ/g);
  for (const arrayMatch of tjArrayMatches) {
    const inner = arrayMatch[1] ?? "";
    const literals = inner.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g);
    const joined: string[] = [];
    for (const lit of literals) {
      if (lit[1]) {
        joined.push(unescapePdfLiteral(lit[1]));
      }
    }
    if (joined.length > 0) {
      parts.push(joined.join(""));
    }
  }

  return parts.join("\n");
}

function extractTextFromPdfBuffer(buffer: Buffer, policy: TextExtractionPolicy): string {
  const collected: string[] = [];
  const rawLatin1 = buffer.toString("latin1");

  const directText = extractPdfOperatorsText(rawLatin1);
  if (directText.length > 0) {
    collected.push(directText);
  }

  let searchFrom = 0;
  while (searchFrom < buffer.length) {
    const streamTokenIdx = rawLatin1.indexOf("stream", searchFrom);
    if (streamTokenIdx === -1) {
      break;
    }
    const dictWindowStart = Math.max(0, streamTokenIdx - 512);
    const precedingDict = rawLatin1.slice(dictWindowStart, streamTokenIdx);
    let dataStart = streamTokenIdx + "stream".length;
    if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a) {
      dataStart += 2;
    } else if (buffer[dataStart] === 0x0a) {
      dataStart += 1;
    } else {
      searchFrom = streamTokenIdx + 6;
      continue;
    }

    const endStreamIdx = rawLatin1.indexOf("endstream", dataStart);
    if (endStreamIdx === -1) {
      break;
    }
    searchFrom = endStreamIdx + "endstream".length;

    if (!precedingDict.includes("/FlateDecode")) {
      continue;
    }

    const compressedBytes = buffer.subarray(dataStart, endStreamIdx);
    if (compressedBytes.length === 0) {
      continue;
    }

    try {
      const inflated = inflateSync(compressedBytes, {
        maxOutputLength: policy.maxZipEntryBytes,
      });
      if (inflated.length > compressedBytes.length * policy.maxCompressionRatio * 4) {
        continue;
      }
      const streamText = extractPdfOperatorsText(inflated.toString("latin1"));
      if (streamText.length > 0) {
        collected.push(streamText);
      }
    } catch {
      // Ignore corrupt or non-text streams cleanly; quality gate validates overall output.
    }
  }

  return collected.join("\n");
}

function finalizeOutcome(
  rawText: string,
  mimeType: string,
  extractorKind: TextExtractorKind,
  policy: TextExtractionPolicy,
): TextExtractionOutcome {
  const quality = evaluateAndNormalizeExtractedText(rawText, policy);
  if (!quality.accepted) {
    return {
      status: "LOW_QUALITY",
      reason: quality.reason,
      printableRatio: quality.printableRatio,
      charCount: quality.charCount,
    };
  }

  return {
    status: "EXTRACTED",
    text: quality.text,
    truncated: quality.truncated,
    charCount: quality.charCount,
    printableRatio: quality.printableRatio,
    mimeType,
    extractorKind,
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const errObj = error as Error & { readonly killed?: boolean; readonly code?: string };
  return (
    errObj.killed === true || errObj.code === "ETIMEDOUT" || /timed?\s*out/i.test(errObj.message)
  );
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const errObj = error as Error & { readonly killed?: boolean; readonly code?: string };
  return (
    errObj.killed === true ||
    errObj.code === "ETIMEDOUT" ||
    /timed?\s*out/i.test(errObj.message)
  );
}

/**
 * Performs bounded, toggle-aware text extraction from an in-memory buffer within
 * configured byte, timeout, quality, and optional OCR fallback limits.
 */
export async function extractTextFromBuffer(
  input: { readonly content: Buffer; readonly mimeType: string },
  policy: TextExtractionPolicy,
  options: ExtractTextOptions = {},
): Promise<TextExtractionOutcome> {
  if (!policy.enabled) {
    return { status: "DISABLED" };
  }

  const normalizedMime = input.mimeType.trim().toLowerCase();
  const allowedSet = new Set(policy.allowedMimeTypes.map((m) => m.toLowerCase()));
  if (!allowedSet.has(normalizedMime)) {
    return { status: "UNSUPPORTED_MIME", mimeType: normalizedMime };
  }

  if (input.content.length > policy.maxInputBytes) {
    return {
      status: "SKIPPED_TOO_LARGE",
      sizeBytes: input.content.length,
      maxInputBytes: policy.maxInputBytes,
    };
  }

  const deadlineMs = Date.now() + policy.timeoutMs;
  if (Date.now() > deadlineMs) {
    return { status: "TIMED_OUT", timeoutMs: policy.timeoutMs };
  }

  if (normalizedMime === "text/plain" || normalizedMime === "text/csv") {
    return finalizeOutcome(input.content.toString("utf8"), normalizedMime, "plain_text", policy);
  }

  if (normalizedMime === "text/markdown") {
    const cleanMd = extractMarkdownText(input.content.toString("utf8"));
    return finalizeOutcome(cleanMd, normalizedMime, "structured_text", policy);
  }

  if (normalizedMime === "application/json") {
    const cleanJson = extractJsonText(input.content.toString("utf8"), policy.maxExtractedChars);
    return finalizeOutcome(cleanJson, normalizedMime, "structured_text", policy);
  }

  if (normalizedMime === DOCX_MIME) {
    const docxResult = extractDocxXmlText(input.content, policy);
    if (!docxResult.ok) {
      return { status: "FAILED", reason: docxResult.reason };
    }
    return finalizeOutcome(docxResult.text, normalizedMime, "docx_xml", policy);
  }

  if (normalizedMime === XLSX_MIME) {
    const xlsxResult = extractXlsxXmlText(input.content, policy);
    if (!xlsxResult.ok) {
      return { status: "FAILED", reason: xlsxResult.reason };
    }
    return finalizeOutcome(xlsxResult.text, normalizedMime, "xlsx_xml", policy);
  }

  if (normalizedMime === PPTX_MIME) {
    const pptxResult = extractPptxXmlText(input.content, policy);
    if (!pptxResult.ok) {
      return { status: "FAILED", reason: pptxResult.reason };
    }
    return finalizeOutcome(pptxResult.text, normalizedMime, "pptx_xml", policy);
  }

  if (OCR_IMAGE_MIME_SET.has(normalizedMime)) {
    if (!policy.ocr.enabled) {
      return {
        status: "OCR_UNAVAILABLE",
        reason: "O reconhecimento OCR para imagens está desabilitado na política atual.",
      };
    }
    if (!options.ocrEngine) {
      return {
        status: "OCR_UNAVAILABLE",
        reason: "Motor de OCR não disponível neste ambiente para extrair texto da imagem.",
      };
    }

    const ocrTimeoutMs = Math.min(policy.ocr.timeoutMs, Math.max(500, deadlineMs - Date.now()));
    try {
      const ocrText = await options.ocrEngine.recognizeImageBuffer({
        buffer: input.content,
        mimeType: normalizedMime,
        languages: policy.ocr.languages,
        timeoutMs: ocrTimeoutMs,
      });
      return finalizeOutcome(ocrText, normalizedMime, "ocr_image", policy);
    } catch (error) {
      if (isTimeoutError(error)) {
        return { status: "TIMED_OUT", timeoutMs: ocrTimeoutMs };
      }
      return {
        status: "FAILED",
        reason: error instanceof Error ? error.message : "Falha no OCR da imagem.",
      };
    }
  }

  if (normalizedMime === "application/pdf") {
    let nativeText = "";
    let nativeKind: TextExtractorKind = "pdf_basic";

    if (options.ocrEngine?.extractPdfText) {
      const popplerTimeout = Math.min(10_000, Math.max(500, deadlineMs - Date.now()));
      const popplerText = await options.ocrEngine.extractPdfText({
        buffer: input.content,
        timeoutMs: popplerTimeout,
      });
      if (popplerText && popplerText.trim().length > 0) {
        nativeText = popplerText;
        nativeKind = "pdf_poppler";
      }
    }

    if (nativeText.trim().length === 0) {
      nativeText = extractTextFromPdfBuffer(input.content, policy);
      nativeKind = "pdf_basic";
    }

    const nativeOutcome = finalizeOutcome(nativeText, normalizedMime, nativeKind, policy);
    if (
      nativeOutcome.status === "EXTRACTED" &&
      nativeOutcome.charCount >= policy.ocr.minNativePdfCharsForSkipOcr
    ) {
      return nativeOutcome;
    }

    if (!policy.ocr.enabled) {
      return nativeOutcome;
    }

    if (!options.ocrEngine) {
      return {
        status: "OCR_UNAVAILABLE",
        reason: "PDF sem texto pesquisável e motor de OCR indisponível neste ambiente.",
      };
    }

    const ocrTimeoutMs = Math.min(policy.ocr.timeoutMs, Math.max(500, deadlineMs - Date.now()));
    try {
      const ocrPdfText = await options.ocrEngine.recognizePdfBuffer({
        buffer: input.content,
        languages: policy.ocr.languages,
        maxPages: policy.ocr.maxPdfPages,
        timeoutMs: ocrTimeoutMs,
      });
      return finalizeOutcome(ocrPdfText, normalizedMime, "ocr_pdf", policy);
    } catch (error) {
      if (isTimeoutError(error)) {
        return { status: "TIMED_OUT", timeoutMs: ocrTimeoutMs };
      }
      return {
        status: "FAILED",
        reason: error instanceof Error ? error.message : "Falha ao executar OCR no PDF.",
      };
    }
  }

  return { status: "UNSUPPORTED_MIME", mimeType: normalizedMime };
}

/**
 * Streams up to `policy.maxInputBytes` before aborting cleanly on oversized
 * files or extraction timeouts. Never reads an unbounded stream into memory.
 */
export async function extractTextFromStream(
  input: {
    readonly stream: Readable;
    readonly mimeType: string;
    readonly declaredSizeBytes?: number | undefined;
  },
  policy: TextExtractionPolicy,
  options: ExtractTextOptions = {},
): Promise<TextExtractionOutcome> {
  if (!policy.enabled) {
    input.stream.destroy();
    return { status: "DISABLED" };
  }

  const normalizedMime = input.mimeType.trim().toLowerCase();
  const allowedSet = new Set(policy.allowedMimeTypes.map((m) => m.toLowerCase()));
  if (!allowedSet.has(normalizedMime)) {
    input.stream.destroy();
    return { status: "UNSUPPORTED_MIME", mimeType: normalizedMime };
  }

  if (input.declaredSizeBytes !== undefined && input.declaredSizeBytes > policy.maxInputBytes) {
    input.stream.destroy();
    return {
      status: "SKIPPED_TOO_LARGE",
      sizeBytes: input.declaredSizeBytes,
      maxInputBytes: policy.maxInputBytes,
    };
  }

  const chunks: Buffer[] = [];
  let bytesRead = 0;

  return new Promise<TextExtractionOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: TextExtractionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      input.stream.destroy();
      finish({ status: "TIMED_OUT", timeoutMs: policy.timeoutMs });
    }, policy.timeoutMs);

    input.stream.on("data", (chunk: unknown) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytesRead += buf.length;
      if (bytesRead > policy.maxInputBytes) {
        input.stream.destroy();
        finish({
          status: "SKIPPED_TOO_LARGE",
          sizeBytes: bytesRead,
          maxInputBytes: policy.maxInputBytes,
        });
        return;
      }
      chunks.push(buf);
    });

    input.stream.on("error", (err) => {
      finish({ status: "FAILED", reason: err.message });
    });

    input.stream.on("end", () => {
      const buffer = Buffer.concat(chunks, bytesRead);
      void extractTextFromBuffer(
        { content: buffer, mimeType: normalizedMime },
        policy,
        options,
      ).then(finish);
    });
  });
}
