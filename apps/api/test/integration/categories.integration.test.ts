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
  createAuditRepository,
  createAuthorizationRepository,
  createCategoryRepository,
  createTransactionManager,
  documents,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createCategoryFieldService, createCategoryService } from "@docuflow/domain";
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

describe("Category CRUD, document-link validation and scoped authorization integration", () => {
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

  it("creates, edits, lists, enforces scope authorization and blocks deactivation when active documents exist", async () => {
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
    const adminUserId = randomUUID();
    const viewerUserId = randomUUID();
    const roleAdminId = randomUUID();
    const roleViewerId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "DocuFlow Categories Corp",
      slug: `cats-org-${orgId.slice(0, 8)}`,
    });

    await db.insert(roles).values([
      {
        id: roleAdminId,
        organizationId: orgId,
        key: "admin",
        name: "Administrador",
        isSystem: true,
      },
      {
        id: roleViewerId,
        organizationId: orgId,
        key: "viewer",
        name: "Consulta",
        isSystem: true,
      },
    ]);

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

    await db.insert(rolePermissions).values(
      allPerms.map((p) => ({
        roleId: roleAdminId,
        permissionId: p.id,
      })),
    );

    const viewerPermIds = SYSTEM_ROLE_DEFINITIONS.viewer.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      viewerPermIds.map((permissionId) => ({
        roleId: roleViewerId,
        permissionId,
      })),
    );

    const passwordHash = await passwordService.hashPassword("CategoriesTest!2026");
    await db.insert(users).values([
      {
        id: adminUserId,
        organizationId: orgId,
        email: `admin-cats-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Admin Categories",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: viewerUserId,
        organizationId: orgId,
        email: `viewer-cats-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Viewer Categories",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: adminUserId,
        roleId: roleAdminId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: viewerUserId,
        roleId: roleViewerId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
    ]);

    const categoryRepository = createCategoryRepository(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const categoryService = createCategoryService({
      categories: categoryRepository,
      transactions: createTransactionManager(db),
      audit: auditRepository,
      generateId: () => randomUUID(),
    });
    const categoryFieldService = createCategoryFieldService({
      categories: categoryRepository,
      transactions: createTransactionManager(db),
      audit: auditRepository,
      generateId: () => randomUUID(),
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
      categoryDeps: {
        authzRepository,
        categoryRepository,
        categoryService,
        categoryFieldService,
      },
    });
    await app.ready();

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `admin-cats-${orgId.slice(0, 6)}@docuflow.local`,
        password: "CategoriesTest!2026",
      },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminSession =
      adminLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const adminCookies = { [SESSION_COOKIE_NAME]: adminSession, [CSRF_COOKIE_NAME]: csrfToken };

    // 1. Create categories and validate duplicate conflict
    const inUseRes = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        name: "Contratos",
        description: "Contratos com fornecedores",
        color: "#00639b",
        icon: "gavel",
      },
    });
    expect(inUseRes.statusCode).toBe(201);
    const inUseCategory = (
      inUseRes.json() as {
        data: { id: string; name: string; color: string | null; isActive: boolean };
      }
    ).data;
    expect(inUseCategory.color).toBe("#00639B");
    expect(inUseCategory.isActive).toBe(true);

    const unusedRes = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        name: "Políticas Internas",
        color: "#2e7d32",
        icon: "policy",
      },
    });
    expect(unusedRes.statusCode).toBe(201);
    const unusedCategory = (unusedRes.json() as { data: { id: string } }).data;

    const duplicateRes = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { name: "Contratos" },
    });
    expect(duplicateRes.statusCode).toBe(409);

    // 2. Edit category
    const editRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${inUseCategory.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        name: "Contratos Comerciais",
        description: "Contratos ativos e aditivos",
        color: "#1565c0",
      },
    });
    expect(editRes.statusCode).toBe(200);
    expect((editRes.json() as { data: { name: string } }).data.name).toBe("Contratos Comerciais");

    // 3. Link an active document to inUseCategory and a DELETED document to unusedCategory
    await db.insert(documents).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        title: "Contrato Principal 2026",
        categoryId: inUseCategory.id,
        folderId: null,
        status: "DRAFT",
        ownerUserId: adminUserId,
        metadata: {},
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        title: "Política Obsoleta Excluída",
        categoryId: unusedCategory.id,
        folderId: null,
        status: "DELETED",
        ownerUserId: adminUserId,
        metadata: {},
      },
    ]);

    // Deactivation via POST /deactivate and PATCH { isActive: false } must be blocked when non-deleted docs exist
    const blockedDeactivateRes = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${inUseCategory.id}/deactivate`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(blockedDeactivateRes.statusCode).toBe(409);
    expect(
      (blockedDeactivateRes.json() as { error: { details?: { domainCode?: string } } }).error
        .details?.domainCode,
    ).toBe("CATEGORY_HAS_EXISTING_DOCUMENTS");

    const blockedPatchDeactivate = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${inUseCategory.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { isActive: false },
    });
    expect(blockedPatchDeactivate.statusCode).toBe(409);

    // unusedCategory only has a DELETED document, so deactivation succeeds
    const deactivateUnusedRes = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${unusedCategory.id}/deactivate`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(deactivateUnusedRes.statusCode).toBe(200);
    expect((deactivateUnusedRes.json() as { data: { isActive: boolean } }).data.isActive).toBe(
      false,
    );

    // 4. Filter active/inactive categories cleanly in PostgreSQL
    const activeOnlyRes = await app.inject({
      method: "GET",
      url: "/api/v1/categories?isActive=true",
      cookies: adminCookies,
    });
    expect(activeOnlyRes.statusCode).toBe(200);
    const activeIds = (
      activeOnlyRes.json() as { data: { items: Array<{ id: string }> } }
    ).data.items.map((item) => item.id);
    expect(activeIds).toEqual([inUseCategory.id]);

    const inactiveOnlyRes = await app.inject({
      method: "GET",
      url: "/api/v1/categories?isActive=false",
      cookies: adminCookies,
    });
    expect(inactiveOnlyRes.statusCode).toBe(200);
    const inactiveIds = (
      inactiveOnlyRes.json() as { data: { items: Array<{ id: string }> } }
    ).data.items.map((item) => item.id);
    expect(inactiveIds).toEqual([unusedCategory.id]);

    // 5. Scope authorization: viewer cannot create/edit/deactivate, and explicit DENY hides category from GET/list
    await db.insert(userRoleScopes).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: viewerUserId,
      roleId: roleViewerId,
      scopeType: "CATEGORY",
      scopeTargetId: unusedCategory.id,
      effect: "DENY",
    });

    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `viewer-cats-${orgId.slice(0, 6)}@docuflow.local`,
        password: "CategoriesTest!2026",
      },
    });
    expect(viewerLogin.statusCode).toBe(200);
    const viewerSession =
      viewerLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const viewerCookies = { [SESSION_COOKIE_NAME]: viewerSession, [CSRF_COOKIE_NAME]: csrfToken };

    const viewerListRes = await app.inject({
      method: "GET",
      url: "/api/v1/categories",
      cookies: viewerCookies,
    });
    expect(viewerListRes.statusCode).toBe(200);
    const viewerListedIds = (
      viewerListRes.json() as { data: { items: Array<{ id: string }> } }
    ).data.items.map((item) => item.id);
    expect(viewerListedIds).toEqual([inUseCategory.id]);

    const viewerDeniedGet = await app.inject({
      method: "GET",
      url: `/api/v1/categories/${unusedCategory.id}`,
      cookies: viewerCookies,
    });
    expect(viewerDeniedGet.statusCode).toBe(403);

    const viewerForbiddenCreate = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      cookies: viewerCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { name: "Sem Permissão" },
    });
    expect(viewerForbiddenCreate.statusCode).toBe(403);

    // 6. Audit events recorded
    const recordedAudit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    const actions = recordedAudit.map((row) => row.action);
    expect(actions).toContain("CATEGORY_CREATED");
    expect(actions).toContain("CATEGORY_UPDATED");
    expect(actions).toContain("CATEGORY_DEACTIVATED");

    await app.close();
  }, 60_000);
});
