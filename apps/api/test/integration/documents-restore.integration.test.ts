import { randomUUID } from "node:crypto";
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
import {
  auditEvents,
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createDocumentRetentionHoldRepository,
  createDocumentTrashRepository,
  createRetentionPolicyRepository,
  createTransactionManager,
  documentVersions,
  documents,
  fileObjects,
  organizations,
  permissions,
  retentionPolicies,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  userRoleScopes,
  users,
} from "@papyrus/database";
import { restoreDocumentUseCase, trashDocumentUseCase } from "@papyrus/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/modules/auth/auth.routes.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Document trash restore window, permissions preservation and audit integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;

  beforeAll(async () => {
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
  });

  it("restores authorized trashed documents within grace window, preserves versions/permissions, audits and rejects expired windows", async () => {
    const db = drizzle(pool);
    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
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

    const orgId = randomUUID();
    const managerId = randomUUID();
    const collabId = randomUUID();
    const deniedAdminId = randomUUID();
    const managerRoleId = randomUUID();
    const collabRoleId = randomUUID();
    const categoryId = randomUUID();
    const deniedCategoryId = randomUUID();
    const storageConnId = randomUUID();
    const fileObjectId1 = randomUUID();
    const fileObjectId2 = randomUUID();
    const restorableDocId = randomUUID();
    const expiredDocId = randomUUID();
    const deniedDocId = randomUUID();
    const verId1 = randomUUID();
    const verId2 = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Restore",
      slug: `org-restore-${orgId.slice(0, 8)}`,
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    const passwordHash = await passwordService.hashPassword("RestoreDocs!2026");
    await db.insert(users).values([
      {
        id: managerId,
        organizationId: orgId,
        email: `manager-restore-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Gestor Restauração",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: collabId,
        organizationId: orgId,
        email: `collab-restore-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Colaborador Sem Permissão",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: deniedAdminId,
        organizationId: orgId,
        email: `denied-restore-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Gestor Com Negação Explícita",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(roles).values([
      {
        id: managerRoleId,
        organizationId: orgId,
        key: "document_manager",
        name: "Gestor documental",
        isSystem: true,
      },
      {
        id: collabRoleId,
        organizationId: orgId,
        key: "collaborator",
        name: "Colaborador",
        isSystem: true,
      },
    ]);

    const permMap = new Map<string, string>();
    for (const pair of SYSTEM_ROLE_DEFINITIONS.document_manager.permissions) {
      const key = `${pair.action}:${pair.resource}`;
      let pid = permMap.get(key);
      if (!pid) {
        pid = randomUUID();
        permMap.set(key, pid);
        await db
          .insert(permissions)
          .values({ id: pid, action: pair.action, resource: pair.resource });
      }
      await db.insert(rolePermissions).values({ roleId: managerRoleId, permissionId: pid });
    }
    for (const pair of SYSTEM_ROLE_DEFINITIONS.collaborator.permissions) {
      const key = `${pair.action}:${pair.resource}`;
      let pid = permMap.get(key);
      if (!pid) {
        pid = randomUUID();
        permMap.set(key, pid);
        await db
          .insert(permissions)
          .values({ id: pid, action: pair.action, resource: pair.resource });
      }
      await db.insert(rolePermissions).values({ roleId: collabRoleId, permissionId: pid });
    }

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: managerId,
        roleId: managerRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: collabId,
        roleId: collabRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: deniedAdminId,
        roleId: managerRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: deniedAdminId,
        roleId: managerRoleId,
        scopeType: "CATEGORY",
        scopeTargetId: deniedCategoryId,
        effect: "DENY",
      },
    ]);

    await db.insert(categories).values([
      {
        id: categoryId,
        organizationId: orgId,
        name: "Políticas Internas",
        isActive: true,
      },
      {
        id: deniedCategoryId,
        organizationId: orgId,
        name: "Auditoria Restrita",
        isActive: true,
      },
    ]);

    const referenceNow = new Date("2026-06-15T12:00:00.000Z");
    await db.insert(retentionPolicies).values({
      id: randomUUID(),
      organizationId: orgId,
      categoryId,
      name: "Janela 7 dias",
      retentionDays: 365,
      trashGraceDays: 7,
      actionOnExpiry: "ARCHIVE",
      isActive: true,
      createdBy: managerId,
      updatedBy: managerId,
    });

    await db.insert(storageConnections).values({
      id: storageConnId,
      organizationId: orgId,
      name: "Local Restore",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/papyrus-restore-test" },
    });

    await db.insert(fileObjects).values([
      {
        id: fileObjectId1,
        organizationId: orgId,
        storageConnectionId: storageConnId,
        objectKey: `org/${orgId}/doc/${restorableDocId}`,
        originalFileName: "manual-compliance.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: "e".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileObjectId2,
        organizationId: orgId,
        storageConnectionId: storageConnId,
        objectKey: `org/${orgId}/doc/${expiredDocId}`,
        originalFileName: "ata-antiga.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: "f".repeat(64),
        status: "AVAILABLE",
      },
    ]);

    await db.insert(documents).values([
      {
        id: restorableDocId,
        organizationId: orgId,
        title: "Manual de Compliance 2026",
        categoryId,
        folderId: null,
        status: "APPROVED",
        ownerUserId: managerId,
        version: 1,
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: expiredDocId,
        organizationId: orgId,
        title: "Ata Expirada na Lixeira",
        categoryId,
        folderId: null,
        status: "DELETED",
        deletedAt: new Date("2026-06-01T10:00:00.000Z"),
        ownerUserId: managerId,
        version: 2,
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: deniedDocId,
        organizationId: orgId,
        title: "Dossiê Restrito na Lixeira",
        categoryId: deniedCategoryId,
        folderId: null,
        status: "DELETED",
        deletedAt: new Date("2026-06-14T10:00:00.000Z"),
        ownerUserId: managerId,
        version: 1,
        createdBy: managerId,
        updatedBy: managerId,
      },
    ]);

    await db.insert(documentVersions).values([
      {
        id: verId1,
        documentId: restorableDocId,
        versionNumber: 1,
        fileObjectId: fileObjectId1,
        uploadedByUserId: managerId,
        changeNote: "Versão inicial",
      },
      {
        id: verId2,
        documentId: expiredDocId,
        versionNumber: 1,
        fileObjectId: fileObjectId2,
        uploadedByUserId: managerId,
        changeNote: "Ata original",
      },
    ]);

    await db
      .update(documents)
      .set({ currentVersionId: verId1 })
      .where(eq(documents.id, restorableDocId));

    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const documentTrashRepository = createDocumentTrashRepository(db);
    const auditRepository = createAuditRepository(db);
    const retentionPoliciesRepo = createRetentionPolicyRepository(db);
    const holdsRepo = createDocumentRetentionHoldRepository(db);
    const transactions = createTransactionManager(db);

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
      now: () => referenceNow,
    });

    const authService = createAuthService({
      users: {
        async findCredentialByEmail(email) {
          const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
          if (!row) {
            return null;
          }
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
        async findProfileById(userId) {
          const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
          if (!row) {
            return null;
          }
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
      passwordService,
      sessionService,
      authzRepository,
      auditRepository,
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      documentDeps: {
        authzRepository,
        documentRepository,
        auditRepository,
        documentTrashRepository,
        trashDocumentService,
        restoreDocumentService,
        trashNow: () => referenceNow,
      },
    });
    await app.ready();

    async function loginAndGetHeaders(email: string): Promise<{
      cookieHeader: string;
      csrfToken: string;
    }> {
      const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
      const csrfToken =
        csrfRes.cookies.find((cookie) => cookie.name === CSRF_COOKIE_NAME)?.value ?? "";
      expect(csrfToken).toBeTruthy();

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password: "RestoreDocs!2026" },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie = loginRes.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
      expect(sessionCookie?.value).toBeTruthy();
      return {
        cookieHeader: `${SESSION_COOKIE_NAME}=${sessionCookie?.value ?? ""}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
        csrfToken,
      };
    }

    const managerAuth = await loginAndGetHeaders(
      `manager-restore-${orgId.slice(0, 6)}@papyrus.local`,
    );
    const collabAuth = await loginAndGetHeaders(
      `collab-restore-${orgId.slice(0, 6)}@papyrus.local`,
    );
    const deniedAuth = await loginAndGetHeaders(
      `denied-restore-${orgId.slice(0, 6)}@papyrus.local`,
    );

    // 1. Manager sends restorable document to trash
    const trashRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${restorableDocId}/trash`,
      headers: {
        cookie: managerAuth.cookieHeader,
        [CSRF_HEADER_NAME]: managerAuth.csrfToken,
      },
      payload: { expectedVersion: 1, reason: "Descarte temporário" },
    });
    expect(trashRes.statusCode).toBe(200);
    // Align deletedAt within referenceNow (1 day before referenceNow)
    await db
      .update(documents)
      .set({ deletedAt: new Date("2026-06-14T12:00:00.000Z") })
      .where(eq(documents.id, restorableDocId));

    // 2. Collaborator without DELETE permission sees empty trash and gets 403 on restore
    const collabTrashRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/trash",
      headers: { cookie: collabAuth.cookieHeader },
    });
    expect(collabTrashRes.statusCode).toBe(200);
    expect(collabTrashRes.json().items).toHaveLength(0);

    const collabRestoreRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${restorableDocId}/restore`,
      headers: {
        cookie: collabAuth.cookieHeader,
        [CSRF_HEADER_NAME]: collabAuth.csrfToken,
      },
      payload: { expectedVersion: 2, targetStatus: "DRAFT" },
    });
    expect(collabRestoreRes.statusCode).toBe(403);

    // 3. Explicit DENY conceals restricted category item from trash listing and blocks restore
    const deniedTrashRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/trash",
      headers: { cookie: deniedAuth.cookieHeader },
    });
    expect(deniedTrashRes.statusCode).toBe(200);
    const deniedIds = deniedTrashRes.json().items.map((item: { id: string }) => item.id);
    expect(deniedIds).not.toContain(deniedDocId);
    expect(deniedIds).toContain(restorableDocId);

    const deniedRestoreRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${deniedDocId}/restore`,
      headers: {
        cookie: deniedAuth.cookieHeader,
        [CSRF_HEADER_NAME]: deniedAuth.csrfToken,
      },
      payload: { expectedVersion: 1, targetStatus: "DRAFT" },
    });
    expect(deniedRestoreRes.statusCode).toBe(403);

    // 4. Manager lists trash and sees canRestore=true for restorableDoc and canRestore=false for expiredDoc
    const managerTrashRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/trash",
      headers: { cookie: managerAuth.cookieHeader },
    });
    expect(managerTrashRes.statusCode).toBe(200);
    const trashItems = managerTrashRes.json().items as Array<{
      id: string;
      canRestore: boolean;
      trashGraceDays: number;
    }>;
    const restorableEntry = trashItems.find((item) => item.id === restorableDocId);
    const expiredEntry = trashItems.find((item) => item.id === expiredDocId);
    expect(restorableEntry?.canRestore).toBe(true);
    expect(restorableEntry?.trashGraceDays).toBe(7);
    expect(expiredEntry?.canRestore).toBe(false);

    // 5. Expired trash window is rejected with 409 RESTORE_WINDOW_EXPIRED
    const expiredRestoreRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${expiredDocId}/restore`,
      headers: {
        cookie: managerAuth.cookieHeader,
        [CSRF_HEADER_NAME]: managerAuth.csrfToken,
      },
      payload: { expectedVersion: 2, targetStatus: "DRAFT" },
    });
    expect(expiredRestoreRes.statusCode).toBe(409);
    expect(expiredRestoreRes.json().error.details.domainCode).toBe("RESTORE_WINDOW_EXPIRED");

    // 6. Stale expectedVersion fails with 409 DOCUMENT_VERSION_CONFLICT
    const staleRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${restorableDocId}/restore`,
      headers: {
        cookie: managerAuth.cookieHeader,
        [CSRF_HEADER_NAME]: managerAuth.csrfToken,
      },
      payload: { expectedVersion: 1, targetStatus: "DRAFT" },
    });
    expect(staleRes.statusCode).toBe(409);
    expect(staleRes.json().error.code).toBe("DOCUMENT_VERSION_CONFLICT");

    // 7. Valid restore recovers document, clears deletedAt, preserves versions & permissions, and records audit
    const restoreRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${restorableDocId}/restore`,
      headers: {
        cookie: managerAuth.cookieHeader,
        [CSRF_HEADER_NAME]: managerAuth.csrfToken,
      },
      payload: {
        expectedVersion: 2,
        targetStatus: "ARCHIVED",
        reason: "Restaurado após revisão da auditoria",
      },
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.json().data.status).toBe("ARCHIVED");
    expect(restoreRes.json().data.version).toBe(3);
    expect(restoreRes.json().data.currentVersionId).toBe(verId1);

    // Verify deletedAt is cleared and versions / scopes remain preserved
    const [dbDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, restorableDocId))
      .limit(1);
    expect(dbDoc?.status).toBe("ARCHIVED");
    expect(dbDoc?.deletedAt).toBeNull();

    const versions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, restorableDocId));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.id).toBe(verId1);

    // Standard document listing includes restored document again
    const activeListRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents",
      headers: { cookie: managerAuth.cookieHeader },
    });
    expect(activeListRes.statusCode).toBe(200);
    const activeIds = activeListRes.json().items.map((item: { id: string }) => item.id);
    expect(activeIds).toContain(restorableDocId);

    // Audit trail records DOCUMENT_RESTORED
    const [restoreAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, orgId),
          eq(auditEvents.resourceId, restorableDocId),
          eq(auditEvents.action, "DOCUMENT_RESTORED"),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);
    expect(restoreAudit).toBeTruthy();
    expect(restoreAudit?.actorUserId).toBe(managerId);
    expect(restoreAudit?.result).toBe("SUCCESS");

    await app.close();
  });
});
