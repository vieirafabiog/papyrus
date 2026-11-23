import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  SYSTEM_ROLE_DEFINITIONS,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import {
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createCategoryRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createFolderRepository,
  createStorageConnectionRepository,
  createTransactionManager,
  createUploadSessionRepository,
  createUserRepository,
  documentVersions,
  documents,
  fileObjects,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  uploadSessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import {
  createDocumentUseCase,
  createDocumentVersionUseCase,
  trashDocumentUseCase,
} from "@docuflow/domain";
import { createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
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

describe("Document API authorization, explicit DENY precedence, and tenant isolation integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  let localStorageRoot = "";

  beforeAll(async () => {
    localStorageRoot = await mkdtemp(path.join(os.tmpdir(), "docuflow-doc-authz-"));
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

  it("enforces explicit DENY over inherited ALLOW, role restrictions, and cross-organization isolation across all document endpoints", async () => {
    const db = drizzle(pool);
    const orgAId = randomUUID();
    const orgBId = randomUUID();

    const scopedManagerId = randomUUID();
    const viewerId = randomUUID();
    const orgBAdminId = randomUUID();

    const roleAdminAId = randomUUID();
    const roleViewerAId = randomUUID();
    const roleAdminBId = randomUUID();

    const categoryAId = randomUUID();
    const folderAllowedId = randomUUID();
    const folderDeniedId = randomUUID();
    const storageAId = randomUUID();

    const docAllowedId = randomUUID();
    const docDeniedId = randomUUID();
    const verAllowedId = randomUUID();
    const verDeniedId = randomUUID();
    const fileAllowedId = randomUUID();
    const fileDeniedId = randomUUID();
    const uploadForNewDocId = randomUUID();
    const uploadForDeniedDocId = randomUUID();
    const fileNewDocId = randomUUID();
    const fileVerDeniedId = randomUUID();

    const password = "AuthzCheck!2026";
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
        async revokeAllForUser(uid: string, revokedAt: Date) {
          await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, uid));
        },
      } satisfies SessionStorePort,
    });

    await db.insert(organizations).values([
      { id: orgAId, name: "Org Authz A", slug: `org-a-${orgAId.slice(0, 8)}` },
      { id: orgBId, name: "Org Authz B", slug: `org-b-${orgBId.slice(0, 8)}` },
    ]);

    await db.insert(roles).values([
      { id: roleAdminAId, organizationId: orgAId, key: "admin", name: "Admin", isSystem: true },
      { id: roleViewerAId, organizationId: orgAId, key: "viewer", name: "Viewer", isSystem: true },
      { id: roleAdminBId, organizationId: orgBId, key: "admin", name: "Admin B", isSystem: true },
    ]);

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

    for (const target of [
      { roleId: roleAdminAId, defs: SYSTEM_ROLE_DEFINITIONS.admin.permissions },
      { roleId: roleViewerAId, defs: SYSTEM_ROLE_DEFINITIONS.viewer.permissions },
      { roleId: roleAdminBId, defs: SYSTEM_ROLE_DEFINITIONS.admin.permissions },
    ]) {
      const ids = target.defs
        .map((p) => permByKey.get(`${p.action}:${p.resource}`))
        .filter((id): id is string => id !== undefined);
      await db
        .insert(rolePermissions)
        .values(ids.map((permissionId) => ({ roleId: target.roleId, permissionId })));
    }

    const scopedEmail = `scoped-mgr-${orgAId.slice(0, 6)}@docuflow.local`;
    const viewerEmail = `viewer-${orgAId.slice(0, 6)}@docuflow.local`;
    const orgBEmail = `admin-b-${orgBId.slice(0, 6)}@docuflow.local`;

    await db.insert(users).values([
      {
        id: scopedManagerId,
        organizationId: orgAId,
        email: scopedEmail,
        fullName: "Gestor Com Negação",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: viewerId,
        organizationId: orgAId,
        email: viewerEmail,
        fullName: "Leitor Restrito",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: orgBAdminId,
        organizationId: orgBId,
        email: orgBEmail,
        fullName: "Admin Outra Org",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(categories).values({
      id: categoryAId,
      organizationId: orgAId,
      name: "Operacional",
      isActive: true,
    });

    await db.insert(folders).values([
      {
        id: folderAllowedId,
        organizationId: orgAId,
        parentId: null,
        name: "Pasta Aberta",
        materializedPath: `/${folderAllowedId}`,
        status: "ACTIVE",
      },
      {
        id: folderDeniedId,
        organizationId: orgAId,
        parentId: null,
        name: "Pasta Confidencial",
        materializedPath: `/${folderDeniedId}`,
        status: "ACTIVE",
      },
    ]);

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgAId,
        userId: scopedManagerId,
        roleId: roleAdminAId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgAId,
        userId: scopedManagerId,
        roleId: roleAdminAId,
        scopeType: "FOLDER",
        scopeTargetId: folderDeniedId,
        effect: "DENY",
      },
      {
        id: randomUUID(),
        organizationId: orgAId,
        userId: viewerId,
        roleId: roleViewerAId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgBId,
        userId: orgBAdminId,
        roleId: roleAdminBId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
    ]);

    await db.insert(storageConnections).values({
      id: storageAId,
      organizationId: orgAId,
      name: "Local Authz",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: localStorageRoot },
    });

    const allowedBytes = Buffer.from("%PDF-1.7 allowed doc", "utf8");
    const deniedBytes = Buffer.from("%PDF-1.7 confidential denied doc", "utf8");
    const allowedHash = createHash("sha256").update(allowedBytes).digest("hex");
    const deniedHash = createHash("sha256").update(deniedBytes).digest("hex");
    const allowedKey = `org/${orgAId}/documents/${docAllowedId}/versions/${verAllowedId}/${fileAllowedId}`;
    const deniedKey = `org/${orgAId}/documents/${docDeniedId}/versions/${verDeniedId}/${fileDeniedId}`;

    const localProvider = createLocalStorageProvider({ rootDirectory: localStorageRoot });
    await localProvider.putObject({
      key: { value: allowedKey },
      body: Readable.from(allowedBytes),
      metadata: {
        contentType: "application/pdf",
        contentLength: allowedBytes.length,
        checksumSha256: allowedHash,
      },
    });
    await localProvider.putObject({
      key: { value: deniedKey },
      body: Readable.from(deniedBytes),
      metadata: {
        contentType: "application/pdf",
        contentLength: deniedBytes.length,
        checksumSha256: deniedHash,
      },
    });

    await db.insert(fileObjects).values([
      {
        id: fileAllowedId,
        organizationId: orgAId,
        storageConnectionId: storageAId,
        objectKey: allowedKey,
        originalFileName: "aberto.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: allowedBytes.length,
        checksumSha256: allowedHash,
        status: "AVAILABLE",
      },
      {
        id: fileDeniedId,
        organizationId: orgAId,
        storageConnectionId: storageAId,
        objectKey: deniedKey,
        originalFileName: "confidencial.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: deniedBytes.length,
        checksumSha256: deniedHash,
        status: "AVAILABLE",
      },
      {
        id: fileNewDocId,
        organizationId: orgAId,
        storageConnectionId: storageAId,
        objectKey: `org/${orgAId}/temp/${fileNewDocId}`,
        originalFileName: "novo.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 512,
        checksumSha256: "a".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileVerDeniedId,
        organizationId: orgAId,
        storageConnectionId: storageAId,
        objectKey: `org/${orgAId}/temp/${fileVerDeniedId}`,
        originalFileName: "nova-ver.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 512,
        checksumSha256: "b".repeat(64),
        status: "AVAILABLE",
      },
    ]);

    await db.insert(uploadSessions).values([
      {
        id: uploadForNewDocId,
        organizationId: orgAId,
        userId: scopedManagerId,
        storageConnectionId: storageAId,
        fileObjectId: fileNewDocId,
        declaredSizeBytes: 512,
        declaredContentType: "application/pdf",
        idempotencyKey: "authz-new-doc",
        status: "FINALIZED",
        expiresAt: new Date(Date.now() + 3_600_000),
        finalizedAt: new Date(),
      },
      {
        id: uploadForDeniedDocId,
        organizationId: orgAId,
        userId: scopedManagerId,
        storageConnectionId: storageAId,
        fileObjectId: fileVerDeniedId,
        declaredSizeBytes: 512,
        declaredContentType: "application/pdf",
        idempotencyKey: "authz-denied-ver",
        status: "FINALIZED",
        expiresAt: new Date(Date.now() + 3_600_000),
        finalizedAt: new Date(),
      },
    ]);

    await db.insert(documents).values([
      {
        id: docAllowedId,
        organizationId: orgAId,
        title: "Manual Público Interno",
        categoryId: categoryAId,
        folderId: folderAllowedId,
        status: "APPROVED",
        ownerUserId: scopedManagerId,
        createdBy: scopedManagerId,
        updatedBy: scopedManagerId,
      },
      {
        id: docDeniedId,
        organizationId: orgAId,
        title: "Dossiê Secreto Negado",
        categoryId: categoryAId,
        folderId: folderDeniedId,
        status: "APPROVED",
        ownerUserId: scopedManagerId,
        createdBy: scopedManagerId,
        updatedBy: scopedManagerId,
      },
    ]);

    await db.insert(documentVersions).values([
      {
        id: verAllowedId,
        documentId: docAllowedId,
        versionNumber: 1,
        fileObjectId: fileAllowedId,
        uploadedByUserId: scopedManagerId,
      },
      {
        id: verDeniedId,
        documentId: docDeniedId,
        versionNumber: 1,
        fileObjectId: fileDeniedId,
        uploadedByUserId: scopedManagerId,
      },
    ]);

    await db
      .update(documents)
      .set({ currentVersionId: verAllowedId })
      .where(eq(documents.id, docAllowedId));
    await db
      .update(documents)
      .set({ currentVersionId: verDeniedId })
      .where(eq(documents.id, docDeniedId));

    const transactions = createTransactionManager(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const documentVersionRepository = createDocumentVersionRepository(db);
    const uploadRepository = createUploadSessionRepository(db);
    const storageConnectionsRepo = createStorageConnectionRepository(db);

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", ({ connection }) =>
      createLocalStorageProvider({
        rootDirectory: String(connection.nonSecretConfig.rootDirectory ?? ""),
        fsync: false,
      }),
    );

    const createDocumentService = createDocumentUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      categories: createCategoryRepository(db),
      folders: createFolderRepository(db),
      users: createUserRepository(db),
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
      documentDeps: {
        authzRepository,
        documentRepository,
        auditRepository,
        documentVersionRepository,
        uploadRepository,
        storageConnections: storageConnectionsRepo,
        storageRegistry,
        createDocumentService,
        createDocumentVersionService,
        trashDocumentService,
      },
    });
    await app.ready();

    try {
      const csrfRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
      });
      const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";

      const loginAs = async (email: string) => {
        const res = await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/auth/login`,
          cookies: { [CSRF_COOKIE_NAME]: csrfToken },
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { email, password },
        });
        expect(res.statusCode).toBe(200);
        const sessionCookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
        return { [SESSION_COOKIE_NAME]: sessionCookie, [CSRF_COOKIE_NAME]: csrfToken };
      };

      const scopedCookies = await loginAs(scopedEmail);
      const viewerCookies = await loginAs(viewerEmail);
      const orgBCookies = await loginAs(orgBEmail);
      const csrfHeaders = { [CSRF_HEADER_NAME]: csrfToken };

      // 1. Unauthenticated requests blocked with 401
      expect(
        (await app.inject({ method: "GET", url: `${CONTRACTS_API_PREFIX}/documents` })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedId}`,
          })
        ).statusCode,
      ).toBe(401);

      // 2. Explicit DENY wins over GLOBAL ALLOW in listing count, detail, download, create, version, and trash
      const scopedListRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents`,
        cookies: scopedCookies,
      });
      expect(scopedListRes.statusCode).toBe(200);
      expect(scopedListRes.json().pagination.totalItems).toBe(1);
      expect(scopedListRes.json().items.map((item: { id: string }) => item.id)).toEqual([
        docAllowedId,
      ]);

      expect(
        (
          await app.inject({
            method: "GET",
            url: `${CONTRACTS_API_PREFIX}/documents/${docDeniedId}`,
            cookies: scopedCookies,
          })
        ).statusCode,
      ).toBe(403);

      expect(
        (
          await app.inject({
            method: "GET",
            url: `${CONTRACTS_API_PREFIX}/documents/${docDeniedId}/download`,
            cookies: scopedCookies,
          })
        ).statusCode,
      ).toBe(403);

      expect(
        (
          await app.inject({
            method: "POST",
            url: `${CONTRACTS_API_PREFIX}/documents`,
            cookies: scopedCookies,
            headers: csrfHeaders,
            payload: {
              title: "Bloqueado na Pasta Negada",
              categoryId: categoryAId,
              folderId: folderDeniedId,
              uploadSessionId: uploadForNewDocId,
              metadata: {},
            },
          })
        ).statusCode,
      ).toBe(403);

      expect(
        (
          await app.inject({
            method: "POST",
            url: `${CONTRACTS_API_PREFIX}/documents/${docDeniedId}/versions`,
            cookies: scopedCookies,
            headers: csrfHeaders,
            payload: {
              expectedVersion: 1,
              uploadSessionId: uploadForDeniedDocId,
              changeNote: "Tentativa sem permissão",
            },
          })
        ).statusCode,
      ).toBe(403);

      expect(
        (
          await app.inject({
            method: "POST",
            url: `${CONTRACTS_API_PREFIX}/documents/${docDeniedId}/trash`,
            cookies: scopedCookies,
            headers: csrfHeaders,
            payload: { expectedVersion: 1, reason: "Tentativa indevida" },
          })
        ).statusCode,
      ).toBe(403);

      // 3. Viewer can read/download docAllowed, but cannot mutate (create, version, trash)
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedId}/download`,
            cookies: viewerCookies,
          })
        ).statusCode,
      ).toBe(200);

      expect(
        (
          await app.inject({
            method: "POST",
            url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedId}/trash`,
            cookies: viewerCookies,
            headers: csrfHeaders,
            payload: { expectedVersion: 1 },
          })
        ).statusCode,
      ).toBe(403);

      // 4. Cross-organization isolation: Org B admin sees 0 Org A docs and gets 403/404 on direct IDs
      const orgBListRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents`,
        cookies: orgBCookies,
      });
      expect(orgBListRes.statusCode).toBe(200);
      expect(orgBListRes.json().pagination.totalItems).toBe(0);

      const orgBDetailStatus = (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedId}`,
          cookies: orgBCookies,
        })
      ).statusCode;
      expect([403, 404]).toContain(orgBDetailStatus);

      const orgBTrashStatus = (
        await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedId}/trash`,
          cookies: orgBCookies,
          headers: csrfHeaders,
          payload: { expectedVersion: 1 },
        })
      ).statusCode;
      expect([403, 404]).toContain(orgBTrashStatus);
    } finally {
      await app.close();
    }
  }, 120_000);
});
