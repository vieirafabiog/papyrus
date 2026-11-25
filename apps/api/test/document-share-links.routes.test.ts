import { Readable } from "node:stream";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import {
  type AuditEventInput,
  type AuditRepositoryPort,
  type DocumentEntity,
  type DocumentRepositoryPort,
  type DocumentShareLinkEntity,
  type DocumentShareLinkRepositoryPort,
  type DocumentVersionEntity,
  type DocumentVersionRepositoryPort,
  type FileObjectEntity,
  type StorageConnectionEntity,
  type StorageConnectionRepositoryPort,
  type TransactionContext,
  type TransactionManagerPort,
  type UploadSessionRepositoryPort,
  computeShareLinkStatus,
  createDocumentShareService,
} from "@papyrus/domain";
import { type StorageProvider, createStorageProviderRegistry } from "@papyrus/storage-core";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createShareLinkCryptoAdapter,
  registerDocumentShareRoutes,
} from "../src/modules/documents/share-links.routes.js";
import type { DocumentAuthorizationGuard } from "../src/plugins/authorization.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const VER_ID = "550e8400-e29b-41d4-a716-446655440002";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440003";
const USER_ID = "550e8400-e29b-41d4-a716-446655440010";
const STORAGE_ID = "550e8400-e29b-41d4-a716-446655440020";

async function createShareRouteHarness(
  options: {
    readonly allowManage?: boolean;
    readonly fileStatus?: FileObjectEntity["status"];
  } = {},
) {
  const app = Fastify({ logger: false });
  const filePayload = Buffer.from("%PDF-1.4\n%Conteudo compartilhado seguro", "utf8");

  const doc: DocumentEntity = {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato Externo",
    categoryId: "550e8400-e29b-41d4-a716-446655440099",
    folderId: null,
    status: "APPROVED",
    currentVersionId: VER_ID,
    ownerUserId: USER_ID,
    issueDate: null,
    expirationDate: null,
    metadata: {},
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const version: DocumentVersionEntity = {
    id: VER_ID,
    documentId: DOC_ID,
    versionNumber: 1,
    fileObjectId: FILE_ID,
    uploadedByUserId: USER_ID,
    changeNote: null,
    createdAt: "2026-01-01T00:00:00Z",
  };

  let currentFileStatus: FileObjectEntity["status"] = options.fileStatus ?? "AVAILABLE";

  const makeFile = (): FileObjectEntity => ({
    id: FILE_ID,
    storageConnectionId: STORAGE_ID,
    objectKey: `org/${ORG_ID}/documents/${DOC_ID}/versions/${VER_ID}/${FILE_ID}`,
    originalFileName: "contrato externo.pdf",
    detectedContentType: "application/pdf",
    sizeBytes: filePayload.length,
    checksumSha256: "b".repeat(64),
    status: currentFileStatus,
    createdAt: "2026-01-01T00:00:00Z",
  });

  const guard = {
    requireSubject: vi.fn(async () => ({
      me: {
        user: {
          id: USER_ID,
          organizationId: ORG_ID,
          email: "gestor@papyrus.local",
          fullName: "Ana Gestora",
          status: "ACTIVE",
        },
        groups: [],
        roles: [],
        permissions: [],
      },
      subject: { userId: USER_ID, organizationId: ORG_ID, assignments: [] },
      rolePermissions: new Map(),
    })),
    authorizeDocument: vi.fn(async (_ctx, _id, _action, reply) => {
      if (options.allowManage === false) {
        void reply.status(403).send({
          error: { code: "FORBIDDEN", message: "Sem permissão de download.", requestId: "req" },
        });
        return null;
      }
      return doc;
    }),
  } as unknown as DocumentAuthorizationGuard;

  const links = new Map<string, DocumentShareLinkEntity>();
  const shareLinksRepo: DocumentShareLinkRepositoryPort = {
    async create(input) {
      const entity: DocumentShareLinkEntity = {
        id: input.id,
        organizationId: input.organizationId,
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        tokenHash: input.tokenHash,
        label: input.label,
        allowDownload: input.allowDownload,
        passcodeHash: input.passcodeHash,
        maxUses: input.maxUses,
        useCount: 0,
        expiresAt: input.expiresAt.toISOString(),
        revokedAt: null,
        revokedByUserId: null,
        lastAccessedAt: null,
        createdBy: { id: input.createdByUserId, fullName: "Ana Gestora" },
        createdAt: input.createdAt.toISOString(),
      };
      links.set(entity.id, entity);
      return entity;
    },
    async listByDocument({ organizationId, documentId }) {
      return [...links.values()].filter(
        (l) => l.organizationId === organizationId && l.documentId === documentId,
      );
    },
    async findById(id) {
      return links.get(id) ?? null;
    },
    async findByTokenHash(tokenHash) {
      return [...links.values()].find((l) => l.tokenHash === tokenHash) ?? null;
    },
    async revokeById({ id, revokedByUserId, revokedAt }) {
      const current = links.get(id);
      if (!current) {
        return null;
      }
      const next = { ...current, revokedAt: revokedAt.toISOString(), revokedByUserId };
      links.set(id, next);
      return next;
    },
    async consumeUseAtomically({ id, now }) {
      const current = links.get(id);
      if (!current || computeShareLinkStatus(current, now) !== "ACTIVE") {
        return null;
      }
      const next = {
        ...current,
        useCount: current.useCount + 1,
        lastAccessedAt: now.toISOString(),
      };
      links.set(id, next);
      return next;
    },
  };

  const shareCrypto = createShareLinkCryptoAdapter(
    "papyrus-test-share-master-secret-at-least-32-chars",
  );
  let seq = 1;
  const shareService = createDocumentShareService({
    shareLinks: shareLinksRepo,
    documents: { findById: vi.fn(async () => doc) } as unknown as DocumentRepositoryPort,
    documentVersions: {
      findById: vi.fn(async () => version),
    } as unknown as DocumentVersionRepositoryPort,
    uploads: {
      findFileObjectOrganizationId: vi.fn(async () => ORG_ID),
      findFileObjectById: vi.fn(async () => makeFile()),
    } as unknown as UploadSessionRepositoryPort,
    transactions: {
      async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return fn({} as TransactionContext);
      },
    } as TransactionManagerPort,
    audit: {
      append: vi.fn(async (input: AuditEventInput) => ({
        id: "audit-1",
        occurredAt: "2026-11-25T12:00:00Z",
        ...input,
      })),
      list: vi.fn(),
    } as unknown as AuditRepositoryPort,
    crypto: shareCrypto,
    generateId: () => `550e8400-e29b-41d4-a716-44665544088${seq++}`,
  });

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

  const provider: StorageProvider = {
    kind: "local",
    capabilities: {
      streamingRead: true,
      streamingWrite: true,
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideEncryption: false,
      versioning: false,
      healthCheck: true,
    },
    checkHealth: async () => ({ ok: true, latencyMs: 1 }),
    putObject: vi.fn(),
    getObject: vi.fn(async () => ({
      body: Readable.from([filePayload]),
      metadata: {
        contentType: "application/pdf",
        contentLength: filePayload.length,
        checksumSha256: "b".repeat(64),
      },
    })),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };

  const storageRegistry = createStorageProviderRegistry();
  storageRegistry.registerFactory("local", async () => provider);

  await registerDocumentShareRoutes(app, {
    guard,
    shareService,
    shareCrypto,
    storageConnections: {
      findById: vi.fn(async () => connection),
    } as unknown as StorageConnectionRepositoryPort,
    storageRegistry,
  });

  return {
    app,
    filePayload,
    setQuarantined: () => {
      currentFileStatus = "QUARANTINED";
    },
  };
}

describe("Document temporary share routes", () => {
  it("enforces DOWNLOAD permission to manage share links and never leaks tokens on list", async () => {
    const denied = await createShareRouteHarness({ allowManage: false });
    const forbiddenRes = await denied.app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/share-links`,
      payload: { expiresInMinutes: 60 },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    const { app } = await createShareRouteHarness();
    const createRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/share-links`,
      payload: {
        expiresInMinutes: 60,
        maxUses: 2,
        allowDownload: true,
        passcode: "SenhaForte99",
        label: "Auditoria",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdBody = createRes.json().data;
    expect(createdBody.shareToken.length).toBeGreaterThanOrEqual(32);
    expect(createdBody.link.requiresPasscode).toBe(true);
    expect(createdBody.link.tokenHash).toBeUndefined();
    expect(createdBody.link.passcodeHash).toBeUndefined();

    const listRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/share-links`,
    });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json().data.items[0];
    expect(listed.label).toBe("Auditoria");
    expect(listed.shareToken).toBeUndefined();
    expect(listed.passcodeHash).toBeUndefined();
  });

  it("protects public share endpoints with passcode rate limit, noindex headers, download stream, and instant revocation", async () => {
    const { app, filePayload } = await createShareRouteHarness();
    const createRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/share-links`,
      payload: {
        expiresInMinutes: 60,
        allowDownload: true,
        passcode: "SenhaSegura1",
      },
    });
    const { shareToken, link } = createRes.json().data;

    // Public metadata returns locked view without internal tenant IDs
    const metaLockedRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/share/${shareToken}`,
    });
    expect(metaLockedRes.statusCode).toBe(200);
    expect(metaLockedRes.headers["x-robots-tag"]).toContain("noindex");
    expect(metaLockedRes.headers["referrer-policy"]).toBe("no-referrer");
    expect(metaLockedRes.json().data).toMatchObject({
      title: "Contrato Externo",
      requiresPasscode: true,
      unlocked: false,
    });
    expect(metaLockedRes.json().data.organizationId).toBeUndefined();

    // Download fails before unlock
    const blockedDownloadRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/share/${shareToken}/download`,
    });
    expect(blockedDownloadRes.statusCode).toBe(401);

    // Rate-limit brute-force passcode guesses (5 wrong -> 6th gets 429)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrongRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/share/${shareToken}/unlock`,
        payload: { passcode: `Errada${attempt}` },
      });
      expect(wrongRes.statusCode).toBe(401);
    }
    const throttledRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/share/${shareToken}/unlock`,
      payload: { passcode: "SenhaSegura1" },
    });
    expect(throttledRes.statusCode).toBe(429);

    // Unlock from a fresh IP succeeds and enables streaming download
    const unlockRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/share/${shareToken}/unlock`,
      remoteAddress: "10.0.0.99",
      payload: { passcode: "SenhaSegura1" },
    });
    expect(unlockRes.statusCode).toBe(200);
    const { unlockToken } = unlockRes.json().data;

    const downloadRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/share/${shareToken}/download`,
      headers: { "x-share-unlock": unlockToken },
    });
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers["content-disposition"]).toContain("attachment;");
    expect(downloadRes.rawPayload.equals(filePayload)).toBe(true);

    // Revoking immediately cuts off public access (404)
    const revokeRes = await app.inject({
      method: "DELETE",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/share-links/${link.id}`,
    });
    expect(revokeRes.statusCode).toBe(200);

    const afterRevokeRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/share/${shareToken}`,
      headers: { "x-share-unlock": unlockToken },
    });
    expect(afterRevokeRes.statusCode).toBe(404);
  });

  it("blocks access fail-closed when the underlying file transitions to QUARANTINED", async () => {
    const { app, setQuarantined } = await createShareRouteHarness();
    const createRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${DOC_ID}/share-links`,
      payload: { expiresInMinutes: 60, allowDownload: true },
    });
    const { shareToken } = createRes.json().data;

    setQuarantined();

    const blockedRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/share/${shareToken}`,
    });
    expect(blockedRes.statusCode).toBe(409);
    expect(blockedRes.json().error.code).toBe("FILE_QUARANTINED");
  });
});
