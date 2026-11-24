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
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  documentTags,
  documents,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  tags,
  userRoleScopes,
  users,
} from "@papyrus/database";
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

describe("Paginated document listing with PostgreSQL filtering, pre-count authz and minimal DTO", () => {
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

  it("filters and paginates in PostgreSQL, enforces authorization before count, and returns minimal DTO without metadata blob", async () => {
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
    const userAId = randomUUID();
    const userBId = randomUUID();
    const roleViewerId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "papyrus Docs List Corp",
      slug: `docs-list-${orgId.slice(0, 8)}`,
    });

    await db.insert(roles).values({
      id: roleViewerId,
      organizationId: orgId,
      key: "viewer",
      name: "Consulta",
      isSystem: true,
    });

    const adminPerms = SYSTEM_ROLE_DEFINITIONS.admin.permissions;
    const insertedPerms = await db
      .insert(permissions)
      .values(
        adminPerms.map((p) => ({
          id: randomUUID(),
          action: p.action,
          resource: p.resource,
        })),
      )
      .onConflictDoNothing()
      .returning();

    const allPerms = insertedPerms.length > 0 ? insertedPerms : await db.select().from(permissions);
    const permByKey = new Map(allPerms.map((p) => [`${p.action}:${p.resource}`, p.id]));
    const viewerPermIds = SYSTEM_ROLE_DEFINITIONS.viewer.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      viewerPermIds.map((permissionId) => ({
        roleId: roleViewerId,
        permissionId,
      })),
    );

    const passwordHash = await passwordService.hashPassword("DocsList!2026");
    await db.insert(users).values([
      {
        id: userAId,
        organizationId: orgId,
        email: `viewer-list-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Viewer A",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: userBId,
        organizationId: orgId,
        email: `owner-list-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Owner B",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    const catPublicId = randomUUID();
    const folderAllowedId = randomUUID();
    const folderDeniedId = randomUUID();
    const tagPriorityId = randomUUID();

    await db.insert(categories).values({
      id: catPublicId,
      organizationId: orgId,
      name: "Contratos",
      isActive: true,
    });

    await db.insert(folders).values([
      {
        id: folderAllowedId,
        organizationId: orgId,
        parentId: null,
        name: "Permitida",
        materializedPath: `/${folderAllowedId}`,
        status: "ACTIVE",
      },
      {
        id: folderDeniedId,
        organizationId: orgId,
        parentId: folderAllowedId,
        name: "Restrita",
        materializedPath: `/${folderAllowedId}/${folderDeniedId}`,
        status: "ACTIVE",
      },
    ]);

    await db.insert(tags).values({
      id: tagPriorityId,
      organizationId: orgId,
      name: "Urgente",
      normalizedName: "urgente",
      createdBy: userAId,
    });

    const doc1Id = randomUUID();
    const doc2Id = randomUUID();
    const doc3Id = randomUUID();
    const docDeniedId = randomUUID();

    await db.insert(documents).values([
      {
        id: doc1Id,
        organizationId: orgId,
        title: "Alfa Contrato 01",
        categoryId: catPublicId,
        folderId: folderAllowedId,
        status: "APPROVED",
        ownerUserId: userAId,
        expirationDate: "2026-06-01",
        metadata: { segredo: "nao-vazar-na-listagem" },
      },
      {
        id: doc2Id,
        organizationId: orgId,
        title: "Beta Contrato 02",
        categoryId: catPublicId,
        folderId: folderAllowedId,
        status: "DRAFT",
        ownerUserId: userBId,
        expirationDate: "2026-08-15",
        metadata: { observacao: "campo-detalhe" },
      },
      {
        id: doc3Id,
        organizationId: orgId,
        title: "Gama Contrato 03",
        categoryId: catPublicId,
        folderId: folderAllowedId,
        status: "APPROVED",
        ownerUserId: userBId,
        expirationDate: "2026-12-20",
        metadata: { valor: 9999 },
      },
      {
        id: docDeniedId,
        organizationId: orgId,
        title: "Delta Restrito 04",
        categoryId: catPublicId,
        folderId: folderDeniedId,
        status: "APPROVED",
        ownerUserId: userBId,
        expirationDate: "2026-06-10",
        metadata: { restrito: true },
      },
    ]);

    await db.insert(documentTags).values([
      { documentId: doc1Id, tagId: tagPriorityId, createdBy: userAId },
      { documentId: doc3Id, tagId: tagPriorityId, createdBy: userAId },
      { documentId: docDeniedId, tagId: tagPriorityId, createdBy: userAId },
    ]);

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: userAId,
        roleId: roleViewerId,
        scopeType: "FOLDER",
        scopeTargetId: folderAllowedId,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: userAId,
        roleId: roleViewerId,
        scopeType: "FOLDER",
        scopeTargetId: folderDeniedId,
        effect: "DENY",
      },
    ]);

    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const auditRepository = createAuditRepository(db);

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
      },
    });
    await app.ready();

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `viewer-list-${orgId.slice(0, 6)}@papyrus.local`,
        password: "DocsList!2026",
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const sessionCookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const cookies = { [SESSION_COOKIE_NAME]: sessionCookie };

    // 1. Authorization BEFORE count: docDeniedId is excluded from totalItems (3, not 4!) and DTO omits metadata
    const page1Res = await app.inject({
      method: "GET",
      url: "/api/v1/documents?sortBy=title&sortDirection=asc&page=1&pageSize=2",
      cookies,
    });
    expect(page1Res.statusCode).toBe(200);
    const page1Body = page1Res.json() as {
      items: Array<Record<string, unknown>>;
      pagination: { totalItems: number; totalPages: number; page: number; pageSize: number };
    };
    expect(page1Body.pagination.totalItems).toBe(3);
    expect(page1Body.pagination.totalPages).toBe(2);
    expect(page1Body.items.map((item) => item.id)).toEqual([doc1Id, doc2Id]);
    for (const item of page1Body.items) {
      expect("metadata" in item).toBe(false);
    }

    // 2. Combined PostgreSQL filters: tagId + status + ownerUserId + expiration range
    const filteredTagRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents?tagId=${tagPriorityId}&status=APPROVED&sortBy=title&sortDirection=asc`,
      cookies,
    });
    expect(filteredTagRes.statusCode).toBe(200);
    const filteredTagBody = filteredTagRes.json() as {
      items: Array<{ id: string }>;
      pagination: { totalItems: number };
    };
    expect(filteredTagBody.pagination.totalItems).toBe(2);
    expect(filteredTagBody.items.map((item) => item.id)).toEqual([doc1Id, doc3Id]);

    const filteredOwnerExpRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents?ownerUserId=${userBId}&expirationFrom=2026-07-01&expirationTo=2026-09-01`,
      cookies,
    });
    expect(filteredOwnerExpRes.statusCode).toBe(200);
    const filteredOwnerExpBody = filteredOwnerExpRes.json() as {
      items: Array<{ id: string }>;
      pagination: { totalItems: number };
    };
    expect(filteredOwnerExpBody.pagination.totalItems).toBe(1);
    expect(filteredOwnerExpBody.items.map((item) => item.id)).toEqual([doc2Id]);

    // 3. Invalid date range returns 400
    const invalidRangeRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents?expirationFrom=2026-10-01&expirationTo=2026-05-01",
      cookies,
    });
    expect(invalidRangeRes.statusCode).toBe(400);

    await app.close();
  }, 60_000);
});
