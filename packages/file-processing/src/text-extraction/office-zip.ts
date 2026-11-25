import { inflateRawSync } from "node:zlib";
import type { TextExtractionPolicy } from "./types.js";

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_ZIP_ENTRIES = 256;

export interface SafeZipXmlEntry {
  readonly name: string;
  readonly content: string;
}

export function decodeXmlEntities(value: string): string {
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

function extractTrailingNumber(name: string): number {
  const match = /(\d+)\.xml$/i.exec(name);
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Safely iterates ZIP local entries with strict anti-zip-bomb decompression bounds
 * (`maxZipEntryBytes`, `maxCompressionRatio`, and aggregate output limits).
 */
export function readSafeZipXmlEntries(
  buffer: Buffer,
  policy: TextExtractionPolicy,
  shouldIncludeEntry: (entryName: string) => boolean,
):
  | { readonly ok: true; readonly entries: readonly SafeZipXmlEntry[] }
  | { readonly ok: false; readonly reason: string } {
  const entries: SafeZipXmlEntry[] = [];
  const maxAggregateUncompressed = policy.maxZipEntryBytes * 4;
  let totalUncompressed = 0;
  let visitedEntries = 0;
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== ZIP_LOCAL_FILE_SIGNATURE) {
      break;
    }

    visitedEntries += 1;
    if (visitedEntries > MAX_ZIP_ENTRIES) {
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
        return { ok: false, reason: "Estrutura ZIP truncada durante a leitura do arquivo Office." };
      }
      entryCompressedSlice = buffer.subarray(dataStart, dataEnd);
      nextOffset = dataEnd;
    }

    if (shouldIncludeEntry(entryName)) {
      if (uncompressedSize > policy.maxZipEntryBytes) {
        return {
          ok: false,
          reason: "Entrada XML do arquivo Office excede o limite de tamanho permitido.",
        };
      }
      if (compressedSize > 0 && uncompressedSize > compressedSize * policy.maxCompressionRatio) {
        return {
          ok: false,
          reason: "Taxa de compressão suspeita no conteúdo XML do arquivo Office.",
        };
      }

      let xmlBuffer: Buffer;
      if (compressionMethod === 0) {
        if (entryCompressedSlice.length > policy.maxZipEntryBytes) {
          return {
            ok: false,
            reason: "Entrada XML do arquivo Office excede o limite de tamanho permitido.",
          };
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
            reason: "Falha ou limite excedido ao descompactar XML do arquivo Office.",
          };
        }
      } else {
        return { ok: false, reason: "Método de compressão ZIP não suportado para extração." };
      }

      if (
        entryCompressedSlice.length > 0 &&
        xmlBuffer.length > entryCompressedSlice.length * policy.maxCompressionRatio
      ) {
        return {
          ok: false,
          reason: "Taxa de compressão real excede o limite de segurança configurado.",
        };
      }

      totalUncompressed += xmlBuffer.length;
      if (totalUncompressed > maxAggregateUncompressed) {
        break;
      }

      entries.push({
        name: entryName,
        content: xmlBuffer.toString("utf8"),
      });
    }

    offset = nextOffset;
  }

  return { ok: true, entries };
}

export function extractDocxXmlText(
  buffer: Buffer,
  policy: TextExtractionPolicy,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const zipResult = readSafeZipXmlEntries(
    buffer,
    policy,
    (name) => name === "word/document.xml" || /^word\/(?:header|footer)\d*\.xml$/i.test(name),
  );
  if (!zipResult.ok) {
    return zipResult;
  }

  const ordered = [...zipResult.entries].sort((a, b) => {
    if (a.name === "word/document.xml") return -1;
    if (b.name === "word/document.xml") return 1;
    return a.name.localeCompare(b.name);
  });

  if (!ordered.some((entry) => entry.name === "word/document.xml")) {
    return { ok: false, reason: "Conteúdo textual word/document.xml não encontrado no DOCX." };
  }

  const sections = ordered.map((entry) =>
    decodeXmlEntities(
      entry.content
        .replace(/<\/w:p>/g, "\n")
        .replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<w:tab\b[^>]*\/>/g, " ")
        .replace(/<[^>]+>/g, ""),
    ),
  );

  return { ok: true, text: sections.join("\n") };
}

function parseSharedStrings(xml: string): readonly string[] {
  const strings: string[] = [];
  const siMatches = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g);
  for (const si of siMatches) {
    const inner = si[1] ?? "";
    const textChunks: string[] = [];
    for (const tMatch of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      if (tMatch[1]) {
        textChunks.push(decodeXmlEntities(tMatch[1]));
      }
    }
    strings.push(textChunks.join(""));
  }
  return strings;
}

export function extractXlsxXmlText(
  buffer: Buffer,
  policy: TextExtractionPolicy,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const zipResult = readSafeZipXmlEntries(
    buffer,
    policy,
    (name) => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name),
  );
  if (!zipResult.ok) {
    return zipResult;
  }

  const sharedStringsEntry = zipResult.entries.find((e) => e.name === "xl/sharedStrings.xml");
  const sharedStrings = sharedStringsEntry ? parseSharedStrings(sharedStringsEntry.content) : [];

  const worksheets = zipResult.entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
    .sort((a, b) => extractTrailingNumber(a.name) - extractTrailingNumber(b.name));

  if (worksheets.length === 0) {
    return { ok: false, reason: "Nenhuma planilha foi encontrada dentro do arquivo XLSX." };
  }

  const extractedRows: string[] = [];
  for (const sheet of worksheets) {
    for (const rowMatch of sheet.content.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowXml = rowMatch[1] ?? "";
      const rowValues: string[] = [];

      for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1] ?? "";
        const cellBody = cellMatch[2] ?? "";
        const typeMatch = /\bt="([^"]+)"/.exec(attrs);
        const cellType = typeMatch?.[1] ?? "";

        if (cellType === "inlineStr") {
          const inlineParts: string[] = [];
          for (const t of cellBody.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
            if (t[1]) {
              inlineParts.push(decodeXmlEntities(t[1]));
            }
          }
          const combined = inlineParts.join("").trim();
          if (combined.length > 0) {
            rowValues.push(combined);
          }
          continue;
        }

        const valMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellBody);
        const rawVal = valMatch?.[1] ?? "";
        if (rawVal.length === 0) {
          continue;
        }

        if (cellType === "s") {
          const idx = Number.parseInt(rawVal, 10);
          const resolved = Number.isInteger(idx) ? sharedStrings[idx] : undefined;
          if (resolved && resolved.trim().length > 0) {
            rowValues.push(resolved.trim());
          }
        } else {
          const decoded = decodeXmlEntities(rawVal).trim();
          if (decoded.length > 0) {
            rowValues.push(decoded);
          }
        }
      }

      if (rowValues.length > 0) {
        extractedRows.push(rowValues.join(" "));
      }
    }
  }

  return { ok: true, text: extractedRows.join("\n") };
}

export function extractPptxXmlText(
  buffer: Buffer,
  policy: TextExtractionPolicy,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const zipResult = readSafeZipXmlEntries(
    buffer,
    policy,
    (name) =>
      /^ppt\/slides\/slide\d+\.xml$/i.test(name) ||
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name),
  );
  if (!zipResult.ok) {
    return zipResult;
  }

  const slides = zipResult.entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
    .sort((a, b) => extractTrailingNumber(a.name) - extractTrailingNumber(b.name));
  const notes = zipResult.entries
    .filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(e.name))
    .sort((a, b) => extractTrailingNumber(a.name) - extractTrailingNumber(b.name));

  if (slides.length === 0) {
    return { ok: false, reason: "Nenhum slide textual foi encontrado no arquivo PPTX." };
  }

  const blocks: string[] = [];
  for (const item of [...slides, ...notes]) {
    const cleaned = decodeXmlEntities(
      item.content
        .replace(/<\/a:p>/g, "\n")
        .replace(/<a:br\b[^>]*\/>/g, "\n")
        .replace(/<[^>]+>/g, ""),
    ).trim();
    if (cleaned.length > 0) {
      blocks.push(cleaned);
    }
  }

  return { ok: true, text: blocks.join("\n\n") };
}

export function extractMarkdownText(rawMarkdown: string): string {
  return rawMarkdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?|```/g, ""))
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>|]/g, " ");
}

function collectJsonReadableTokens(
  value: unknown,
  output: string[],
  maxChars: number,
  currentLen: { total: number },
  parentKey?: string,
): void {
  if (currentLen.total >= maxChars || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const scalar = String(value).trim();
    if (scalar.length === 0) {
      return;
    }
    const line = parentKey ? `${parentKey}: ${scalar}` : scalar;
    output.push(line);
    currentLen.total += line.length + 1;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonReadableTokens(item, output, maxChars, currentLen, parentKey);
      if (currentLen.total >= maxChars) {
        break;
      }
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectJsonReadableTokens(nested, output, maxChars, currentLen, key);
      if (currentLen.total >= maxChars) {
        break;
      }
    }
  }
}

export function extractJsonText(rawJson: string, maxExtractedChars: number): string {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const lines: string[] = [];
    collectJsonReadableTokens(parsed, lines, maxExtractedChars, { total: 0 });
    return lines.join("\n");
  } catch {
    return rawJson;
  }
}
