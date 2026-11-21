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
  createFolderRepository,
  createTransactionManager,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createFolderService } from "@docuflow/domain";
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

describe("Folder CRUD, hierarchy cycle prevention and inherited permissions integration", () => {
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

  it("supports create, list, rename, move with subtree path updates, cycle rejection, archive and inherited permissions", async () => {
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
    const scopedManagerId = randomUUID();
    const roleAdminId = randomUUID();
    const roleDocManagerId = randomUUID();
    const roleViewerId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "DocuFlow Folders Integration Corp",
      slug: `folders-org-${orgId.slice(0, 8)}`,
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
        id: roleDocManagerId,
        organizationId: orgId,
        key: "document_manager",
        name: "Gestor Documental",
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

    const docManagerPermPairs = SYSTEM_ROLE_DEFINITIONS.document_manager.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      docManagerPermPairs.map((permissionId) => ({
        roleId: roleDocManagerId,
        permissionId,
      })),
    );

    const viewerPermPairs = SYSTEM_ROLE_DEFINITIONS.viewer.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      viewerPermPairs.map((permissionId) => ({
        roleId: roleViewerId,
        permissionId,
      })),
    );

    const passwordHash = await passwordService.hashPassword("FoldersTest!2026");
    await db.insert(users).values([
      {
        id: adminUserId,
        organizationId: orgId,
        email: `admin-folders-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Admin Folders",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: scopedManagerId,
        organizationId: orgId,
        email: `scoped-folders-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Scoped Manager",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(userRoleScopes).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: adminUserId,
      roleId: roleAdminId,
      scopeType: "GLOBAL",
      effect: "ALLOW",
    });

    const folderRepository = createFolderRepository(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const folderService = createFolderService({
      folders: folderRepository,
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
      folderDeps: {
        authzRepository,
        folderRepository,
        folderService,
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
        email: `admin-folders-${orgId.slice(0, 6)}@docuflow.local`,
        password: "FoldersTest!2026",
      },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminSession =
      adminLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const adminCookies = { [SESSION_COOKIE_NAME]: adminSession, [CSRF_COOKIE_NAME]: csrfToken };
    const adminCsrf = csrfToken;

    // 1. Admin creates root folders and nested hierarchy
    const rootRes = await app.inject({
      method: "POST",
      url: "/api/v1/folders",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { name: "Operações" },
    });
    expect(rootRes.statusCode).toBe(201);
    const rootFolder = (rootRes.json() as { data: { id: string; materializedPath: string } }).data;
    expect(rootFolder.materializedPath).toBe(`/${rootFolder.id}`);

    const otherRootRes = await app.inject({
      method: "POST",
      url: "/api/v1/folders",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { name: "Arquivo Morto" },
    });
    expect(otherRootRes.statusCode).toBe(201);
    const otherRoot = (otherRootRes.json() as { data: { id: string } }).data;

    const childRes = await app.inject({
      method: "POST",
      url: "/api/v1/folders",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { name: "Contratos", parentId: rootFolder.id },
    });
    expect(childRes.statusCode).toBe(201);
    const childFolder = (childRes.json() as { data: { id: string; materializedPath: string } })
      .data;
    expect(childFolder.materializedPath).toBe(`/${rootFolder.id}/${childFolder.id}`);

    const grandChildRes = await app.inject({
      method: "POST",
      url: "/api/v1/folders",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { name: "Aditivos", parentId: childFolder.id },
    });
    expect(grandChildRes.statusCode).toBe(201);
    const grandChild = (grandChildRes.json() as { data: { id: string; materializedPath: string } })
      .data;
    expect(grandChild.materializedPath).toBe(
      `/${rootFolder.id}/${childFolder.id}/${grandChild.id}`,
    );

    const deniedBranchRes = await app.inject({
      method: "POST",
      url: "/api/v1/folders",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { name: "Confidencial", parentId: rootFolder.id },
    });
    expect(deniedBranchRes.statusCode).toBe(201);
    const deniedBranch = (deniedBranchRes.json() as { data: { id: string } }).data;

    // 2. Duplicate sibling name returns 409
    const duplicateRes = await app.inject({
      method: "POST",
      url: "/api/v1/folders",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { name: "Contratos", parentId: rootFolder.id },
    });
    expect(duplicateRes.statusCode).toBe(409);

    // 3. Hierarchy cycle prevention (self and descendant) returns 409
    const selfCycleRes = await app.inject({
      method: "POST",
      url: `/api/v1/folders/${rootFolder.id}/move`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { targetParentId: rootFolder.id },
    });
    expect(selfCycleRes.statusCode).toBe(409);
    expect(
      (selfCycleRes.json() as { error: { details?: { domainCode?: string } } }).error.details
        ?.domainCode,
    ).toBe("FOLDER_HIERARCHY_CYCLE");

    const descendantCycleRes = await app.inject({
      method: "POST",
      url: `/api/v1/folders/${rootFolder.id}/move`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { targetParentId: grandChild.id },
    });
    expect(descendantCycleRes.statusCode).toBe(409);

    // 4. Moving subtree updates parent and descendants' materializedPath atomically
    const moveRes = await app.inject({
      method: "POST",
      url: `/api/v1/folders/${childFolder.id}/move`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { targetParentId: otherRoot.id },
    });
    expect(moveRes.statusCode).toBe(200);
    const movedChild = (moveRes.json() as { data: { id: string; materializedPath: string } }).data;
    expect(movedChild.materializedPath).toBe(`/${otherRoot.id}/${childFolder.id}`);

    const [updatedGrandChild] = await db
      .select()
      .from(folders)
      .where(eq(folders.id, grandChild.id))
      .limit(1);
    expect(updatedGrandChild?.materializedPath).toBe(
      `/${otherRoot.id}/${childFolder.id}/${grandChild.id}`,
    );

    // Move back under rootFolder so subtree inheritance tests can use rootFolder -> childFolder -> grandChild
    const moveBackRes = await app.inject({
      method: "POST",
      url: `/api/v1/folders/${childFolder.id}/move`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { targetParentId: rootFolder.id },
    });
    expect(moveBackRes.statusCode).toBe(200);

    // 5. Rename folder works
    const renameRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/folders/${grandChild.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: adminCsrf },
      payload: { name: "Aditivos 2026" },
    });
    expect(renameRes.statusCode).toBe(200);
    expect((renameRes.json() as { data: { name: string } }).data.name).toBe("Aditivos 2026");

    // 6. Inherited permissions and explicit DENY override
    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: scopedManagerId,
        roleId: roleDocManagerId,
        scopeType: "FOLDER",
        scopeTargetId: rootFolder.id,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: scopedManagerId,
        roleId: roleViewerId,
        scopeType: "FOLDER",
        scopeTargetId: deniedBranch.id,
        effect: "DENY",
      },
    ]);

    const scopedLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `scoped-folders-${orgId.slice(0, 6)}@docuflow.local`,
        password: "FoldersTest!2026",
      },
    });
    expect(scopedLogin.statusCode).toBe(200);
    const scopedSession =
      scopedLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const scopedCookies = { [SESSION_COOKIE_NAME]: scopedSession, [CSRF_COOKIE_NAME]: csrfToken };
    const scopedCsrf = csrfToken;

    // Scoped user inherits READ/CREATE on grandChild via rootFolder ALLOW
    const inheritedGetRes = await app.inject({
      method: "GET",
      url: `/api/v1/folders/${grandChild.id}`,
      cookies: scopedCookies,
    });
    expect(inheritedGetRes.statusCode).toBe(200);

    const inheritedCreateRes = await app.inject({
      method: "POST",
      url: "/api/v1/folders",
      cookies: scopedCookies,
      headers: { [CSRF_HEADER_NAME]: scopedCsrf },
      payload: { name: "Anexo Herdado", parentId: grandChild.id },
    });
    expect(inheritedCreateRes.statusCode).toBe(201);
    const inheritedChild = (inheritedCreateRes.json() as { data: { id: string } }).data;

    // Explicit DENY on deniedBranch blocks read even with rootFolder ALLOW
    const deniedGetRes = await app.inject({
      method: "GET",
      url: `/api/v1/folders/${deniedBranch.id}`,
      cookies: scopedCookies,
    });
    expect(deniedGetRes.statusCode).toBe(403);

    // Listing only counts and returns authorized folders (rootFolder subtree minus deniedBranch, excluding otherRoot)
    const listScopedRes = await app.inject({
      method: "GET",
      url: "/api/v1/folders",
      cookies: scopedCookies,
    });
    expect(listScopedRes.statusCode).toBe(200);
    const listedIds = (
      listScopedRes.json() as {
        data: { items: Array<{ id: string }>; pagination: { totalItems: number } };
      }
    ).data.items.map((item) => item.id);
    expect(listedIds).toContain(rootFolder.id);
    expect(listedIds).toContain(childFolder.id);
    expect(listedIds).toContain(grandChild.id);
    expect(listedIds).toContain(inheritedChild.id);
    expect(listedIds).not.toContain(deniedBranch.id);
    expect(listedIds).not.toContain(otherRoot.id);

    // Scoped user cannot create at root (no GLOBAL CREATE) or move into otherRoot
    const forbiddenRootCreate = await app.inject({
      method: "POST",
      url: "/api/v1/folders",
      cookies: scopedCookies,
      headers: { [CSRF_HEADER_NAME]: scopedCsrf },
      payload: { name: "Raiz Não Autorizada" },
    });
    expect(forbiddenRootCreate.statusCode).toBe(403);

    const forbiddenMoveOut = await app.inject({
      method: "POST",
      url: `/api/v1/folders/${inheritedChild.id}/move`,
      cookies: scopedCookies,
      headers: { [CSRF_HEADER_NAME]: scopedCsrf },
      payload: { targetParentId: otherRoot.id },
    });
    expect(forbiddenMoveOut.statusCode).toBe(403);

    // 7. Archiving non-leaf blocks, archiving leaf succeeds
    const archiveNonLeafRes = await app.inject({
      method: "POST",
      url: `/api/v1/folders/${grandChild.id}/archive`,
      cookies: scopedCookies,
      headers: { [CSRF_HEADER_NAME]: scopedCsrf },
    });
    expect(archiveNonLeafRes.statusCode).toBe(409);

    const archiveLeafRes = await app.inject({
      method: "POST",
      url: `/api/v1/folders/${inheritedChild.id}/archive`,
      cookies: scopedCookies,
      headers: { [CSRF_HEADER_NAME]: scopedCsrf },
    });
    expect(archiveLeafRes.statusCode).toBe(200);
    expect((archiveLeafRes.json() as { data: { status: string } }).data.status).toBe("ARCHIVED");

    // 8. Audit trail recorded folder mutations
    const recordedAudit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    const actions = recordedAudit.map((row) => row.action);
    expect(actions).toContain("FOLDER_CREATED");
    expect(actions).toContain("FOLDER_RENAMED");
    expect(actions).toContain("FOLDER_MOVED");
    expect(actions).toContain("FOLDER_ARCHIVED");

    await app.close();
  }, 60_000);
});
