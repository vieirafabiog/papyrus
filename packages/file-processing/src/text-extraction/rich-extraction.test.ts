import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  type PostgresSqlExecutor,
  type TextOcrEnginePort,
  checkOcrToolchainAvailability,
  createExtractedTextIndexRepository,
  createFullContentExtractionPolicy,
  createTesseractOcrEngine,
  extractAndIndexDocumentVersionText,
  extractTextFromBuffer,
} from "./index.js";

function buildMultiEntryZip(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly content: Buffer;
    readonly spoofedUncompressedSize?: number;
  }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.content);
    const nameBuf = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30 + nameBuf.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.spoofedUncompressedSize ?? entry.content.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    nameBuf.copy(header, 30);
    parts.push(header, compressed);
  }
  return Buffer.concat(parts);
}

describe("Rich content extraction & OCR engine", () => {
  it("extracts readable text from XLSX spreadsheets, PPTX slides, Markdown, and JSON", async () => {
    const policy = createFullContentExtractionPolicy({
      ocr: { enabled: false },
    });

    // 1. XLSX (sharedStrings + sheet1)
    const sharedStringsXml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><sst><si><t>Cliente</t></si><si><t>ACME Engenharia</t></si><si><t>Valor Anual</t></si></sst>`,
      "utf8",
    );
    const sheet1Xml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>45000</v></c><c r="C2" t="inlineStr"><is><t>Aprovado</t></is></c></row></sheetData></worksheet>`,
      "utf8",
    );
    const xlsxBuffer = buildMultiEntryZip([
      { name: "xl/sharedStrings.xml", content: sharedStringsXml },
      { name: "xl/worksheets/sheet1.xml", content: sheet1Xml },
    ]);

    const xlsxOutcome = await extractTextFromBuffer(
      {
        content: xlsxBuffer,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      policy,
    );
    expect(xlsxOutcome.status).toBe("EXTRACTED");
    if (xlsxOutcome.status === "EXTRACTED") {
      expect(xlsxOutcome.extractorKind).toBe("xlsx_xml");
      expect(xlsxOutcome.text).toContain("Cliente Valor Anual");
      expect(xlsxOutcome.text).toContain("ACME Engenharia 45000 Aprovado");
    }

    // 2. PPTX (ordered slides + notes)
    const slide2Xml = Buffer.from(
      `<?xml version="1.0"?><p:sld><a:p><a:r><a:t>Slide Dois Metas</a:t></a:r></a:p></p:sld>`,
      "utf8",
    );
    const slide1Xml = Buffer.from(
      `<?xml version="1.0"?><p:sld><a:p><a:r><a:t>Slide Um Capa 2026</a:t></a:r></a:p></p:sld>`,
      "utf8",
    );
    const notes1Xml = Buffer.from(
      `<?xml version="1.0"?><p:notes><a:p><a:r><a:t>Nota do apresentador</a:t></a:r></a:p></p:notes>`,
      "utf8",
    );
    const pptxBuffer = buildMultiEntryZip([
      { name: "ppt/slides/slide2.xml", content: slide2Xml },
      { name: "ppt/slides/slide1.xml", content: slide1Xml },
      { name: "ppt/notesSlides/notesSlide1.xml", content: notes1Xml },
    ]);

    const pptxOutcome = await extractTextFromBuffer(
      {
        content: pptxBuffer,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
      policy,
    );
    expect(pptxOutcome.status).toBe("EXTRACTED");
    if (pptxOutcome.status === "EXTRACTED") {
      expect(pptxOutcome.extractorKind).toBe("pptx_xml");
      expect(pptxOutcome.text.indexOf("Slide Um Capa 2026")).toBeLessThan(
        pptxOutcome.text.indexOf("Slide Dois Metas"),
      );
      expect(pptxOutcome.text).toContain("Nota do apresentador");
    }

    // 3. Markdown & JSON
    const mdOutcome = await extractTextFromBuffer(
      {
        content: Buffer.from(
          "# Política de Retenção\n\n* Prazo: **5 anos**\n[Guia](/docs)",
          "utf8",
        ),
        mimeType: "text/markdown",
      },
      policy,
    );
    expect(mdOutcome.status).toBe("EXTRACTED");
    if (mdOutcome.status === "EXTRACTED") {
      expect(mdOutcome.extractorKind).toBe("structured_text");
      expect(mdOutcome.text).toContain("Política de Retenção");
      expect(mdOutcome.text).toContain("Prazo: 5 anos");
    }

    const jsonOutcome = await extractTextFromBuffer(
      {
        content: Buffer.from(
          JSON.stringify({ contrato: "C-900", partes: ["Papyrus", "Cliente"] }),
          "utf8",
        ),
        mimeType: "application/json",
      },
      policy,
    );
    expect(jsonOutcome.status).toBe("EXTRACTED");
    if (jsonOutcome.status === "EXTRACTED") {
      expect(jsonOutcome.extractorKind).toBe("structured_text");
      expect(jsonOutcome.text).toContain("contrato: C-900");
      expect(jsonOutcome.text).toContain("partes: Cliente");
    }
  });

  it("extracts text from images via OCR and falls back to PDF OCR for scanned PDFs", async () => {
    const policy = createFullContentExtractionPolicy({
      ocr: {
        enabled: true,
        languages: ["por", "eng"],
        minNativePdfCharsForSkipOcr: 30,
      },
    });

    const recognizeImageSpy = vi.fn(
      async () => "Nota Fiscal Eletrônica nº 481516 - CNPJ 12.345.678/0001-90",
    );
    const recognizePdfSpy = vi.fn(
      async () => "Termo Aditivo Digitalizado Assinado em Novembro de 2026.",
    );
    const extractPdfTextSpy = vi.fn(async () => "");

    const ocrEngine: TextOcrEnginePort = {
      extractPdfText: extractPdfTextSpy,
      recognizeImageBuffer: recognizeImageSpy,
      recognizePdfBuffer: recognizePdfSpy,
    };

    // Image OCR
    const imgOutcome = await extractTextFromBuffer(
      { content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), mimeType: "image/png" },
      policy,
      { ocrEngine },
    );
    expect(imgOutcome.status).toBe("EXTRACTED");
    if (imgOutcome.status === "EXTRACTED") {
      expect(imgOutcome.extractorKind).toBe("ocr_image");
      expect(imgOutcome.text).toContain("Nota Fiscal Eletrônica nº 481516");
    }

    // Scanned PDF falls back to OCR
    const scannedPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<<>>\nstream\n\x00\x01\nendstream\n%%EOF",
      "latin1",
    );
    const pdfOcrOutcome = await extractTextFromBuffer(
      { content: scannedPdf, mimeType: "application/pdf" },
      policy,
      { ocrEngine },
    );
    expect(pdfOcrOutcome.status).toBe("EXTRACTED");
    if (pdfOcrOutcome.status === "EXTRACTED") {
      expect(pdfOcrOutcome.extractorKind).toBe("ocr_pdf");
      expect(pdfOcrOutcome.text).toContain("Termo Aditivo Digitalizado");
    }
    expect(recognizePdfSpy).toHaveBeenCalledTimes(1);

    // Native PDF skips OCR when Poppler text is sufficient
    extractPdfTextSpy.mockResolvedValueOnce(
      "Contrato Corporativo de Licença Anual assinado com cláusula de renovação automática.",
    );
    const nativeOutcome = await extractTextFromBuffer(
      { content: scannedPdf, mimeType: "application/pdf" },
      policy,
      { ocrEngine },
    );
    expect(nativeOutcome.status).toBe("EXTRACTED");
    if (nativeOutcome.status === "EXTRACTED") {
      expect(nativeOutcome.extractorKind).toBe("pdf_poppler");
    }
    expect(recognizePdfSpy).toHaveBeenCalledTimes(1);

    // Missing OCR engine reports OCR_UNAVAILABLE cleanly
    const unavailableOutcome = await extractTextFromBuffer(
      { content: Buffer.from([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" },
      policy,
    );
    expect(unavailableOutcome.status).toBe("OCR_UNAVAILABLE");
  });

  it("orchestrates stream extraction + PostgreSQL indexing with OCR engine", async () => {
    const queries: unknown[][] = [];
    const executor: PostgresSqlExecutor = {
      async query<T extends Record<string, unknown>>(_sql: string, params?: readonly unknown[]) {
        queries.push([...(params ?? [])]);
        return { rows: [{ documentVersionId: "v1" } as unknown as T] };
      },
    };
    const policy = createFullContentExtractionPolicy();
    const indexRepository = createExtractedTextIndexRepository({ executor, policy });

    const ocrEngine: TextOcrEnginePort = {
      recognizeImageBuffer: async () => "Recibo de Pagamento Pix R$ 1.250,00 referente a Outubro",
      recognizePdfBuffer: async () => "",
    };

    const result = await extractAndIndexDocumentVersionText({
      source: {
        kind: "stream",
        stream: Readable.from(Buffer.from([0x49, 0x49, 0x2a, 0x00])),
        mimeType: "image/tiff",
      },
      organizationId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222",
      documentVersionId: "33333333-3333-4333-8333-333333333333",
      fileObjectId: "44444444-4444-4444-8444-444444444444",
      policy,
      indexRepository,
      ocrEngine,
    });

    expect(result.extraction.status).toBe("EXTRACTED");
    expect(result.indexing).toMatchObject({ indexed: true });
    expect(queries[0]?.[4]).toBe("ocr_image");
  });

  it("invokes tesseract and pdftoppm safely with temp cleanup and checks availability", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];

    const engine = createTesseractOcrEngine({
      execRunner: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "pdftoppm") {
          const prefixArg = args[args.length - 1] ?? "";
          const dir = path.dirname(prefixArg);
          await writeFile(path.join(dir, "page-10.png"), Buffer.from("png10"));
          await writeFile(path.join(dir, "page-2.png"), Buffer.from("png2"));
          await writeFile(path.join(dir, "page-1.png"), Buffer.from("png1"));
          return { stdout: "", stderr: "" };
        }
        if (cmd === "tesseract") {
          const inputArg = args[0] ?? "";
          if (inputArg.endsWith("page-1.png")) return { stdout: "Página Um", stderr: "" };
          if (inputArg.endsWith("page-2.png")) return { stdout: "Página Dois", stderr: "" };
          if (inputArg.endsWith("page-10.png")) return { stdout: "Página Dez", stderr: "" };
          return { stdout: "Texto da Imagem", stderr: "" };
        }
        return { stdout: "Texto Nativo", stderr: "" };
      },
    });

    const imgText = await engine.recognizeImageBuffer({
      buffer: Buffer.from("fake-png"),
      mimeType: "image/png",
      languages: ["por", "eng", "rm -rf /"],
      timeoutMs: 5_000,
    });
    expect(imgText).toBe("Texto da Imagem");
    expect(calls[0]?.cmd).toBe("tesseract");
    expect(calls[0]?.args).toContain("por+eng");

    const pdfText = await engine.recognizePdfBuffer({
      buffer: Buffer.from("fake-pdf"),
      languages: ["por"],
      maxPages: 15,
      timeoutMs: 10_000,
    });
    expect(pdfText).toBe("Página Um\n\nPágina Dois\n\nPágina Dez");

    const health = await checkOcrToolchainAvailability({
      execRunner: async (cmd) => {
        if (cmd === "tesseract") return { stdout: "tesseract 5.4", stderr: "" };
        return { stdout: "pdftoppm version 24.02", stderr: "" };
      },
    });
    expect(health).toEqual({
      available: true,
      tesseractAvailable: true,
      popplerAvailable: true,
    });
  });
});
