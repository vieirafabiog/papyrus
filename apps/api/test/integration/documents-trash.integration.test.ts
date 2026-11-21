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
} from "@docuflow/auth";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createTransactionManager,
  documentVersions,
  documents,
  fileObjects,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { trashDocumentUseCase } from "@docuflow/domain";
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

describe("Logical document trash authorization, listing concealment and history preservation integration", () => {
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

  it("enforces DELETE permission, marks DELETED, hides from standard listings, and preserves versions & audit", async () => {
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
    const managerRoleId = randomUUID();
    const collabRoleId = randomUUID();
    const categoryId = randomUUID();
    const storageConnId = randomUUID();
    const fileObjectId = randomUUID();
    const docId = randomUUID();
    const verId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Trash",
      slug: `org-trash-${orgId.slice(0, 8)}`,
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    const passwordHash = await passwordService.hashPassword("TrashDocs!2026");
    await db.insert(users).values([
      {
        id: managerId,
        organizationId: orgId,
        email: `manager-trash-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Gestor Lixeira",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: collabId,
        organizationId: orgId,
        email: `collab-trash-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Colaborador Sem Delete",
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
      const k = `${pair.action}:${pair.resource}`;
      let pid = permMap.get(k);
      if (!pid) {
        pid = randomUUID();
        permMap.set(k, pid);
        await db
          .insert(permissions)
          .values({ id: pid, action: pair.action, resource: pair.resource });
      }
      await db.insert(rolePermissions).values({ roleId: managerRoleId, permissionId: pid });
    }
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
    ]);

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos",
      isActive: true,
    });

    await db.insert(storageConnections).values({
      id: storageConnId,
      organizationId: orgId,
      name: "Local Trash",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/docuflow-trash-test" },
    });

    await db.insert(fileObjects).values({
      id: fileObjectId,
      organizationId: orgId,
      storageConnectionId: storageConnId,
      objectKey: `org/${orgId}/doc/${docId}`,
      originalFileName: "contrato.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: "d".repeat(64),
      status: "AVAILABLE",
    });

    await db.insert(documents).values({
      id: docId,
      organizationId: orgId,
      title: "Contrato Obsoleto",
      categoryId,
      folderId: null,
      status: "APPROVED",
      ownerUserId: managerId,
      version: 1,
      createdBy: managerId,
      updatedBy: managerId,
    });

    await db.insert(documentVersions).values({
      id: verId,
      documentId: docId,
      versionNumber: 1,
      fileObjectId,
      uploadedByUserId: managerId,
      changeNote: "Versão 1",
    });

    await db.update(documents).set({ currentVersionId: verId }).where(eq(documents.id, docId));

    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const auditRepository = createAuditRepository(db);
    const trashDocumentService = trashDocumentUseCase({
      documents: documentRepository,
      transactions: createTransactionManager(db),
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
        trashDocumentService,
      },
    });
    await app.ready();

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";

    const managerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `manager-trash-${orgId.slice(0, 6)}@docuflow.local`,
        password: "TrashDocs!2026",
      },
    });
    const managerCookie =
      managerLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const managerCookies = { [SESSION_COOKIE_NAME]: managerCookie, [CSRF_COOKIE_NAME]: csrfToken };

    const collabLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `collab-trash-${orgId.slice(0, 6)}@docuflow.local`,
        password: "TrashDocs!2026",
      },
    });
    const collabCookie =
      collabLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const collabCookies = { [SESSION_COOKIE_NAME]: collabCookie, [CSRF_COOKIE_NAME]: csrfToken };

    // 1. Collaborator without DELETE permission receives 403
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${docId}/trash`,
          cookies: collabCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);

    // 2. Visible in standard listing before trash
    const beforeList = await app.inject({
      method: "GET",
      url: "/api/v1/documents",
      cookies: managerCookies,
    });
    expect(beforeList.statusCode).toBe(200);
    expect((beforeList.json() as { items: unknown[] }).items).toHaveLength(1);

    // 3. Authorized manager sends document to logical trash
    const trashRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/trash`,
      cookies: managerCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { expectedVersion: 1, reason: "Substituído" },
    });
    expect(trashRes.statusCode).toBe(200);
    expect((trashRes.json() as { data: { status: string; version: number } }).data).toMatchObject({
      status: "DELETED",
      version: 2,
    });

    // 4. Hidden from standard listings (even with ?status=DELETED)
    const afterList = await app.inject({
      method: "GET",
      url: "/api/v1/documents",
      cookies: managerCookies,
    });
    expect((afterList.json() as { items: unknown[] }).items).toHaveLength(0);

    const statusQueryList = await app.inject({
      method: "GET",
      url: "/api/v1/documents?status=DELETED",
      cookies: managerCookies,
    });
    expect((statusQueryList.json() as { items: unknown[] }).items).toHaveLength(0);

    // 5. Versions and audit history remain preserved in PostgreSQL
    const [dbDoc] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(dbDoc?.status).toBe("DELETED");
    expect(dbDoc?.deletedAt).not.toBeNull();

    const versionsInDb = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, docId));
    expect(versionsInDb).toHaveLength(1);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.organizationId, orgId));
    expect(events.map((e) => e.action)).toContain("DOCUMENT_TRASHED");

    await app.close();
  }, 60_000);
});
