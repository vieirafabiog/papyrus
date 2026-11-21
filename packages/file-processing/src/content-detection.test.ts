import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type ContentRejectionRecord,
  DEFAULT_ALLOWED_MIME_TYPES,
  SAFE_REJECTION_MAX_LENGTH,
  detectMimeFromBytes,
  inspectFileContent,
  inspectFileContentFromStream,
} from "./index.js";

function buildMinimalZipBuffer(
  entries: readonly { name: string; content: string; declaredUncompressedSize?: number }[],
): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const dataBuf = Buffer.from(entry.content, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(dataBuf.length, 18);
    header.writeUInt32LE(entry.declaredUncompressedSize ?? dataBuf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, nameBuf, dataBuf);
  }
  return Buffer.concat(parts);
}

describe("MIME content detection, allowlist, and safe rejection", () => {
  it("detects authentic PDF, PNG, JPEG, CSV, and OOXML DOCX from real bytes and accepts matching declarations", () => {
    const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF", "utf8");
    const pdfResult = inspectFileContent(pdfBytes, {
      originalFileName: "Contrato_Fornecedor.PDF",
      declaredContentType: "application/pdf",
    });
    expect(pdfResult.accepted).toBe(true);
    if (pdfResult.accepted) {
      expect(pdfResult.detectedMime).toBe("application/pdf");
      expect(pdfResult.normalizedExtension).toBe(".pdf");
    }

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const pngResult = inspectFileContent(pngBytes, {
      originalFileName: "comprovante.png",
      declaredContentType: "image/png",
    });
    expect(pngResult.accepted).toBe(true);

    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const jpgResult = inspectFileContent(jpgBytes, {
      originalFileName: "foto.jpeg",
      declaredContentType: "image/jpg",
    });
    expect(jpgResult.accepted).toBe(true);
    if (jpgResult.accepted) {
      expect(jpgResult.detectedMime).toBe("image/jpeg");
    }

    const csvBytes = Buffer.from("fornecedor,valor\nAcme,1500.00\n", "utf8");
    const csvResult = inspectFileContent(csvBytes, {
      originalFileName: "relatorio.csv",
      declaredContentType: "text/csv; charset=utf-8",
    });
    expect(csvResult.accepted).toBe(true);
    if (csvResult.accepted) {
      expect(csvResult.detectedMime).toBe("text/csv");
    }

    const docxBytes = buildMinimalZipBuffer([
      { name: "[Content_Types].xml", content: "<Types/>" },
      { name: "word/document.xml", content: "<w:document/>" },
    ]);
    const docxResult = inspectFileContent(docxBytes, {
      originalFileName: "minuta.docx",
      declaredContentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(docxResult.accepted).toBe(true);
    if (docxResult.accepted) {
      expect(docxResult.detectedMime).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }
  });

  it("blocks disguised executables, double extensions, polyglots, HTML/SVG scripts, and mismatched MIME spoofing with safe non-leaking reasons", () => {
    // 1. Windows PE executable disguised as PDF
    const peBytes = Buffer.from("MZ\x90\x00\x03\x00\x00\x00This program cannot be run", "latin1");
    const peSpoofed = inspectFileContent(peBytes, {
      originalFileName: "fatura.pdf",
      declaredContentType: "application/pdf",
    });
    expect(peSpoofed.accepted).toBe(false);
    if (!peSpoofed.accepted) {
      expect(peSpoofed.rejection.code).toBe("DANGEROUS_CONTENT");
      expect(peSpoofed.rejection.safeMessage.length).toBeLessThanOrEqual(SAFE_REJECTION_MAX_LENGTH);
      expect(peSpoofed.rejection.safeMessage).not.toContain("MZ");
      expect(peSpoofed.rejection.safeMessage).not.toContain("fatura.pdf");
    }

    // 2. GIF + embedded %PDF polyglot
    const gifPdfPolyglot = Buffer.concat([
      Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
      Buffer.alloc(20, 0),
      Buffer.from("%PDF-1.5\n", "utf8"),
    ]);
    const polyResult = inspectFileContent(gifPdfPolyglot, {
      originalFileName: "imagem.gif",
      declaredContentType: "image/gif",
    });
    expect(polyResult.accepted).toBe(false);
    if (!polyResult.accepted) {
      expect(polyResult.rejection.code).toBe("POLYGLOT_DETECTED");
    }

    // 3. Double dangerous extension
    const textBytes = Buffer.from("conteudo normal", "utf8");
    const doubleExtResult = inspectFileContent(textBytes, {
      originalFileName: "nota.exe.pdf",
      declaredContentType: "application/pdf",
    });
    expect(doubleExtResult.accepted).toBe(false);
    if (!doubleExtResult.accepted) {
      expect(doubleExtResult.rejection.code).toBe("DANGEROUS_EXTENSION");
    }

    // 4. SVG XSS payload disguised as CSV
    const svgXss = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "utf8",
    );
    const svgResult = inspectFileContent(svgXss, {
      originalFileName: "dados.csv",
      declaredContentType: "text/csv",
    });
    expect(svgResult.accepted).toBe(false);
    if (!svgResult.accepted) {
      expect(svgResult.rejection.code).toBe("DANGEROUS_CONTENT");
      expect(svgResult.rejection.safeMessage).not.toContain("<script>");
      expect(svgResult.rejection.safeMessage).not.toContain("alert");
    }

    // 5. Real PNG uploaded with .pdf extension & application/pdf header
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const extensionMismatch = inspectFileContent(pngBytes, {
      originalFileName: "falso.pdf",
      declaredContentType: "image/png",
    });
    expect(extensionMismatch.accepted).toBe(false);
    if (!extensionMismatch.accepted) {
      expect(extensionMismatch.rejection.code).toBe("EXTENSION_MISMATCH");
    }

    const declaredMismatch = inspectFileContent(pngBytes, {
      originalFileName: "imagem.png",
      declaredContentType: "application/pdf",
    });
    expect(declaredMismatch.accepted).toBe(false);
    if (!declaredMismatch.accepted) {
      expect(declaredMismatch.rejection.code).toBe("DECLARED_TYPE_MISMATCH");
    }

    // 6. ZIP compression expansion anomaly (zip bomb indicator)
    const bombZip = buildMinimalZipBuffer([
      { name: "payload.txt", content: "AAAA", declaredUncompressedSize: 100 * 1024 * 1024 },
    ]);
    const bombResult = inspectFileContent(bombZip, {
      originalFileName: "arquivo.zip",
      declaredContentType: "application/zip",
    });
    expect(bombResult.accepted).toBe(false);
    if (!bombResult.accepted) {
      expect(bombResult.rejection.code).toBe("ARCHIVE_EXPANSION_RISK");
    }

    // 7. Path traversal in originalFileName blocked safely without echoing raw path
    const traversalResult = inspectFileContent(textBytes, {
      originalFileName: "../../etc/passwd.txt",
      declaredContentType: "text/plain",
    });
    expect(traversalResult.accepted).toBe(false);
    if (!traversalResult.accepted) {
      expect(traversalResult.rejection.code).toBe("INVALID_FILENAME");
      expect(traversalResult.rejection.safeMessage).not.toContain("passwd");
    }
  });

  it("enforces configurable MIME allowlists, rejects unrecognized/empty payloads, and records stream rejections safely without reading full large streams", async () => {
    const pdfBytes = Buffer.from("%PDF-1.7\n%ok\n", "utf8");

    // Restricted allowlist rejects PDF when only image/png is permitted
    const restricted = inspectFileContent(
      pdfBytes,
      {
        originalFileName: "doc.pdf",
        declaredContentType: "application/pdf",
      },
      {
        allowedMimeTypes: ["image/png"],
      },
    );
    expect(restricted.accepted).toBe(false);
    if (!restricted.accepted) {
      expect(restricted.rejection.code).toBe("MIME_NOT_ALLOWED");
    }

    // Custom allowlist permits application/zip explicitly when configured
    expect(DEFAULT_ALLOWED_MIME_TYPES).not.toContain("application/zip");
    const benignZip = buildMinimalZipBuffer([{ name: "leia.txt", content: "conteudo" }]);
    const customZipAllowed = inspectFileContent(
      benignZip,
      {
        originalFileName: "pacote.zip",
        declaredContentType: "application/zip",
      },
      {
        allowedMimeTypes: ["application/zip"],
      },
    );
    expect(customZipAllowed.accepted).toBe(true);

    // Unrecognized random binary bytes fail closed
    const mysteryBytes = Buffer.from([0xaa, 0xbb, 0x00, 0x11, 0x22, 0x33]);
    expect(detectMimeFromBytes(mysteryBytes)).toBeNull();
    const mysteryResult = inspectFileContent(mysteryBytes, {
      originalFileName: "desconhecido.pdf",
      declaredContentType: "application/pdf",
    });
    expect(mysteryResult.accepted).toBe(false);
    if (!mysteryResult.accepted) {
      expect(mysteryResult.rejection.code).toBe("UNRECOGNIZED_CONTENT");
    }

    // Empty file fails closed
    const emptyResult = inspectFileContent(Buffer.alloc(0), {
      originalFileName: "vazio.pdf",
      declaredContentType: "application/pdf",
    });
    expect(emptyResult.accepted).toBe(false);
    if (!emptyResult.accepted) {
      expect(emptyResult.rejection.code).toBe("EMPTY_CONTENT");
    }

    // Stream inspection samples only the header window (without consuming gigabytes) and invokes recorder
    const recorded: ContentRejectionRecord[] = [];
    let chunksPulled = 0;
    const hugeStream = new Readable({
      read() {
        chunksPulled += 1;
        if (chunksPulled === 1) {
          this.push(Buffer.from("#!/bin/sh\nrm -rf /\n", "utf8"));
          return;
        }
        this.push(Buffer.alloc(32 * 1024, 0x41));
      },
    });

    const streamResult = await inspectFileContentFromStream(
      hugeStream,
      {
        originalFileName: "falso.txt",
        declaredContentType: "text/plain",
      },
      { maxHeaderSampleBytes: 1024 },
      {
        recordRejection(record) {
          recorded.push(record);
        },
      },
    );

    expect(streamResult.accepted).toBe(false);
    expect(chunksPulled).toBeLessThan(10);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.code).toBe("DANGEROUS_CONTENT");
    expect(recorded[0]?.metadata.detectedMime).toBe("application/x-sh");
  });
});
