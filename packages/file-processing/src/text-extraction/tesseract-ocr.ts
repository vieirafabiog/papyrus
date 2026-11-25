import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TextOcrEnginePort } from "./types.js";

export interface BinaryExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type BinaryExecRunner = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxBufferBytes: number },
) => Promise<BinaryExecutionResult>;

export interface TesseractOcrEngineOptions {
  readonly tesseractBin?: string | undefined;
  readonly pdftotextBin?: string | undefined;
  readonly pdftoppmBin?: string | undefined;
  readonly tempRoot?: string | undefined;
  readonly pdfRenderDpi?: number | undefined;
  readonly maxOutputBufferBytes?: number | undefined;
  readonly execRunner?: BinaryExecRunner | undefined;
}

const IMAGE_MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
};

const SAFE_TESSERACT_LANG_REGEX = /^[a-z]{3}(?:_[a-z]+)?$/i;

function defaultExecRunner(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxBufferBytes: number },
): Promise<BinaryExecutionResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        shell: false,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function sanitizeLanguages(languages: readonly string[]): string {
  const safe = languages
    .map((lang) => lang.trim().toLowerCase())
    .filter((lang) => SAFE_TESSERACT_LANG_REGEX.test(lang));
  return safe.length > 0 ? safe.join("+") : "por+eng";
}

function extractTrailingPageNumber(fileName: string): number {
  const match = /-(\d+)\.png$/i.exec(fileName);
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Checks whether native `tesseract` and `pdftoppm` binaries respond cleanly in the runtime environment.
 */
export async function checkOcrToolchainAvailability(
  options: {
    readonly tesseractBin?: string | undefined;
    readonly pdftoppmBin?: string | undefined;
    readonly execRunner?: BinaryExecRunner | undefined;
  } = {},
): Promise<{
  readonly available: boolean;
  readonly tesseractAvailable: boolean;
  readonly popplerAvailable: boolean;
}> {
  const runner = options.execRunner ?? defaultExecRunner;
  const tesseractBin = options.tesseractBin ?? "tesseract";
  const pdftoppmBin = options.pdftoppmBin ?? "pdftoppm";

  const [tessOk, popplerOk] = await Promise.all([
    runner(tesseractBin, ["--version"], { timeoutMs: 3_000, maxBufferBytes: 64 * 1024 })
      .then(() => true)
      .catch(() => false),
    runner(pdftoppmBin, ["-v"], { timeoutMs: 3_000, maxBufferBytes: 64 * 1024 })
      .then(() => true)
      .catch(() => false),
  ]);

  return {
    available: tessOk && popplerOk,
    tesseractAvailable: tessOk,
    popplerAvailable: popplerOk,
  };
}

/**
 * Local child-process OCR adapter backed by Tesseract (`por`/`eng`) and Poppler (`pdftotext`/`pdftoppm`).
 * Invokes binaries directly via `execFile` (`shell: false`) inside an ephemeral temp directory.
 */
export function createTesseractOcrEngine(
  options: TesseractOcrEngineOptions = {},
): TextOcrEnginePort {
  const tesseractBin = options.tesseractBin ?? "tesseract";
  const pdftotextBin = options.pdftotextBin ?? "pdftotext";
  const pdftoppmBin = options.pdftoppmBin ?? "pdftoppm";
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const pdfRenderDpi = options.pdfRenderDpi ?? 200;
  const maxOutputBufferBytes = options.maxOutputBufferBytes ?? 16 * 1024 * 1024;
  const execRunner = options.execRunner ?? defaultExecRunner;

  async function withTempWorkdir<T>(fn: (workdir: string) => Promise<T>): Promise<T> {
    const workdir = await mkdtemp(path.join(tempRoot, "papyrus-ocr-"));
    try {
      return await fn(workdir);
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    async extractPdfText({ buffer, timeoutMs }): Promise<string | null> {
      return withTempWorkdir(async (workdir) => {
        const pdfPath = path.join(workdir, "document.pdf");
        await writeFile(pdfPath, buffer);
        try {
          const res = await execRunner(pdftotextBin, ["-enc", "UTF-8", "-q", pdfPath, "-"], {
            timeoutMs,
            maxBufferBytes: maxOutputBufferBytes,
          });
          return res.stdout;
        } catch {
          return null;
        }
      });
    },

    async recognizeImageBuffer({ buffer, mimeType, languages, timeoutMs }): Promise<string> {
      const ext = IMAGE_MIME_TO_EXTENSION[mimeType.trim().toLowerCase()] ?? "img";
      const langFlag = sanitizeLanguages(languages);

      return withTempWorkdir(async (workdir) => {
        const imagePath = path.join(workdir, `input.${ext}`);
        await writeFile(imagePath, buffer);
        const res = await execRunner(
          tesseractBin,
          [imagePath, "stdout", "-l", langFlag, "--psm", "3", "--oem", "1", "quiet"],
          { timeoutMs, maxBufferBytes: maxOutputBufferBytes },
        );
        return res.stdout;
      });
    },

    async recognizePdfBuffer({ buffer, languages, maxPages, timeoutMs }): Promise<string> {
      const langFlag = sanitizeLanguages(languages);
      const safeMaxPages = Math.max(1, Math.min(maxPages, 50));
      const deadlineMs = Date.now() + timeoutMs;

      return withTempWorkdir(async (workdir) => {
        const pdfPath = path.join(workdir, "scanned.pdf");
        const pagePrefix = path.join(workdir, "page");
        await writeFile(pdfPath, buffer);

        const renderTimeout = Math.max(1_000, deadlineMs - Date.now());
        await execRunner(
          pdftoppmBin,
          [
            "-png",
            "-r",
            String(pdfRenderDpi),
            "-f",
            "1",
            "-l",
            String(safeMaxPages),
            pdfPath,
            pagePrefix,
          ],
          { timeoutMs: renderTimeout, maxBufferBytes: maxOutputBufferBytes },
        );

        const files = (await readdir(workdir))
          .filter((name) => name.startsWith("page-") && name.toLowerCase().endsWith(".png"))
          .sort((a, b) => extractTrailingPageNumber(a) - extractTrailingPageNumber(b));

        const pageTexts: string[] = [];
        for (const pageFile of files) {
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs <= 500) {
            break;
          }
          const res = await execRunner(
            tesseractBin,
            [
              path.join(workdir, pageFile),
              "stdout",
              "-l",
              langFlag,
              "--psm",
              "3",
              "--oem",
              "1",
              "quiet",
            ],
            { timeoutMs: remainingMs, maxBufferBytes: maxOutputBufferBytes },
          );
          if (res.stdout.trim().length > 0) {
            pageTexts.push(res.stdout.trim());
          }
        }

        return pageTexts.join("\n\n");
      });
    },
  };
}
