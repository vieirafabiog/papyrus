import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  SYSTEM_ROLE_DEFINITIONS,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@papyrus/auth";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import {
  auditEvents,
  categories,
  categoryFields,
  createAuditRepository,
  createAuthorizationRepository,
  createCategoryRepository,
  createDocumentRepository,
  createDocumentRetentionHoldRepository,
  createDocumentTrashRepository,
  createDocumentVersionRepository,
  createFolderRepository,
  createOutboxRepository,
  createRetentionPolicyRepository,
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
  createTransactionManager,
  createUploadSessionRepository,
  createUserRepository,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  userRoleScopes,
  users,
} from "@papyrus/database";
import {
  createDocumentUseCase,
  createDocumentVersionUseCase,
  createFinalizeUploadService,
  createStorageRouterService,
  createUploadSessionService,
  restoreDocumentUseCase,
  trashDocumentUseCase,
} from "@papyrus/domain";
import { createStorageProviderRegistry } from "@papyrus/storage-core";
import { createLocalStorageProvider } from "@papyrus/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../../src/modules/auth/auth.routes.js";
import { createAuthService } from "../../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../../packages/database/drizzle");

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildMultipartPayload(boundary: string, filename: string, content: Buffer): Buffer {
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([header, content, footer]);
}

describe("Document API full lifecycle integration (upload -> create -> list -> detail -> version -> trash)", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  let localStorageRoot = "";

  beforeAll(async () => {
    localStorageRoot = await mkdtemp(path.join(os.tmpdir(), "papyrus-doc-lifecycle-"));
    const externalUrl = process.env.DATABASE_URL;
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = container.getConnectionUri();
    }

    pool = new Pool({ connectionString });
    pool.on("error", () => {});
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
    if (localStorageRoot) {
      await rm(localStorageRoot, { recursive: true, force: true });
    }
  });

  it("executes upload finalization, creation, listing, detail, versioning, download, trash, and restore on real PostgreSQL", async () => {
    const db = drizzle(pool);
    const orgId = randomUUID();
    const adminId = randomUUID();
    const adminRoleId = randomUUID();
    const categoryId = randomUUID();
    const folderId = randomUUID();
    const storageConnId = randomUUID();
    const password = "LifecyclePass!2026";

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword(password);

    const sessionService = createSessionService({
      store: {
        async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
          const [row] = await db.insert(sessions).values(input).returning();
          if (!row) {
            throw new Error("Session insert failed");
          }
          return row;
        },
        async findByTokenHash(tokenHash: string) {
          const [row] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.tokenHash, tokenHash))
            .limit(1);
          return row ?? null;
        },
        async revokeById(id: string, revokedAt: Date) {
          await db.update(sessions).set({ revokedAt }).where(eq(sessions.id, id));
        },
        async revokeAllForUser(userId: string, revokedAt: Date) {
          await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, userId));
        },
      } satisfies SessionStorePort,
    });

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Lifecycle E2E",
      slug: `org-life-${orgId.slice(0, 8)}`,
    });

    await db.insert(roles).values({
      id: adminRoleId,
      organizationId: orgId,
      key: "admin",
      name: "Administrador",
      isSystem: true,
    });

    const insertedPerms = await db
      .insert(permissions)
      .values(
        SYSTEM_ROLE_DEFINITIONS.admin.permissions.map((perm) => ({
          id: randomUUID(),
          action: perm.action,
          resource: perm.resource,
        })),
      )
      .onConflictDoNothing()
      .returning();
    const allPerms = insertedPerms.length > 0 ? insertedPerms : await db.select().from(permissions);
    const permByKey = new Map(allPerms.map((p) => [`${p.action}:${p.resource}`, p.id]));
    const adminPermIds = SYSTEM_ROLE_DEFINITIONS.admin.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      adminPermIds.map((permissionId) => ({
        roleId: adminRoleId,
        permissionId,
      })),
    );

    const adminEmail = `admin-life-${orgId.slice(0, 6)}@papyrus.local`;
    await db.insert(users).values({
      id: adminId,
      organizationId: orgId,
      email: adminEmail,
      fullName: "Admin Lifecycle",
      passwordHash,
      status: "ACTIVE",
    });

    await db.insert(userRoleScopes).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: adminId,
      roleId: adminRoleId,
      scopeType: "GLOBAL",
      effect: "ALLOW",
    });

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos Corporativos",
      isActive: true,
    });
    await db.insert(categoryFields).values({
      id: randomUUID(),
      categoryId,
      key: "fornecedor",
      label: "Fornecedor",
      type: "TEXT",
      required: true,
      sortOrder: 0,
    });

    await db.insert(folders).values({
      id: folderId,
      organizationId: orgId,
      parentId: null,
      name: "Jurídico",
      materializedPath: `/${folderId}`,
      status: "ACTIVE",
    });

    await db.insert(storageConnections).values({
      id: storageConnId,
      organizationId: orgId,
      name: "Local Lifecycle",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: localStorageRoot },
    });

    const transactions = createTransactionManager(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const documentVersionRepository = createDocumentVersionRepository(db);
    const categoryRepository = createCategoryRepository(db);
    const folderRepository = createFolderRepository(db);
    const userRepository = createUserRepository(db);
    const uploadRepository = createUploadSessionRepository(db);
    const connectionRepository = createStorageConnectionRepository(db);
    const outboxRepository = createOutboxRepository(db);
    const documentTrashRepository = createDocumentTrashRepository(db);
    const retentionPoliciesRepo = createRetentionPolicyRepository(db);
    const holdsRepo = createDocumentRetentionHoldRepository(db);

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", ({ connection }) =>
      createLocalStorageProvider({
        rootDirectory: String(connection.nonSecretConfig.rootDirectory ?? ""),
        fsync: false,
      }),
    );

    const storageRouter = createStorageRouterService({
      connections: connectionRepository,
      routingRules: createStorageRoutingRuleRepository(db),
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const maxUploadBytes = 1024 * 1024;
    const uploadSessionService = createUploadSessionService({
      uploads: uploadRepository,
      documents: documentRepository,
      storageRouter,
      transactions,
      audit: auditRepository,
      maxUploadBytes,
      generateId: () => randomUUID(),
    });

    const finalizeUploadService = createFinalizeUploadService({
      uploads: uploadRepository,
      objectVerifier: {
        async verifyUploadedObject({ storageConnectionId, objectKey }) {
          const conn = await connectionRepository.findById(storageConnectionId);
          if (!conn) return null;
          const provider = await storageRegistry.resolveProvider(conn);
          const head = await provider.headObject({ value: objectKey });
          if (!head) return null;
          return {
            objectKey: head.key.value,
            contentLength: head.contentLength,
            contentType: head.contentType,
            checksumSha256: head.checksumSha256,
          };
        },
      },
      transactions,
      audit: auditRepository,
      processingQueue: outboxRepository.asUploadProcessingQueue(),
      generateId: () => randomUUID(),
    });

    const createDocumentService = createDocumentUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      categories: categoryRepository,
      folders: folderRepository,
      users: userRepository,
      uploadSessions: uploadRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const createDocumentVersionService = createDocumentVersionUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      uploadSessions: uploadRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const trashDocumentService = trashDocumentUseCase({
      documents: documentRepository,
      transactions,
      audit: auditRepository,
    });

    const restoreDocumentService = restoreDocumentUseCase({
      documents: documentRepository,
      transactions,
      audit: auditRepository,
      policies: retentionPoliciesRepo,
      holds: holdsRepo,
    });

    const authService = createAuthService({
      passwordService,
      sessionService,
      authzRepository,
      auditRepository,
      users: {
        async findCredentialByEmail(email) {
          const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
          if (!row) return null;
          return {
            user: {
              id: row.id,
              organizationId: row.organizationId,
              email: row.email,
              fullName: row.fullName,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            },
            passwordHash: row.passwordHash,
          };
        },
        async findProfileById(uid) {
          const [row] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
          if (!row) return null;
          return {
            user: {
              id: row.id,
              organizationId: row.organizationId,
              email: row.email,
              fullName: row.fullName,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            },
            groups: [],
            roles: [],
            permissions: [],
          };
        },
      },
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      uploadDeps: {
        authzRepository,
        documentRepository,
        uploadRepository,
        uploadSessionService,
        localUploadDeps: {
          connections: connectionRepository,
          storageRegistry,
          transactions,
          auditRepository,
          maxUploadBytes,
        },
      },
      documentDeps: {
        authzRepository,
        documentRepository,
        auditRepository,
        documentVersionRepository,
        uploadRepository,
        storageConnections: connectionRepository,
        storageRegistry,
        createDocumentService,
        createDocumentVersionService,
        trashDocumentService,
        restoreDocumentService,
        documentTrashRepository,
      },
    });
    await app.ready();

    try {
      const csrfRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
      });
      const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";
      const loginRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email: adminEmail, password },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie =
        loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
      const authCookies = {
        [SESSION_COOKIE_NAME]: sessionCookie,
        [CSRF_COOKIE_NAME]: csrfToken,
      };
      const csrfHeaders = { [CSRF_HEADER_NAME]: csrfToken };

      // Helper: execute real upload session + streaming multipart upload + finalization + scan clearance
      const uploadAndFinalize = async (
        fileName: string,
        payload: Buffer,
        idempotencyKey: string,
        documentId?: string,
      ) => {
        const checksum = sha256Hex(payload);
        const sessionRes = await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
          cookies: authCookies,
          headers: csrfHeaders,
          payload: {
            categoryId,
            folderId,
            ...(documentId ? { documentId } : {}),
            originalFileName: fileName,
            declaredSizeBytes: payload.length,
            declaredContentType: "application/pdf",
            declaredChecksumSha256: checksum,
            idempotencyKey,
          },
        });
        expect(sessionRes.statusCode).toBe(201);
        const sessionData = sessionRes.json().data as { id: string; fileObjectId: string };

        const boundary = "----PapyrusLifecycleBoundary";
        const contentRes = await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${sessionData.id}/content`,
          cookies: authCookies,
          headers: {
            ...csrfHeaders,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          payload: buildMultipartPayload(boundary, fileName, payload),
        });
        expect(contentRes.statusCode).toBe(200);

        const finalized = await finalizeUploadService.finalizeUpload({
          organizationId: orgId,
          actorUserId: adminId,
          requestId: randomUUID(),
          sessionId: sessionData.id,
          expectedChecksumSha256: checksum,
        });
        expect(finalized.session.status).toBe("FINALIZED");
        expect(finalized.fileObject.status).toBe("QUARANTINED");

        // Mark file AVAILABLE as completed by worker malware/content processing
        const available = await uploadRepository.markFileObjectProcessed({
          fileObjectId: finalized.fileObject.id,
          status: "AVAILABLE",
          detectedContentType: "application/pdf",
        });
        expect(available?.status).toBe("AVAILABLE");

        return { sessionId: sessionData.id, fileObjectId: finalized.fileObject.id, checksum };
      };

      // 1. Unfinalized upload cannot be used to create a document
      const pendingPayload = Buffer.from("%PDF-1.7 pending");
      const pendingRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
        cookies: authCookies,
        headers: csrfHeaders,
        payload: {
          categoryId,
          folderId,
          originalFileName: "pendente.pdf",
          declaredSizeBytes: pendingPayload.length,
          declaredContentType: "application/pdf",
          declaredChecksumSha256: sha256Hex(pendingPayload),
          idempotencyKey: "pending-upload-1",
        },
      });
      expect(pendingRes.statusCode).toBe(201);
      const pendingSessionId = pendingRes.json().data.id as string;

      const failCreateRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/documents`,
        cookies: authCookies,
        headers: csrfHeaders,
        payload: {
          title: "Contrato Pendente",
          categoryId,
          folderId,
          uploadSessionId: pendingSessionId,
          metadata: { fornecedor: "Fornecedor Alpha" },
        },
      });
      expect(failCreateRes.statusCode).toBe(409);
      expect(failCreateRes.json().error.code).toBe("CONFLICT");
      expect(failCreateRes.json().error.details.domainCode).toBe("UPLOAD_NOT_FINALIZED");

      // 2. Finalized upload -> Create Document (v1)
      const v1Payload = Buffer.from("%PDF-1.7\npapyrus Lifecycle Version 1\n%%EOF\n", "utf8");
      const v1Upload = await uploadAndFinalize("contrato-v1.pdf", v1Payload, "life-upload-v1");

      const createDocRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/documents`,
        cookies: authCookies,
        headers: csrfHeaders,
        payload: {
          title: "Contrato Prestação Serviços 2026",
          categoryId,
          folderId,
          uploadSessionId: v1Upload.sessionId,
          metadata: { fornecedor: "Acme Engenharia Ltda" },
        },
      });
      expect(createDocRes.statusCode).toBe(201);
      const createdBody = createDocRes.json() as {
        data: {
          id: string;
          status: string;
          title: string;
          version: number;
          currentVersionId: string;
        };
        initialVersion: { id: string; versionNumber: number };
      };
      const docId = createdBody.data.id;
      const v1Id = createdBody.initialVersion.id;
      expect(createdBody.data.status).toBe("DRAFT");
      expect(createdBody.initialVersion.versionNumber).toBe(1);

      // 3. Listing on real PostgreSQL returns the document
      const listRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents?search=Contrato&page=1&pageSize=10`,
        cookies: authCookies,
      });
      expect(listRes.statusCode).toBe(200);
      const listJson = listRes.json() as {
        items: Array<{ id: string; title: string }>;
        pagination: { totalItems: number };
      };
      expect(listJson.pagination.totalItems).toBe(1);
      expect(listJson.items[0]?.id).toBe(docId);

      // 4. Document detail returns metadata, permissions, and current version
      const detailRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/${docId}`,
        cookies: authCookies,
      });
      expect(detailRes.statusCode).toBe(200);
      const detailJson = detailRes.json().data as {
        id: string;
        currentVersionId: string;
        permissions: { canDownload: boolean; canUpload: boolean; canDelete: boolean };
      };
      expect(detailJson.currentVersionId).toBe(v1Id);
      expect(detailJson.permissions.canDownload).toBe(true);
      expect(detailJson.permissions.canUpload).toBe(true);
      expect(detailJson.permissions.canDelete).toBe(true);

      // 5. Upload finalized v2 -> Create Version 2 -> Verify version history & both downloadable
      const v2Payload = Buffer.from(
        "%PDF-1.7\npapyrus Lifecycle Version 2 Updated\n%%EOF\n",
        "utf8",
      );
      const v2Upload = await uploadAndFinalize(
        "contrato-v2.pdf",
        v2Payload,
        "life-upload-v2",
        docId,
      );

      const createVerRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/documents/${docId}/versions`,
        cookies: authCookies,
        headers: csrfHeaders,
        payload: {
          expectedVersion: createdBody.data.version,
          uploadSessionId: v2Upload.sessionId,
          changeNote: "Aditivo de prazo assinado",
        },
      });
      expect(createVerRes.statusCode).toBe(201);
      const v2Body = createVerRes.json() as {
        data: { id: string; versionNumber: number };
        document: { id: string; version: number };
      };
      expect(v2Body.data.versionNumber).toBe(2);

      const versionsListRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/${docId}/versions`,
        cookies: authCookies,
      });
      expect(versionsListRes.statusCode).toBe(200);
      const versionsData = versionsListRes.json().data as Array<{
        id: string;
        versionNumber: number;
        isCurrent: boolean;
      }>;
      expect(versionsData.map((v) => v.versionNumber)).toEqual([2, 1]);
      expect(versionsData[0]?.isCurrent).toBe(true);
      expect(versionsData[1]?.isCurrent).toBe(false);

      const downloadCurrentRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/${docId}/download`,
        cookies: authCookies,
      });
      expect(downloadCurrentRes.statusCode).toBe(200);
      expect(downloadCurrentRes.rawPayload.equals(v2Payload)).toBe(true);

      const downloadV1Res = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/${docId}/download?versionId=${v1Id}`,
        cookies: authCookies,
      });
      expect(downloadV1Res.statusCode).toBe(200);
      expect(downloadV1Res.rawPayload.equals(v1Payload)).toBe(true);

      // 6. Trash logical deletion -> concealed from standard listing/detail, visible in trash
      const trashRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/documents/${docId}/trash`,
        cookies: authCookies,
        headers: csrfHeaders,
        payload: {
          expectedVersion: v2Body.document.version,
          reason: "Encerramento contratual",
        },
      });
      expect(trashRes.statusCode).toBe(200);
      const trashedVersion = (trashRes.json().data as { version: number }).version;

      const listAfterTrashRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents`,
        cookies: authCookies,
      });
      expect(listAfterTrashRes.statusCode).toBe(200);
      expect(listAfterTrashRes.json().pagination.totalItems).toBe(0);

      const detailAfterTrashRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/${docId}`,
        cookies: authCookies,
      });
      expect(detailAfterTrashRes.statusCode).toBe(200);
      expect((detailAfterTrashRes.json().data as { status: string }).status).toBe("DELETED");

      const statusDeletedListRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents?status=DELETED`,
        cookies: authCookies,
      });
      expect(statusDeletedListRes.statusCode).toBe(200);
      expect(statusDeletedListRes.json().pagination.totalItems).toBe(0);

      const trashListRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/trash`,
        cookies: authCookies,
      });
      expect(trashListRes.statusCode).toBe(200);
      expect(trashListRes.json().pagination.totalItems).toBe(1);
      expect(trashListRes.json().items[0]?.id).toBe(docId);

      // 7. Restore from trash -> visible again in standard listing and downloadable
      const restoreRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/documents/${docId}/restore`,
        cookies: authCookies,
        headers: csrfHeaders,
        payload: {
          expectedVersion: trashedVersion,
          targetStatus: "DRAFT",
        },
      });
      expect(restoreRes.statusCode).toBe(200);

      const listAfterRestoreRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents`,
        cookies: authCookies,
      });
      expect(listAfterRestoreRes.statusCode).toBe(200);
      expect(listAfterRestoreRes.json().pagination.totalItems).toBe(1);

      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.organizationId, orgId));
      expect(auditRows.some((e) => e.action === "DOCUMENT_CREATED")).toBe(true);
      expect(auditRows.some((e) => e.action === "DOCUMENT_VERSION_CREATED")).toBe(true);
      expect(auditRows.some((e) => e.action === "DOCUMENT_TRASHED")).toBe(true);
      expect(auditRows.some((e) => e.action === "DOCUMENT_RESTORED")).toBe(true);
    } finally {
      await app.close();
    }
  }, 120_000);
});
