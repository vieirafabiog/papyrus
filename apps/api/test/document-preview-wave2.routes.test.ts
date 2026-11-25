import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  AuditRepositoryPort,
  DocumentEntity,
  DocumentVersionRepositoryPort,
  FileObjectEntity,
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
  UploadSessionRepositoryPort,
} from "@papyrus/domain";
import { type StorageProvider, createStorageProviderRegistry } from "@papyrus/storage-core";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  type OfficePreviewConverterPort,
  createGotenbergOfficeConverter,
} from "../src/modules/documents/office-preview-converter.js";
import { registerDocumentPreviewRoutes } from "../src/modules/documents/preview.routes.js";
import type { DocumentAuthorizationGuard } from "../src/plugins/authorization.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "550e8400-e29b-41d4-a716-446655440001";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440002";
const VER_ID = "550e8400-e29b-41d4-a716-446655440003";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440004";
const STORAGE_ID = "550e8400-e29b-41d4-a716-446655440005";

async function createWave2TestApp(options: {
  readonly fileObject: FileObjectEntity;
  readonly payload: Buffer;
  readonly officePreviewConverter?: OfficePreviewConverterPort | undefined;
  readonly maxOfficePreviewBytes?: number | undefined;
  readonly maxSpreadsheetPreviewBytes?: number | undefined;
}) {
  const app = Fastify({ logger: false });
  const doc: DocumentEntity = {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Wave 2 Document",
    categoryId: "550e8400-e29b-41d4-a716-446655440009",
    folderId: null,
    status: "APPROVED",
    currentVersionId: VER_ID,
    ownerUserId: USER_ID,
    issueDate: null,
    expirationDate: null,
    metadata: {},
    version: 1,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const guard = {
    requireSubject: vi.fn(async () => ({
      me: {
        user: {
          id: USER_ID,
          organizationId: ORG_ID,
          email: "reader@papyrus.local",
          fullName: "Reader",
          status: "ACTIVE",
        },
        groups: [],
        roles: [],
        permissions: [],
      },
      subject: { userId: USER_ID, organizationId: ORG_ID, groupIds: [] },
    })),
    authorizeDocument: vi.fn(async () => doc),
  } as unknown as DocumentAuthorizationGuard;

  const documentVersionRepository = {
    findById: vi.fn(async () => ({
      id: VER_ID,
      documentId: DOC_ID,
      versionNumber: 1,
      fileObjectId: FILE_ID,
      uploadedByUserId: USER_ID,
      changeNote: null,
      createdAt: "2026-01-01T00:00:00Z",
    })),
  } as unknown as DocumentVersionRepositoryPort;

  const uploadRepository = {
    findFileObjectOrganizationId: vi.fn(async () => ORG_ID),
    findFileObjectById: vi.fn(async () => options.fileObject),
  } as unknown as UploadSessionRepositoryPort;

  const connection: StorageConnectionEntity = {
    id: STORAGE_ID,
    organizationId: ORG_ID,
    name: "Local",
    kind: "local",
    status: "ACTIVE",
    isDefault: true,
    nonSecretConfig: {},
    encryptedSecretRef: null,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestMessage: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const storageConnections = {
    findById: vi.fn(async () => connection),
  } as unknown as StorageConnectionRepositoryPort;

  const provider: StorageProvider = {
    kind: "local",
    capabilities: {
      streamingUpload: true,
      streamingDownload: true,
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideEncryption: false,
      versioning: false,
      healthCheck: true,
    },
    checkHealth: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    putObject: vi.fn(async () => ({
      key: { value: options.fileObject.objectKey },
      metadata: {
        contentType: options.fileObject.detectedContentType,
        contentLength: options.payload.length,
        checksumSha256: options.fileObject.checksumSha256,
      },
    })),
    getObject: vi.fn(async () => ({
      body: Readable.from(options.payload),
      metadata: {
        contentType: options.fileObject.detectedContentType,
        contentLength: options.payload.length,
        checksumSha256: options.fileObject.checksumSha256,
      },
    })),
    headObject: vi.fn(async () => null),
    deleteObject: vi.fn(async () => undefined),
  };

  const storageRegistry = createStorageProviderRegistry();
  storageRegistry.registerFactory("local", async () => provider);

  const auditRepository = {
    append: vi.fn(async () => undefined),
  } as unknown as AuditRepositoryPort;

  await registerDocumentPreviewRoutes(app, {
    guard,
    documentVersionRepository,
    uploadRepository,
    storageConnections,
    storageRegistry,
    auditRepository,
    officePreviewConverter: options.officePreviewConverter,
    maxOfficePreviewBytes: options.maxOfficePreviewBytes,
    maxSpreadsheetPreviewBytes: options.maxSpreadsheetPreviewBytes,
  });

  await app.ready();
  return { app, auditRepository };
}

function makeFileObject(overrides: Partial<FileObjectEntity>): FileObjectEntity {
  return {
    id: FILE_ID,
    organizationId: ORG_ID,
    storageConnectionId: STORAGE_ID,
    objectKey: `org/${ORG_ID}/documents/${DOC_ID}/versions/${VER_ID}/${FILE_ID}`,
    originalFileName: "contract.docx",
    detectedContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 128,
    checksumSha256: "c".repeat(64),
    status: "AVAILABLE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("Wave 2 document previews (Word/PowerPoint -> PDF, Excel .xlsx, TIFF)", () => {
  it("converts Word (.docx) and PowerPoint (.pptx) to read-only PDF via /preview", async () => {
    const fakePdf = Buffer.from("%PDF-1.7\n%converted\n%%EOF\n", "ascii");
    const converter: OfficePreviewConverterPort = {
      convertToPdf: vi.fn(async () => fakePdf),
    };

    for (const entry of [
      {
        name: "proposal.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        name: "deck.pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
    ]) {
      const { app, auditRepository } = await createWave2TestApp({
        fileObject: makeFileObject({
          originalFileName: entry.name,
          detectedContentType: entry.mime,
        }),
        payload: Buffer.from("PK\x03\x04dummy-office", "binary"),
        officePreviewConverter: converter,
      });

      const res = await app.inject({ method: "GET", url: `/api/v1/documents/${DOC_ID}/preview` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.rawPayload.equals(fakePdf)).toBe(true);
      expect(auditRepository.append).toHaveBeenCalled();
      await app.close();
    }
  });

  it("returns 503 PREVIEW_CONVERTER_UNAVAILABLE when Office converter is disabled", async () => {
    const { app } = await createWave2TestApp({
      fileObject: makeFileObject({
        originalFileName: "memo.docx",
        detectedContentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      payload: Buffer.from("PK\x03\x04memo", "binary"),
    });

    const res = await app.inject({ method: "GET", url: `/api/v1/documents/${DOC_ID}/preview` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("PREVIEW_CONVERTER_UNAVAILABLE");
    await app.close();
  });

  it("streams Excel (.xlsx) and TIFF (.tiff) safely via /content with size limits", async () => {
    const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const xlsxPayload = Buffer.from("PK\x03\x04xlsx", "binary");

    const { app: xlsxApp } = await createWave2TestApp({
      fileObject: makeFileObject({
        originalFileName: "budget.xlsx",
        detectedContentType: xlsxMime,
        sizeBytes: xlsxPayload.length,
      }),
      payload: xlsxPayload,
    });
    const xlsxRes = await xlsxApp.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC_ID}/content`,
    });
    expect(xlsxRes.statusCode).toBe(200);
    expect(xlsxRes.headers["content-type"]).toBe(xlsxMime);
    expect(xlsxRes.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(xlsxRes.headers["x-frame-options"]).toBe("DENY");
    await xlsxApp.close();

    const { app: oversizedXlsxApp } = await createWave2TestApp({
      fileObject: makeFileObject({
        originalFileName: "huge.xlsx",
        detectedContentType: xlsxMime,
        sizeBytes: 2048,
      }),
      payload: xlsxPayload,
      maxSpreadsheetPreviewBytes: 1024,
    });
    const overRes = await oversizedXlsxApp.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC_ID}/content`,
    });
    expect(overRes.statusCode).toBe(413);
    await oversizedXlsxApp.close();

    const tiffPayload = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const { app: tiffApp } = await createWave2TestApp({
      fileObject: makeFileObject({
        originalFileName: "scan.tiff",
        detectedContentType: "image/tiff",
        sizeBytes: tiffPayload.length,
      }),
      payload: tiffPayload,
    });
    const tiffRes = await tiffApp.inject({
      method: "GET",
      url: `/api/v1/documents/${DOC_ID}/content`,
    });
    expect(tiffRes.statusCode).toBe(200);
    expect(tiffRes.headers["content-type"]).toBe("image/tiff");
    await tiffApp.close();
  });

  it("caches Gotenberg PDF conversions by SHA-256 and uses opaque filenames", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "papyrus-office-cache-test-"));
    try {
      const pdfBytes = Buffer.from("%PDF-1.4\n%ok\n%%EOF", "ascii");
      const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe("http://gotenberg.local:3000/forms/libreoffice/convert");
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(pdfBytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      });

      const converter = createGotenbergOfficeConverter({
        baseUrl: "http://gotenberg.local:3000",
        cacheDir,
        fetchFn: fetchMock,
      });

      const input = {
        buffer: Buffer.from("PK\x03\x04docx-payload", "binary"),
        originalFileName: "Confidential Employee Salary.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        checksumSha256: "d".repeat(64),
      };

      const first = await converter.convertToPdf(input);
      expect(first.equals(pdfBytes)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call hits SHA-256 cache without calling Gotenberg again
      const second = await converter.convertToPdf(input);
      expect(second.equals(pdfBytes)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
