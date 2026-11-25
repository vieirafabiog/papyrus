import { Readable } from "node:stream";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import {
  type ArchiveDocumentService,
  type AuditEventInput,
  type AuditRepositoryPort,
  type DocumentEntity,
  type DocumentVersionRepositoryPort,
  DomainError,
  type FileObjectEntity,
  type MoveDocumentService,
  type StorageConnectionEntity,
  type StorageConnectionRepositoryPort,
  type TagService,
  type TrashDocumentService,
  type UploadSessionRepositoryPort,
} from "@papyrus/domain";
import { type StorageProvider, createStorageProviderRegistry } from "@papyrus/storage-core";
import Fastify from "fastify";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { registerDocumentBulkActionRoutes } from "../src/modules/documents/bulk-actions.routes.js";
import type { DocumentAuthorizationGuard } from "../src/plugins/authorization.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440009";
const FOLDER_A = "550e8400-e29b-41d4-a716-446655440010";
const FOLDER_B = "550e8400-e29b-41d4-a716-446655440011";
const TAG_ID = "550e8400-e29b-41d4-a716-446655440012";
const STORAGE_ID = "550e8400-e29b-41d4-a716-446655440013";

const DOC_1_ID = "550e8400-e29b-41d4-a716-446655440101";
const DOC_2_ID = "550e8400-e29b-41d4-a716-446655440102";
const DOC_3_ID = "550e8400-e29b-41d4-a716-446655440103";

const VER_1_ID = "550e8400-e29b-41d4-a716-446655440201";
const VER_2_ID = "550e8400-e29b-41d4-a716-446655440202";
const VER_3_ID = "550e8400-e29b-41d4-a716-446655440203";

const FILE_1_ID = "550e8400-e29b-41d4-a716-446655440301";
const FILE_2_ID = "550e8400-e29b-41d4-a716-446655440302";
const FILE_3_ID = "550e8400-e29b-41d4-a716-446655440303";

function makeDocument(overrides: Partial<DocumentEntity> & { id: string }): DocumentEntity {
  return {
    organizationId: ORG_ID,
    title: "Documento Teste",
    categoryId: CAT_ID,
    folderId: FOLDER_A,
    status: "APPROVED",
    currentVersionId: null,
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
    ...overrides,
  };
}

function makeFileObject(overrides: Partial<FileObjectEntity> & { id: string }): FileObjectEntity {
  return {
    storageConnectionId: STORAGE_ID,
    objectKey: `org/${ORG_ID}/documents/d/versions/v/${overrides.id}`,
    originalFileName: "contrato.pdf",
    declaredMimeType: "application/pdf",
    detectedMimeType: "application/pdf",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    status: "AVAILABLE",
    avScanResult: "CLEAN",
    avScannedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

interface TestHarnessOptions {
  readonly docs?: Record<string, DocumentEntity>;
  readonly forbiddenDocIds?: ReadonlySet<string>;
  readonly inspectCreateScopeFn?: (folderId: string | null) => Promise<boolean>;
  readonly files?: Record<
    string,
    { file: FileObjectEntity; content: Buffer; versionId: string; documentId: string }
  >;
  readonly maxBulkZipTotalBytes?: number;
}

async function createBulkTestHarness(options: TestHarnessOptions = {}) {
  const app = Fastify({ logger: false });
  const docs = options.docs ?? {
    [DOC_1_ID]: makeDocument({ id: DOC_1_ID, title: "Doc 1", folderId: FOLDER_A }),
    [DOC_2_ID]: makeDocument({ id: DOC_2_ID, title: "Doc 2", folderId: FOLDER_B }),
  };

  const auditedEvents: AuditEventInput[] = [];

  const guard = {
    requireSubject: vi.fn(async () => ({
      me: {
        user: {
          id: USER_ID,
          organizationId: ORG_ID,
          email: "admin@papyrus.local",
          fullName: "Admin",
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
    inspectDocument: vi.fn(async (_ctx, documentId: string) => {
      if (options.forbiddenDocIds?.has(documentId)) {
        return {
          allowed: false as const,
          statusCode: 403 as const,
          code: "FORBIDDEN",
          message: "Você não possui permissão para acessar este documento.",
        };
      }
      const found = docs[documentId];
      if (!found) {
        return {
          allowed: false as const,
          statusCode: 404 as const,
          code: "NOT_FOUND",
          message: "Documento não encontrado.",
        };
      }
      return { allowed: true as const, document: found };
    }),
    inspectCreateScope: vi.fn(async (_ctx, _categoryId: string, folderId: string | null) =>
      options.inspectCreateScopeFn ? options.inspectCreateScopeFn(folderId) : true,
    ),
  } as unknown as DocumentAuthorizationGuard;

  const moveDocumentService = {
    moveDocument: vi.fn(async ({ documentId }) => ({
      document: docs[documentId] ?? makeDocument({ id: documentId }),
    })),
  } as unknown as MoveDocumentService;

  const archiveDocumentService = {
    archiveDocument: vi.fn(async ({ documentId }) => ({
      document: docs[documentId] ?? makeDocument({ id: documentId }),
    })),
  } as unknown as ArchiveDocumentService;

  const trashDocumentService = {
    trashDocument: vi.fn(async ({ documentId }) => ({
      document: docs[documentId] ?? makeDocument({ id: documentId }),
    })),
  } as unknown as TrashDocumentService;

  const tagService = {
    attachTagToDocument: vi.fn(async ({ documentId, tagId }) => ({
      documentId,
      tagId,
      attachedAt: "2026-01-01T00:00:00Z",
    })),
  } as unknown as TagService;

  const fileEntries = Object.values(options.files ?? {});

  const documentVersionRepository = {
    findById: vi.fn(async (versionId: string) => {
      const match = fileEntries.find((entry) => entry.versionId === versionId);
      if (!match) {
        return null;
      }
      return {
        id: match.versionId,
        documentId: match.documentId,
        versionNumber: 1,
        fileObjectId: match.file.id,
        uploadedByUserId: USER_ID,
        changeNote: null,
        createdAt: "2026-01-01T00:00:00Z",
      };
    }),
  } as unknown as DocumentVersionRepositoryPort;

  const uploadRepository = {
    findFileObjectOrganizationId: vi.fn(async () => ORG_ID),
    findFileObjectById: vi.fn(async (fileId: string) => {
      const match = fileEntries.find((entry) => entry.file.id === fileId);
      return match ? match.file : null;
    }),
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
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const storageConnections = {
    findById: vi.fn(async (id: string) => (id === STORAGE_ID ? connection : null)),
  } as unknown as StorageConnectionRepositoryPort;

  const storageProvider: StorageProvider = {
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
    checkHealth: async () => ({ ok: true, latencyMs: 1 }),
    putObject: async () => ({
      key: { value: "mock" },
      metadata: {
        contentType: "application/octet-stream",
        contentLength: 0,
      },
    }),
    getObject: async (key) => {
      const match = fileEntries.find((entry) => entry.file.objectKey === key.value);
      const buf = match?.content ?? Buffer.alloc(0);
      return {
        body: Readable.from([buf]),
        metadata: {
          contentType: match?.file.detectedMimeType ?? "application/octet-stream",
          contentLength: buf.length,
        },
      };
    },
    headObject: async () => null,
    deleteObject: async () => undefined,
  };

  const storageRegistry = createStorageProviderRegistry();
  storageRegistry.registerFactory("local", async () => storageProvider);

  const auditRepository = {
    append: vi.fn(async (input: AuditEventInput) => {
      auditedEvents.push(input);
      return {
        id: `audit-${auditedEvents.length}`,
        occurredAt: "2026-01-01T00:00:00Z",
        ...input,
      };
    }),
    list: vi.fn(),
  } as unknown as AuditRepositoryPort;

  await registerDocumentBulkActionRoutes(app, {
    guard,
    moveDocumentService,
    archiveDocumentService,
    trashDocumentService,
    tagService,
    documentVersionRepository,
    uploadRepository,
    storageConnections,
    storageRegistry,
    auditRepository,
    maxBulkZipTotalBytes: options.maxBulkZipTotalBytes,
  });

  return {
    app,
    guard,
    moveDocumentService,
    archiveDocumentService,
    trashDocumentService,
    tagService,
    auditedEvents,
  };
}

describe("Document bulk actions routes", () => {
  it("moves authorized documents while skipping already-located items and checking destination CREATE scope", async () => {
    const { app, moveDocumentService } = await createBulkTestHarness({
      docs: {
        [DOC_1_ID]: makeDocument({ id: DOC_1_ID, folderId: FOLDER_A }),
        [DOC_2_ID]: makeDocument({ id: DOC_2_ID, folderId: FOLDER_B }),
      },
      inspectCreateScopeFn: async (folderId) => folderId === FOLDER_B,
    });

    const res = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-actions`,
      payload: {
        action: "MOVE",
        documentIds: [DOC_1_ID, DOC_2_ID, DOC_1_ID],
        targetFolderId: FOLDER_B,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.totalRequested).toBe(2);
    expect(body.data.succeededCount).toBe(2);
    expect(body.data.failedCount).toBe(0);
    expect(moveDocumentService.moveDocument).toHaveBeenCalledTimes(1);
    expect(moveDocumentService.moveDocument).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: DOC_1_ID, targetFolderId: FOLDER_B }),
    );
  });

  it("isolates destination CREATE scope denials and missing permissions per document on MOVE", async () => {
    const { app, moveDocumentService } = await createBulkTestHarness({
      docs: {
        [DOC_1_ID]: makeDocument({ id: DOC_1_ID, folderId: FOLDER_A }),
        [DOC_2_ID]: makeDocument({ id: DOC_2_ID, folderId: FOLDER_A }),
      },
      forbiddenDocIds: new Set([DOC_2_ID]),
      inspectCreateScopeFn: async () => false,
    });

    const res = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-actions`,
      payload: {
        action: "MOVE",
        documentIds: [DOC_1_ID, DOC_2_ID],
        targetFolderId: FOLDER_B,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.succeededCount).toBe(0);
    expect(body.data.failedCount).toBe(2);
    expect(body.data.results).toEqual([
      expect.objectContaining({ documentId: DOC_1_ID, status: "FAILED", errorCode: "FORBIDDEN" }),
      expect.objectContaining({ documentId: DOC_2_ID, status: "FAILED", errorCode: "FORBIDDEN" }),
    ]);
    expect(moveDocumentService.moveDocument).not.toHaveBeenCalled();
  });

  it("handles ARCHIVE idempotently and isolates TRASH domain failures (such as retention hold)", async () => {
    const { app, archiveDocumentService, trashDocumentService } = await createBulkTestHarness({
      docs: {
        [DOC_1_ID]: makeDocument({ id: DOC_1_ID, status: "ARCHIVED" }),
        [DOC_2_ID]: makeDocument({ id: DOC_2_ID, status: "APPROVED" }),
        [DOC_3_ID]: makeDocument({ id: DOC_3_ID, status: "APPROVED" }),
      },
    });

    const archiveRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-actions`,
      payload: {
        action: "ARCHIVE",
        documentIds: [DOC_1_ID, DOC_2_ID],
        reason: "Fim do exercício",
      },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().data).toMatchObject({ succeededCount: 2, failedCount: 0 });
    expect(archiveDocumentService.archiveDocument).toHaveBeenCalledTimes(1);

    vi.mocked(trashDocumentService.trashDocument).mockImplementation(async ({ documentId }) => {
      if (documentId === DOC_3_ID) {
        throw new DomainError(
          "DOCUMENT_TRASH_BLOCKED_BY_RETENTION",
          "Documento bloqueado por política de retenção ativa.",
        );
      }
      return { document: makeDocument({ id: documentId, status: "DELETED" }) };
    });

    const trashRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-actions`,
      payload: {
        action: "TRASH",
        documentIds: [DOC_2_ID, DOC_3_ID],
      },
    });
    expect(trashRes.statusCode).toBe(200);
    expect(trashRes.json().data).toMatchObject({
      action: "TRASH",
      succeededCount: 1,
      failedCount: 1,
      results: [
        { documentId: DOC_2_ID, status: "SUCCEEDED" },
        expect.objectContaining({
          documentId: DOC_3_ID,
          status: "FAILED",
          errorCode: "DOCUMENT_TRASH_BLOCKED_BY_RETENTION",
        }),
      ],
    });
  });

  it("attaches tags idempotently and returns 404 when tag does not exist", async () => {
    const { app, tagService } = await createBulkTestHarness();

    vi.mocked(tagService.attachTagToDocument)
      .mockResolvedValueOnce({
        documentId: DOC_1_ID,
        tagId: TAG_ID,
        attachedAt: "2026-01-01T00:00:00Z",
      })
      .mockRejectedValueOnce(new DomainError("DOCUMENT_TAG_ALREADY_ATTACHED", "Já vinculada."));

    const okRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-actions`,
      payload: {
        action: "ATTACH_TAG",
        documentIds: [DOC_1_ID, DOC_2_ID],
        tagId: TAG_ID,
      },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().data).toMatchObject({ succeededCount: 2, failedCount: 0 });

    vi.mocked(tagService.attachTagToDocument).mockRejectedValueOnce(
      new DomainError("TAG_NOT_FOUND", "Etiqueta não encontrada."),
    );
    const notFoundRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-actions`,
      payload: {
        action: "ATTACH_TAG",
        documentIds: [DOC_1_ID],
        tagId: TAG_ID,
      },
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.json().error.code).toBe("NOT_FOUND");
  });

  it("packages downloadable documents into a ZIP archive, deduplicates names, skips quarantined files, and writes audit events", async () => {
    const payload1 = Buffer.from("conteudo pdf um");
    const payload2 = Buffer.from("conteudo pdf dois");

    const { app, auditedEvents } = await createBulkTestHarness({
      docs: {
        [DOC_1_ID]: makeDocument({ id: DOC_1_ID, currentVersionId: VER_1_ID }),
        [DOC_2_ID]: makeDocument({ id: DOC_2_ID, currentVersionId: VER_2_ID }),
        [DOC_3_ID]: makeDocument({ id: DOC_3_ID, currentVersionId: VER_3_ID }),
      },
      files: {
        [FILE_1_ID]: {
          documentId: DOC_1_ID,
          versionId: VER_1_ID,
          file: makeFileObject({
            id: FILE_1_ID,
            originalFileName: "contrato.pdf",
            sizeBytes: payload1.length,
            status: "AVAILABLE",
          }),
          content: payload1,
        },
        [FILE_2_ID]: {
          documentId: DOC_2_ID,
          versionId: VER_2_ID,
          file: makeFileObject({
            id: FILE_2_ID,
            originalFileName: "contrato.pdf",
            sizeBytes: payload2.length,
            status: "AVAILABLE",
          }),
          content: payload2,
        },
        [FILE_3_ID]: {
          documentId: DOC_3_ID,
          versionId: VER_3_ID,
          file: makeFileObject({
            id: FILE_3_ID,
            originalFileName: "infectado.pdf",
            sizeBytes: 10,
            status: "QUARANTINED",
            avScanResult: "INFECTED",
          }),
          content: Buffer.from("eicar-virus"),
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-download`,
      payload: {
        documentIds: [DOC_1_ID, DOC_2_ID, DOC_3_ID],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain("papyrus-documents.zip");
    expect(res.headers["cache-control"]).toContain("no-store");

    const unzipped = unzipSync(new Uint8Array(res.rawPayload));
    expect(Object.keys(unzipped)).toEqual(["contrato.pdf", "contrato (2).pdf"]);
    expect(Buffer.from(unzipped["contrato.pdf"] ?? []).toString("utf8")).toBe("conteudo pdf um");
    expect(Buffer.from(unzipped["contrato (2).pdf"] ?? []).toString("utf8")).toBe(
      "conteudo pdf dois",
    );

    expect(auditedEvents).toHaveLength(2);
    expect(auditedEvents.map((e) => e.resourceId)).toEqual([DOC_1_ID, DOC_2_ID]);
    expect(auditedEvents[0]?.metadata).toMatchObject({ delivery: "BULK_ZIP" });
  });

  it("blocks ZIP download when all files are quarantined (409), forbidden (403), or exceed size limit (413)", async () => {
    const quarantinedHarness = await createBulkTestHarness({
      docs: {
        [DOC_1_ID]: makeDocument({ id: DOC_1_ID, currentVersionId: VER_1_ID }),
      },
      files: {
        [FILE_1_ID]: {
          documentId: DOC_1_ID,
          versionId: VER_1_ID,
          file: makeFileObject({ id: FILE_1_ID, status: "QUARANTINED", sizeBytes: 10 }),
          content: Buffer.from("0123456789"),
        },
      },
    });

    const qRes = await quarantinedHarness.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-download`,
      payload: { documentIds: [DOC_1_ID] },
    });
    expect(qRes.statusCode).toBe(409);
    expect(qRes.json().error.code).toBe("FILE_QUARANTINED");

    const forbiddenHarness = await createBulkTestHarness({
      forbiddenDocIds: new Set([DOC_1_ID]),
    });
    const fRes = await forbiddenHarness.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-download`,
      payload: { documentIds: [DOC_1_ID] },
    });
    expect(fRes.statusCode).toBe(403);

    const oversizedHarness = await createBulkTestHarness({
      maxBulkZipTotalBytes: 8,
      docs: {
        [DOC_1_ID]: makeDocument({ id: DOC_1_ID, currentVersionId: VER_1_ID }),
      },
      files: {
        [FILE_1_ID]: {
          documentId: DOC_1_ID,
          versionId: VER_1_ID,
          file: makeFileObject({ id: FILE_1_ID, status: "AVAILABLE", sizeBytes: 12 }),
          content: Buffer.from("012345678901"),
        },
      },
    });
    const bigRes = await oversizedHarness.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/bulk-download`,
      payload: { documentIds: [DOC_1_ID] },
    });
    expect(bigRes.statusCode).toBe(413);
    expect(bigRes.json().error.code).toBe("UPLOAD_TOO_LARGE");
  });
});
