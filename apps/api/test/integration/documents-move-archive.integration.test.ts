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
  createFolderRepository,
  createTransactionManager,
  documents,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@papyrus/database";
import { archiveDocumentUseCase, moveDocumentUseCase } from "@papyrus/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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

describe("Document move and archive permissions, concurrency and audit integration", () => {
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

  it("moves documents across active folders, enforces source & destination permissions, archives valid documents and records audit", async () => {
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
    const collabId = randomUUID();
    const viewerId = randomUUID();
    const collabRoleId = randomUUID();
    const viewerRoleId = randomUUID();
    const categoryId = randomUUID();
    const folderSourceId = randomUUID();
    const folderDestId = randomUUID();
    const folderDeniedId = randomUUID();
    const folderArchivedId = randomUUID();
    const docApprovedId = randomUUID();
    const docInReviewId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Move Archive",
      slug: `org-ma-${orgId.slice(0, 8)}`,
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    const passwordHash = await passwordService.hashPassword("MoveArchive!2026");
    await db.insert(users).values([
      {
        id: collabId,
        organizationId: orgId,
        email: `collab-ma-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Colaborador Move",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: viewerId,
        organizationId: orgId,
        email: `viewer-ma-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Consulta Move",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(roles).values([
      {
        id: collabRoleId,
        organizationId: orgId,
        key: "collaborator",
        name: "Colaborador",
        isSystem: true,
      },
      {
        id: viewerRoleId,
        organizationId: orgId,
        key: "viewer",
        name: "Consulta",
        isSystem: true,
      },
    ]);

    const permMap = new Map<string, string>();
    for (const pair of SYSTEM_ROLE_DEFINITIONS.collaborator.permissions) {
      const k = `${pair.action}:${pair.resource}`;
      let pid = permMap.get(k);
      if (!pid) {
        pid = randomUUID();
        permMap.set(k, pid);
        await db
          .insert(permissions)
          .values({ id: pid, action: pair.action, resource: pair.resource });
      }
      await db.insert(rolePermissions).values({ roleId: collabRoleId, permissionId: pid });
    }
    for (const pair of SYSTEM_ROLE_DEFINITIONS.viewer.permissions) {
      const k = `${pair.action}:${pair.resource}`;
      let pid = permMap.get(k);
      if (!pid) {
        pid = randomUUID();
        permMap.set(k, pid);
        await db
          .insert(permissions)
          .values({ id: pid, action: pair.action, resource: pair.resource });
      }
      await db.insert(rolePermissions).values({ roleId: viewerRoleId, permissionId: pid });
    }

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos",
      isActive: true,
    });

    await db.insert(folders).values([
      {
        id: folderSourceId,
        organizationId: orgId,
        parentId: null,
        name: "Origem",
        materializedPath: `/${folderSourceId}`,
        status: "ACTIVE",
      },
      {
        id: folderDestId,
        organizationId: orgId,
        parentId: null,
        name: "Destino",
        materializedPath: `/${folderDestId}`,
        status: "ACTIVE",
      },
      {
        id: folderDeniedId,
        organizationId: orgId,
        parentId: null,
        name: "Confidencial",
        materializedPath: `/${folderDeniedId}`,
        status: "ACTIVE",
      },
      {
        id: folderArchivedId,
        organizationId: orgId,
        parentId: null,
        name: "Pasta Antiga",
        materializedPath: `/${folderArchivedId}`,
        status: "ARCHIVED",
      },
    ]);

    await db.insert(userRoleScopes).values([
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
        userId: collabId,
        roleId: collabRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderDeniedId,
        effect: "DENY",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: viewerId,
        roleId: viewerRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
    ]);

    await db.insert(documents).values([
      {
        id: docApprovedId,
        organizationId: orgId,
        title: "Contrato Principal",
        categoryId,
        folderId: folderSourceId,
        status: "APPROVED",
        ownerUserId: collabId,
        version: 1,
        createdBy: collabId,
        updatedBy: collabId,
      },
      {
        id: docInReviewId,
        organizationId: orgId,
        title: "Contrato Em Revisão",
        categoryId,
        folderId: folderSourceId,
        status: "IN_REVIEW",
        ownerUserId: collabId,
        version: 1,
        createdBy: collabId,
        updatedBy: collabId,
      },
    ]);

    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const folderRepository = createFolderRepository(db);
    const auditRepository = createAuditRepository(db);
    const transactions = createTransactionManager(db);

    const moveDocumentService = moveDocumentUseCase({
      documents: documentRepository,
      folders: folderRepository,
      transactions,
      audit: auditRepository,
    });
    const archiveDocumentService = archiveDocumentUseCase({
      documents: documentRepository,
      transactions,
      audit: auditRepository,
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
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      documentDeps: {
        authzRepository,
        documentRepository,
        auditRepository,
        moveDocumentService,
        archiveDocumentService,
      },
    });
    await app.ready();

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";

    const collabLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `collab-ma-${orgId.slice(0, 6)}@papyrus.local`,
        password: "MoveArchive!2026",
      },
    });
    const collabCookie =
      collabLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const collabCookies = { [SESSION_COOKIE_NAME]: collabCookie, [CSRF_COOKIE_NAME]: csrfToken };

    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `viewer-ma-${orgId.slice(0, 6)}@papyrus.local`,
        password: "MoveArchive!2026",
      },
    });
    const viewerCookie =
      viewerLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const viewerCookies = { [SESSION_COOKIE_NAME]: viewerCookie, [CSRF_COOKIE_NAME]: csrfToken };

    // 1. Viewer cannot move or archive (403)
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${docApprovedId}/move`,
          cookies: viewerCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { expectedVersion: 1, targetFolderId: folderDestId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${docApprovedId}/archive`,
          cookies: viewerCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);

    // 2. Moving into a folder with explicit DENY fails with 403
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${docApprovedId}/move`,
          cookies: collabCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { expectedVersion: 1, targetFolderId: folderDeniedId },
        })
      ).statusCode,
    ).toBe(403);

    // 3. Moving into an archived folder fails with 409
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${docApprovedId}/move`,
          cookies: collabCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { expectedVersion: 1, targetFolderId: folderArchivedId },
        })
      ).statusCode,
    ).toBe(409);

    // 4. Valid move to active destination updates folderId and optimistic version
    const moveRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docApprovedId}/move`,
      cookies: collabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { expectedVersion: 1, targetFolderId: folderDestId },
    });
    expect(moveRes.statusCode).toBe(200);
    const moveBody = moveRes.json() as { data: { folderId: string | null; version: number } };
    expect(moveBody.data.folderId).toBe(folderDestId);
    expect(moveBody.data.version).toBe(2);

    // 5. Archiving a document IN_REVIEW fails (409)
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${docInReviewId}/archive`,
          cookies: collabCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);

    // 6. Stale expectedVersion on archive fails (409)
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${docApprovedId}/archive`,
          cookies: collabCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);

    // 7. Valid archive updates status to ARCHIVED and writes audit event
    const archiveRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docApprovedId}/archive`,
      cookies: collabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { expectedVersion: 2, reason: "Encerramento do contrato" },
    });
    expect(archiveRes.statusCode).toBe(200);
    const archiveBody = archiveRes.json() as { data: { status: string; version: number } };
    expect(archiveBody.data.status).toBe("ARCHIVED");
    expect(archiveBody.data.version).toBe(3);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.organizationId, orgId));
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["DOCUMENT_MOVED", "DOCUMENT_ARCHIVED"]),
    );

    await app.close();
  }, 60_000);
});
