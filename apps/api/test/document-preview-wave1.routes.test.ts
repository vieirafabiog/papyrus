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
import { registerDocumentPreviewRoutes } from "../src/modules/documents/preview.routes.js";
import type { DocumentAuthorizationGuard } from "../src/plugins/authorization.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "550e8400-e29b-41d4-a716-446655440001";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440002";
const VER_ID = "550e8400-e29b-41d4-a716-446655440003";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440004";
const STORAGE_ID = "550e8400-e29b-41d4-a716-446655440005";

async function createTestApp(fileObject: FileObjectEntity, payload: Buffer, maxTextBytes?: number) {
  const app = Fastify({ logger: false });

  const doc: DocumentEntity = {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Wave 1 File",
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
      subject: {
        userId: USER_ID,
        organizationId: ORG_ID,
        groupIds: [],
      },
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
    findFileObjectById: vi.fn(async () => fileObject),
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
      key: { value: fileObject.objectKey },
      metadata: {
        contentType: fileObject.detectedContentType,
        contentLength: payload.length,
        checksumSha256: fileObject.checksumSha256,
      },
    })),
    getObject: vi.fn(async () => ({
      body: Readable.from(payload),
      metadata: {
        contentType: fileObject.detectedContentType,
        contentLength: payload.length,
        checksumSha256: fileObject.checksumSha256,
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
    maxTextPreviewBytes: maxTextBytes,
  });

  await app.ready();
  return app;
}

function makeFileObject(overrides: Partial<FileObjectEntity>): FileObjectEntity {
  return {
    id: FILE_ID,
    organizationId: ORG_ID,
    storageConnectionId: STORAGE_ID,
    objectKey: `org/${ORG_ID}/documents/${DOC_ID}/versions/${VER_ID}/${FILE_ID}`,
    originalFileName: "sample.txt",
    detectedContentType: "text/plain",
    sizeBytes: 64,
    checksumSha256: "a".repeat(64),
    status: "AVAILABLE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("GET /api/v1/documents/:id/content — Wave 1 formats", () => {
  it("streams BMP images with restrictive image CSP and no-store cache", async () => {
    const bmpBytes = Buffer.from([0x42, 0x4d, 0x1e, 0x00, 0x00, 0x00]);
    const app = await createTestApp(
      makeFileObject({
        originalFileName: "blueprint.bmp",
        detectedContentType: "image/bmp",
        sizeBytes: bmpBytes.length,
      }),
      bmpBytes,
    );

    const res = await app.inject({ method: "GET", url: `/api/v1/documents/${DOC_ID}/content` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/bmp");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.rawPayload.equals(bmpBytes)).toBe(true);
    await app.close();
  });

  it.each([
    { mime: "text/csv", name: "report.csv", body: "a,b\n1,2\n" },
    { mime: "application/json", name: "data.json", body: '{"ok":true}' },
    { mime: "text/plain", name: "notes.txt", body: "hello world" },
    { mime: "text/plain", name: "readme.md", body: "# Title\n" },
    { mime: "text/markdown", name: "guide.md", body: "## Guide\n" },
  ])(
    "streams $mime ($name) with UTF-8 charset and strict frame-ancestors none CSP",
    async ({ mime, name, body }) => {
      const buf = Buffer.from(body, "utf8");
      const app = await createTestApp(
        makeFileObject({
          originalFileName: name,
          detectedContentType: mime,
          sizeBytes: buf.length,
        }),
        buf,
      );

      const res = await app.inject({ method: "GET", url: `/api/v1/documents/${DOC_ID}/content` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe(`${mime}; charset=utf-8`);
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.body).toBe(body);
      await app.close();
    },
  );

  it("rejects oversized text/CSV/JSON files with 413 UPLOAD_TOO_LARGE", async () => {
    const app = await createTestApp(
      makeFileObject({
        originalFileName: "huge.csv",
        detectedContentType: "text/csv",
        sizeBytes: 2048,
      }),
      Buffer.from("a,b\n", "utf8"),
      1024,
    );

    const res = await app.inject({ method: "GET", url: `/api/v1/documents/${DOC_ID}/content` });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("UPLOAD_TOO_LARGE");
    await app.close();
  });

  it("keeps blocking active formats like text/html and image/svg+xml with 415", async () => {
    for (const dangerousMime of ["text/html", "image/svg+xml"]) {
      const app = await createTestApp(
        makeFileObject({
          originalFileName: "unsafe.file",
          detectedContentType: dangerousMime,
          sizeBytes: 32,
        }),
        Buffer.from("<svg/>", "utf8"),
      );
      const res = await app.inject({ method: "GET", url: `/api/v1/documents/${DOC_ID}/content` });
      expect(res.statusCode).toBe(415);
      await app.close();
    }
  });
});
