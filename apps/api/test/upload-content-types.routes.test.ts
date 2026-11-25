import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { SYSTEM_ROLE_DEFINITIONS } from "@papyrus/auth";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  DocumentRepositoryPort,
  FileObjectEntity,
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
  TransactionContext,
  TransactionManagerPort,
  UploadSessionEntity,
  UploadSessionRepositoryPort,
} from "@papyrus/domain";
import { createUploadSessionService } from "@papyrus/domain";
import { type StorageProvider, createStorageProviderRegistry } from "@papyrus/storage-core";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerUploadRoutes } from "../src/modules/uploads/upload.routes.js";
import type { DocumentAuthorizationGuard } from "../src/plugins/authorization.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "550e8400-e29b-41d4-a716-446655440010";
const CONN_ID = "550e8400-e29b-41d4-a716-446655440020";

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("Upload streaming content-type handling", () => {
  it("streams text/markdown, text/plain, application/json, and DOCX uploads without 415", async () => {
    const app = Fastify({ logger: false });
    const sessions = new Map<string, UploadSessionEntity>();
    const fileObjects = new Map<string, FileObjectEntity>();
    const storedBytes = new Map<string, Buffer>();
    const auditLogs: AuditEventInput[] = [];
    const roleId = "role-admin";
    const nowIso = new Date().toISOString();

    const connection: StorageConnectionEntity = {
      id: CONN_ID,
      organizationId: ORG_ID,
      name: "Local Test",
      kind: "local",
      isDefault: true,
      status: "ACTIVE",
      nonSecretConfig: {},
      encryptedSecretRef: null,
      hasCredentials: false,
      lastHealthCheckAt: null,
      lastHealthMessage: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const memoryProvider: StorageProvider = {
      kind: "local",
      capabilities: {
        streamingRead: true,
        streamingWrite: true,
        signedUpload: false,
        signedDownload: false,
        multipartUpload: false,
        serverSideCopy: false,
      },
      async checkHealth() {
        return {
          providerKind: "local",
          healthy: true,
          latencyMs: 1,
          checkedAt: new Date(),
          message: "ok",
        };
      },
      async putObject(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buf = Buffer.concat(chunks);
        storedBytes.set(input.key.value, buf);
        return {
          key: input.key,
          contentType: input.metadata.contentType,
          contentLength: buf.length,
          checksumSha256: sha256Hex(buf),
        };
      },
      async getObject(key) {
        const buf = storedBytes.get(key.value) ?? Buffer.alloc(0);
        return {
          body: Readable.from([buf]),
          metadata: {
            contentType: "application/octet-stream",
            contentLength: buf.length,
            checksumSha256: sha256Hex(buf),
          },
        };
      },
      async headObject() {
        return null;
      },
      async deleteObject() {},
    };

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", () => memoryProvider);

    const connections: StorageConnectionRepositoryPort = {
      async findById(id) {
        return id === CONN_ID ? connection : null;
      },
      async findDefaultByOrganizationId() {
        return connection;
      },
      async listByOrganizationId() {
        return [connection];
      },
      async countDocumentsReferencingConnection() {
        return 0;
      },
      async create() {
        throw new Error("not used");
      },
      async update() {
        return null;
      },
    };

    const uploadRepository: UploadSessionRepositoryPort = {
      async findById(id) {
        return sessions.get(id) ?? null;
      },
      async findByIdempotencyKey(orgId, userId, key) {
        for (const s of sessions.values()) {
          if (s.organizationId === orgId && s.userId === userId && s.idempotencyKey === key) {
            return s;
          }
        }
        return null;
      },
      async findFileObjectById(id) {
        return fileObjects.get(id) ?? null;
      },
      async createSessionWithFileObject(input) {
        const fo: FileObjectEntity = {
          id: input.fileObjectId,
          storageConnectionId: input.storageConnectionId,
          objectKey: input.objectKey,
          originalFileName: input.originalFileName,
          detectedContentType: input.declaredContentType,
          sizeBytes: input.declaredSizeBytes,
          checksumSha256: input.checksumSha256,
          status: "UPLOADING",
          createdAt: nowIso,
        };
        const sess: UploadSessionEntity = {
          id: input.sessionId,
          organizationId: input.organizationId,
          userId: input.userId,
          storageConnectionId: input.storageConnectionId,
          fileObjectId: fo.id,
          categoryId: input.categoryId ?? null,
          declaredSizeBytes: input.declaredSizeBytes,
          declaredContentType: input.declaredContentType,
          indexContentRequested: input.indexContentRequested ?? null,
          idempotencyKey: input.idempotencyKey,
          status: "PENDING",
          expiresAt: input.expiresAt.toISOString(),
          finalizedAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        fileObjects.set(fo.id, fo);
        sessions.set(sess.id, sess);
        return { session: sess, fileObject: fo };
      },
      async markUploadReceived(input) {
        const existing = sessions.get(input.sessionId);
        const fo = fileObjects.get(input.fileObjectId);
        if (!existing || !fo) {
          return null;
        }
        const nextSession: UploadSessionEntity = { ...existing, status: "UPLOADED" };
        const nextFo: FileObjectEntity = {
          ...fo,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
        };
        sessions.set(nextSession.id, nextSession);
        fileObjects.set(nextFo.id, nextFo);
        return { session: nextSession, fileObject: nextFo };
      },
      async finalizeToQuarantine() {
        return null;
      },
      async markFileObjectProcessed() {
        return null;
      },
      async markSessionExpired() {},
    };

    const transactions: TransactionManagerPort = {
      async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return fn({ __brand: "TransactionContext" });
      },
    };

    const auditRepository: AuditRepositoryPort = {
      async append(input) {
        auditLogs.push(input);
        return { ...input, id: randomUUID(), occurredAt: nowIso };
      },
      async list() {
        return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
      },
    };

    const documents: DocumentRepositoryPort = {
      async findById() {
        return null;
      },
      async list() {
        return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
      },
      async create() {
        throw new Error("not used");
      },
      async updateWithOptimisticLock() {
        return null;
      },
      async setCurrentVersion() {
        return null;
      },
      async updateStatus() {
        return null;
      },
    };

    const uploadSessionService = createUploadSessionService({
      uploads: uploadRepository,
      documents,
      storageRouter: {
        async resolveWriteTarget() {
          return { connection, source: "ORGANIZATION_DEFAULT" };
        },
        async resolveReadTarget() {
          return connection;
        },
      },
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

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
        loaded: {
          userId: USER_ID,
          organizationId: ORG_ID,
          assignments: [
            {
              roleId,
              scope: { type: "GLOBAL" as const },
              effect: "ALLOW" as const,
              source: "DIRECT" as const,
            },
          ],
        },
        rolePermissions: new Map([[roleId, [...SYSTEM_ROLE_DEFINITIONS.admin.permissions]]]),
      })),
      authorizeUploadScope: vi.fn(async () => true),
      authorizeDocument: vi.fn(async () => null),
    } as unknown as DocumentAuthorizationGuard;

    await registerUploadRoutes(app, {
      guard,
      uploadRepository,
      uploadSessionService,
      storageUploadDeps: {
        connections,
        storageRegistry,
        transactions,
        auditRepository,
      },
    });

    const cases = [
      {
        fileName: "manual.md",
        contentType: "text/markdown",
        body: Buffer.from("# Guia do Papyrus\n\nConteúdo markdown autorizado.\n", "utf8"),
      },
      {
        fileName: "notas.txt",
        contentType: "text/plain",
        body: Buffer.from("Texto puro simples\n", "utf8"),
      },
      {
        fileName: "config.json",
        contentType: "application/json",
        body: Buffer.from('{"chave":"valor"}\n', "utf8"),
      },
      {
        fileName: "documento.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        body: Buffer.from("PK\x03\x04fake-ooxml-stream-bytes", "latin1"),
      },
    ] as const;

    for (const testCase of cases) {
      const createRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
        payload: {
          originalFileName: testCase.fileName,
          declaredSizeBytes: testCase.body.length,
          declaredContentType: testCase.contentType,
          declaredChecksumSha256: sha256Hex(testCase.body),
          idempotencyKey: `idem-${testCase.fileName}`,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const sessionId = (createRes.json() as { data: { id: string } }).data.id;

      const putRes = await app.inject({
        method: "PUT",
        url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${sessionId}/content`,
        headers: {
          "content-type": testCase.contentType,
        },
        payload: testCase.body,
      });
      expect(putRes.statusCode).toBe(200);
      expect((putRes.json() as { data: { status: string } }).data.status).toBe("UPLOADED");
    }
  });
});
