import type { Readable } from "node:stream";
import { inflateRawSync, inflateSync } from "node:zlib";
import { evaluateAndNormalizeExtractedText } from "./quality.js";
import type { TextExtractionOutcome, TextExtractionPolicy, TextExtractorKind } from "./types.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    });
}

function extractTextFromDocxBuffer(
  buffer: Buffer,
  policy: TextExtractionPolicy,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== ZIP_LOCAL_FILE_SIGNATURE) {
      break;
    }

    const flags = buffer.readUInt16LE(offset + 6);
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);

    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    if (dataStart > buffer.length || fileNameLength === 0) {
      break;
    }

    const entryName = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    const hasDataDescriptor = (flags & 0x08) !== 0;

    let entryCompressedSlice: Buffer;
    let nextOffset: number;

    if (hasDataDescriptor && compressedSize === 0) {
      const nextHeaderOffset = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataStart);
      const centralDirOffset = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
      const endOffset =
        nextHeaderOffset !== -1 && (centralDirOffset === -1 || nextHeaderOffset < centralDirOffset)
          ? nextHeaderOffset
          : centralDirOffset !== -1
            ? centralDirOffset
            : buffer.length;
      entryCompressedSlice = buffer.subarray(dataStart, endOffset);
      nextOffset = endOffset;
    } else {
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buffer.length) {
        return { ok: false, reason: "Estrutura ZIP truncada durante a leitura do DOCX." };
      }
      entryCompressedSlice = buffer.subarray(dataStart, dataEnd);
      nextOffset = dataEnd;
    }

    if (entryName === "word/document.xml") {
      if (uncompressedSize > policy.maxZipEntryBytes) {
        return { ok: false, reason: "Entrada XML do DOCX excede o limite de tamanho permitido." };
      }
      if (compressedSize > 0 && uncompressedSize > compressedSize * policy.maxCompressionRatio) {
        return { ok: false, reason: "Taxa de compressão suspeita no conteúdo XML do DOCX." };
      }

      let xmlBuffer: Buffer;
      if (compressionMethod === 0) {
        if (entryCompressedSlice.length > policy.maxZipEntryBytes) {
          return { ok: false, reason: "Entrada XML do DOCX excede o limite de tamanho permitido." };
        }
        xmlBuffer = entryCompressedSlice;
      } else if (compressionMethod === 8) {
        try {
          xmlBuffer = inflateRawSync(entryCompressedSlice, {
            maxOutputLength: policy.maxZipEntryBytes,
          });
        } catch {
          return {
            ok: false,
            reason: "Falha ou limite excedido ao descompactar XML do documento DOCX.",
          };
        }
      } else {
        return { ok: false, reason: "Método de compressão ZIP não suportado para extração." };
      }

      const xmlString = xmlBuffer.toString("utf8");
      const rawText = decodeXmlEntities(
        xmlString
          .replace(/<\/w:p>/g, "\n")
          .replace(/<w:br\b[^>]*\/>/g, "\n")
          .replace(/<w:tab\b[^>]*\/>/g, " ")
          .replace(/<[^>]+>/g, ""),
      );
      return { ok: true, text: rawText };
    }

    offset = nextOffset;
  }

  return { ok: false, reason: "Conteúdo textual word/document.xml não encontrado no DOCX." };
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

  // Match literal strings followed by Tj or collected inside [...] TJ arrays
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

  // Direct uncompressed PDF text operators if present
  const directText = extractPdfOperatorsText(rawLatin1);
  if (directText.length > 0) {
    collected.push(directText);
  }

  // Decompress bounded FlateDecode streams
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

/**
 * Performs bounded, toggle-aware text extraction from an in-memory buffer within
 * configured byte, timeout, and text quality limits.
 */
export async function extractTextFromBuffer(
  input: { readonly content: Buffer; readonly mimeType: string },
  policy: TextExtractionPolicy,
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
  const runExtraction = (): TextExtractionOutcome => {
    if (Date.now() > deadlineMs) {
      return { status: "TIMED_OUT", timeoutMs: policy.timeoutMs };
    }

    if (normalizedMime === "text/plain" || normalizedMime === "text/csv") {
      return finalizeOutcome(input.content.toString("utf8"), normalizedMime, "plain_text", policy);
    }

    if (normalizedMime === "application/pdf") {
      const pdfText = extractTextFromPdfBuffer(input.content, policy);
      return finalizeOutcome(pdfText, normalizedMime, "pdf_basic", policy);
    }

    if (normalizedMime === DOCX_MIME) {
      const docxResult = extractTextFromDocxBuffer(input.content, policy);
      if (!docxResult.ok) {
        return { status: "FAILED", reason: docxResult.reason };
      }
      return finalizeOutcome(docxResult.text, normalizedMime, "docx_xml", policy);
    }

    return { status: "UNSUPPORTED_MIME", mimeType: normalizedMime };
  };

  return runExtraction();
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
      void extractTextFromBuffer({ content: buffer, mimeType: normalizedMime }, policy).then(
        finish,
      );
    });
  });
}
