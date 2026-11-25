import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type OfficePreviewConversionErrorCode =
  | "CONVERTER_UNAVAILABLE"
  | "CONVERSION_TIMEOUT"
  | "CONVERSION_FAILED";

export class OfficePreviewConversionError extends Error {
  readonly code: OfficePreviewConversionErrorCode;

  constructor(code: OfficePreviewConversionErrorCode, message: string) {
    super(message);
    this.name = "OfficePreviewConversionError";
    this.code = code;
  }
}

export interface OfficePreviewConverterInput {
  readonly buffer: Buffer;
  readonly originalFileName: string;
  readonly mimeType: string;
  readonly checksumSha256: string;
}

export interface OfficePreviewConverterPort {
  convertToPdf(input: OfficePreviewConverterInput): Promise<Buffer>;
}

export interface GotenbergOfficeConverterOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number | undefined;
  readonly cacheDir?: string | undefined;
  readonly maxCacheEntries?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const SAFE_SHA256_REGEX = /^[a-f0-9]{64}$/i;

function resolveSafeOfficeExtension(originalFileName: string, mimeType: string): string {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return ".docx";
  }
  if (lowerMime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return ".pptx";
  }
  const lowerName = originalFileName.trim().toLowerCase();
  if (lowerName.endsWith(".docx")) return ".docx";
  if (lowerName.endsWith(".doc")) return ".doc";
  if (lowerName.endsWith(".pptx")) return ".pptx";
  if (lowerName.endsWith(".ppt")) return ".ppt";
  return ".docx";
}

function isPdfBuffer(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function pruneCacheDirectory(cacheDir: string, maxEntries: number): Promise<void> {
  try {
    const names = await readdir(cacheDir);
    const pdfNames = names.filter((name) => name.endsWith(".pdf"));
    if (pdfNames.length <= maxEntries) {
      return;
    }

    const withStats = await Promise.all(
      pdfNames.map(async (name) => {
        const fullPath = path.join(cacheDir, name);
        try {
          const info = await stat(fullPath);
          return { fullPath, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }),
    );

    const valid = withStats
      .filter((item): item is { fullPath: string; mtimeMs: number } => item !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const removeCount = valid.length - maxEntries;
    for (let i = 0; i < removeCount; i += 1) {
      const target = valid[i];
      if (target) {
        await unlink(target.fullPath).catch(() => undefined);
      }
    }
  } catch {
    // Non-fatal cache maintenance failure.
  }
}

/**
 * Isolated HTTP client for Gotenberg LibreOffice conversion (`POST /forms/libreoffice/convert`)
 * with opaque filenames (zero PII), strict timeout, PDF magic-byte validation, and bounded
 * ephemeral tmpfs caching keyed by immutable SHA-256 checksum.
 */
export function createGotenbergOfficeConverter(
  options: GotenbergOfficeConverterOptions,
): OfficePreviewConverterPort {
  const normalizedBaseUrl = options.baseUrl.replace(/\/+$/, "");
  const parsedUrl = new URL(normalizedBaseUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("OFFICE_CONVERTER_URL deve utilizar protocolo http ou https.");
  }

  const endpoint = `${normalizedBaseUrl}/forms/libreoffice/convert`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheDir = options.cacheDir ?? path.join(os.tmpdir(), "papyrus-office-preview-cache");
  const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const fetchImpl = options.fetchFn ?? globalThis.fetch;

  return {
    async convertToPdf(input: OfficePreviewConverterInput): Promise<Buffer> {
      const safeHash = SAFE_SHA256_REGEX.test(input.checksumSha256)
        ? input.checksumSha256.toLowerCase()
        : null;
      const cachePath = safeHash ? path.join(cacheDir, `${safeHash}.pdf`) : null;

      if (cachePath) {
        try {
          const cached = await readFile(cachePath);
          if (isPdfBuffer(cached)) {
            return cached;
          }
        } catch {
          // Cache miss — proceed with conversion.
        }
      }

      const extension = resolveSafeOfficeExtension(input.originalFileName, input.mimeType);
      const opaqueFileName = `document${extension}`;
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(input.buffer)], {
        type: input.mimeType || "application/octet-stream",
      });
      formData.append("files", blob, opaqueFileName);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          body: formData,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const isTimeout =
          (error instanceof DOMException && error.name === "TimeoutError") ||
          (error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError"));
        if (isTimeout) {
          throw new OfficePreviewConversionError(
            "CONVERSION_TIMEOUT",
            "Tempo excedido ao converter o documento para pré-visualização em PDF.",
          );
        }
        throw new OfficePreviewConversionError(
          "CONVERTER_UNAVAILABLE",
          "Serviço de conversão para pré-visualização indisponível no momento.",
        );
      }

      if (!response.ok) {
        throw new OfficePreviewConversionError(
          response.status >= 500 ? "CONVERTER_UNAVAILABLE" : "CONVERSION_FAILED",
          "Não foi possível converter este arquivo Office para pré-visualização em PDF.",
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const pdfBuffer = Buffer.from(arrayBuffer);
      if (!isPdfBuffer(pdfBuffer)) {
        throw new OfficePreviewConversionError(
          "CONVERSION_FAILED",
          "O serviço de conversão retornou uma resposta inválida para pré-visualização.",
        );
      }

      if (cachePath) {
        try {
          await mkdir(cacheDir, { recursive: true });
          const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
          await writeFile(tempPath, pdfBuffer);
          await rename(tempPath, cachePath);
          void pruneCacheDirectory(cacheDir, maxCacheEntries);
        } catch {
          // Non-fatal cache write failure.
        }
      }

      return pdfBuffer;
    },
  };
}
