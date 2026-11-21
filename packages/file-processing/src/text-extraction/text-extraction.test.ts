import { Readable } from "node:stream";
import { deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type PostgresSqlExecutor,
  createExtractedTextIndexRepository,
  createTextExtractionPolicy,
  evaluateAndNormalizeExtractedText,
  extractAndIndexDocumentVersionText,
  extractTextFromBuffer,
  extractTextFromStream,
} from "./index.js";

function buildSingleEntryZip(
  entryName: string,
  content: Buffer,
  options: { readonly method?: 0 | 8; readonly spoofedUncompressedSize?: number } = {},
): Buffer {
  const method = options.method ?? 8;
  const compressed = method === 0 ? content : deflateRawSync(content);
  const nameBuf = Buffer.from(entryName, "utf8");
  const header = Buffer.alloc(30 + nameBuf.length);

  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(options.spoofedUncompressedSize ?? content.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  nameBuf.copy(header, 30);

  return Buffer.concat([header, compressed]);
}

describe("Optional extracted text extraction, quality gates, limits and PostgreSQL indexing", () => {
  it("short-circuits safely when text extraction feature is disabled", async () => {
    const executedQueries: string[] = [];
    const executor: PostgresSqlExecutor = {
      async query<T extends Record<string, unknown>>(sql: string) {
        executedQueries.push(sql);
        return { rows: [] as readonly T[] };
      },
    };

    const disabledPolicy = createTextExtractionPolicy({ enabled: false });
    const repo = createExtractedTextIndexRepository({ executor, policy: disabledPolicy });

    const bufferOutcome = await extractTextFromBuffer(
      { content: Buffer.from("Contrato confidencial 2026", "utf8"), mimeType: "text/plain" },
      disabledPolicy,
    );
    expect(bufferOutcome.status).toBe("DISABLED");

    const streamOutcome = await extractTextFromStream(
      { stream: Readable.from(Buffer.from("Conteúdo em stream", "utf8")), mimeType: "text/plain" },
      disabledPolicy,
    );
    expect(streamOutcome.status).toBe("DISABLED");

    const orchestration = await extractAndIndexDocumentVersionText({
      source: {
        kind: "buffer",
        content: Buffer.from("Contrato de Locação", "utf8"),
        mimeType: "text/plain",
      },
      organizationId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222",
      documentVersionId: "33333333-3333-4333-8333-333333333333",
      fileObjectId: "44444444-4444-4444-8444-444444444444",
      policy: disabledPolicy,
      indexRepository: repo,
    });

    expect(orchestration.extraction.status).toBe("DISABLED");
    expect(orchestration.indexing).toEqual({ indexed: false, reason: "DISABLED" });

    const searchRes = await repo.search({
      organizationId: "11111111-1111-4111-8111-111111111111",
      query: "locação",
    });
    expect(searchRes).toEqual({ enabled: false, matches: [] });
    expect(executedQueries).toHaveLength(0);
  });

  it("enforces maxInputBytes, maxExtractedChars truncation, unsupported MIME and low-quality filtering", async () => {
    const policy = createTextExtractionPolicy({
      enabled: true,
      maxInputBytes: 120,
      maxExtractedChars: 40,
      minPrintableRatio: 0.75,
    });

    // Oversized stream rejected without reading unbounded content
    const largeRes = await extractTextFromStream(
      { stream: Readable.from(Buffer.alloc(300, 0x41)), mimeType: "text/plain" },
      policy,
    );
    expect(largeRes.status).toBe("SKIPPED_TOO_LARGE");

    // Truncation and NUL byte removal
    const rawText =
      "Contrato\0   com múltiplos\n\n\n\nespaços e texto longo para truncar no limite";
    const plainRes = await extractTextFromBuffer(
      { content: Buffer.from(rawText, "utf8"), mimeType: "text/plain" },
      policy,
    );
    expect(plainRes.status).toBe("EXTRACTED");
    if (plainRes.status === "EXTRACTED") {
      expect(plainRes.text.length).toBeLessThanOrEqual(40);
      expect(plainRes.truncated).toBe(true);
      expect(plainRes.text).not.toContain("\0");
    }

    // Binary noise / replacement char garbage fails printable ratio quality gate
    const noisyBuffer = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x41, 0x42, 0x07, 0x08, 0x0b]);
    const qualityRes = evaluateAndNormalizeExtractedText(noisyBuffer.toString("utf8"), policy);
    expect(qualityRes.accepted).toBe(false);

    // Unsupported MIME rejected safely
    const imageRes = await extractTextFromBuffer(
      { content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" },
      policy,
    );
    expect(imageRes).toEqual({ status: "UNSUPPORTED_MIME", mimeType: "image/png" });
  });

  it("extracts text cleanly from PDF (literal and FlateDecode streams) and DOCX XML while rejecting zip-bomb ratios", async () => {
    const policy = createTextExtractionPolicy({
      enabled: true,
      maxCompressionRatio: 10,
      maxZipEntryBytes: 16_384,
    });

    // 1. PDF with FlateDecode stream
    const compressedPdfBody = deflateSync(
      Buffer.from(
        "BT (Contrato Fornecedor Alpha 2026) Tj [(Clausula ) (Vigencia)] TJ ET",
        "latin1",
      ),
    );
    const pdfPayload = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
      compressedPdfBody,
      Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
    ]);

    const pdfOutcome = await extractTextFromBuffer(
      { content: pdfPayload, mimeType: "application/pdf" },
      policy,
    );
    expect(pdfOutcome.status).toBe("EXTRACTED");
    if (pdfOutcome.status === "EXTRACTED") {
      expect(pdfOutcome.extractorKind).toBe("pdf_basic");
      expect(pdfOutcome.text).toContain("Contrato Fornecedor Alpha 2026");
      expect(pdfOutcome.text).toContain("Clausula Vigencia");
    }

    // 2. Scanned image-only PDF without extractable text fails quality gate cleanly
    const scannedPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<<>>\nstream\n\x00\x01\x02\nendstream\n%%EOF",
      "latin1",
    );
    const scannedOutcome = await extractTextFromBuffer(
      { content: scannedPdf, mimeType: "application/pdf" },
      policy,
    );
    expect(scannedOutcome.status).toBe("LOW_QUALITY");

    // 3. Valid DOCX XML (deflated)
    const docxXml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document><w:body><w:p><w:r><w:t>Acordo Comercial &amp; Termo</w:t></w:r></w:p><w:p><w:r><w:t>Valor aprovado em 2026</w:t></w:r></w:p></w:body></w:document>`,
      "utf8",
    );
    const docxBuffer = buildSingleEntryZip("word/document.xml", docxXml, { method: 8 });
    const docxOutcome = await extractTextFromBuffer(
      {
        content: docxBuffer,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      policy,
    );
    expect(docxOutcome.status).toBe("EXTRACTED");
    if (docxOutcome.status === "EXTRACTED") {
      expect(docxOutcome.extractorKind).toBe("docx_xml");
      expect(docxOutcome.text).toContain("Acordo Comercial & Termo");
      expect(docxOutcome.text).toContain("Valor aprovado em 2026");
    }

    // 4. Zip bomb / excessive ratio in DOCX entry rejected
    const zipBombDocx = buildSingleEntryZip("word/document.xml", docxXml, {
      method: 8,
      spoofedUncompressedSize: 500_000,
    });
    const bombOutcome = await extractTextFromBuffer(
      {
        content: zipBombDocx,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      policy,
    );
    expect(bombOutcome.status).toBe("FAILED");
  });

  it("saves extracted text separately and executes parameterized PostgreSQL full-text search queries", async () => {
    const calls: { readonly sql: string; readonly params: readonly unknown[] | undefined }[] = [];
    const docId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const verId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const orgId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const executor: PostgresSqlExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        if (sql.includes("websearch_to_tsquery")) {
          const hit = {
            documentId: docId,
            documentVersionId: verId,
            rank: 0.75,
            snippet: "Contrato de prestação de serviços",
          };
          return { rows: [hit as unknown as T] };
        }
        return { rows: [{ documentVersionId: verId } as unknown as T] };
      },
    };

    const policy = createTextExtractionPolicy({ enabled: true, postgresFtsConfig: "portuguese" });
    const indexRepository = createExtractedTextIndexRepository({ executor, policy });

    const res = await extractAndIndexDocumentVersionText({
      source: {
        kind: "stream",
        stream: Readable.from(Buffer.from("Contrato de prestação de serviços jurídicos.", "utf8")),
        mimeType: "text/csv",
      },
      organizationId: orgId,
      documentId: docId,
      documentVersionId: verId,
      fileObjectId: fileId,
      policy,
      indexRepository,
    });

    expect(res.extraction.status).toBe("EXTRACTED");
    expect(res.indexing).toEqual({
      indexed: true,
      documentVersionId: verId,
      charCount: "Contrato de prestação de serviços jurídicos.".length,
    });
    expect(calls[0]?.sql).toContain("INSERT INTO document_extracted_texts");
    expect(calls[0]?.sql).toContain("to_tsvector($6::regconfig, $9::text)");
    expect(calls[0]?.params?.[5]).toBe("portuguese");

    const searchResult = await indexRepository.search({
      organizationId: orgId,
      query: "serviços jurídicos",
    });
    expect(searchResult.enabled).toBe(true);
    expect(searchResult.matches).toHaveLength(1);
    expect(searchResult.matches[0]?.documentId).toBe(docId);
    expect(calls[1]?.sql).toContain("websearch_to_tsquery($2::regconfig, $3::text)");
  });
});
