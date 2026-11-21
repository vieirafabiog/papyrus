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
  createTagRepository,
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
import { createTagService } from "@docuflow/domain";
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

describe("Tags creation, document association, uniqueness and authorization integration", () => {
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

  it("creates unique tags, attaches and detaches them on authorized documents, and blocks unauthorized actors", async () => {
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
    const otherOrgId = randomUUID();
    const colabUserId = randomUUID();
    const viewerUserId = randomUUID();
    const roleColabId = randomUUID();
    const roleViewerId = randomUUID();

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "DocuFlow Tags Corp",
        slug: `tags-org-${orgId.slice(0, 8)}`,
      },
      {
        id: otherOrgId,
        name: "Other Org",
        slug: `other-tags-${otherOrgId.slice(0, 8)}`,
      },
    ]);

    await db.insert(roles).values([
      {
        id: roleColabId,
        organizationId: orgId,
        key: "collaborator",
        name: "Colaborador",
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

    const colabPermIds = SYSTEM_ROLE_DEFINITIONS.collaborator.permissions
      .map((p) => permByKey.get(`${p.action}:${p.resource}`))
      .filter((id): id is string => id !== undefined);
    await db.insert(rolePermissions).values(
      colabPermIds.map((permissionId) => ({
        roleId: roleColabId,
        permissionId,
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

    const passwordHash = await passwordService.hashPassword("TagsTest!2026");
    await db.insert(users).values([
      {
        id: colabUserId,
        organizationId: orgId,
        email: `colab-tags-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Collaborator Tags",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: viewerUserId,
        organizationId: orgId,
        email: `viewer-tags-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Viewer Tags",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    const catId = randomUUID();
    const otherCatId = randomUUID();
    await db.insert(categories).values([
      { id: catId, organizationId: orgId, name: "Jurídico" },
      { id: otherCatId, organizationId: otherOrgId, name: "Externa" },
    ]);

    const docAllowedId = randomUUID();
    const docDeniedId = randomUUID();
    await db.insert(documents).values([
      {
        id: docAllowedId,
        organizationId: orgId,
        title: "Minuta Contratual",
        categoryId: catId,
        folderId: null,
        status: "DRAFT",
        ownerUserId: colabUserId,
        metadata: {},
      },
      {
        id: docDeniedId,
        organizationId: orgId,
        title: "Acordo Confidencial",
        categoryId: catId,
        folderId: null,
        status: "DRAFT",
        ownerUserId: colabUserId,
        metadata: {},
      },
    ]);

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: colabUserId,
        roleId: roleColabId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: colabUserId,
        roleId: roleColabId,
        scopeType: "DOCUMENT",
        scopeTargetId: docDeniedId,
        effect: "DENY",
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

    const tagRepository = createTagRepository(db);
    const documentRepository = createDocumentRepository(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const tagService = createTagService({
      tags: tagRepository,
      documents: documentRepository,
      transactions: createTransactionManager(db),
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const foreignTag = await tagRepository.create({
      id: randomUUID(),
      organizationId: otherOrgId,
      name: "Externa",
      normalizedName: "externa",
      color: null,
      createdBy: colabUserId,
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
      tagDeps: {
        authzRepository,
        documentRepository,
        tagService,
      },
    });
    await app.ready();

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const colabLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `colab-tags-${orgId.slice(0, 6)}@docuflow.local`,
        password: "TagsTest!2026",
      },
    });
    expect(colabLogin.statusCode).toBe(200);
    const colabSession =
      colabLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const colabCookies = { [SESSION_COOKIE_NAME]: colabSession, [CSRF_COOKIE_NAME]: csrfToken };

    // 1. Create tags and enforce case-insensitive uniqueness per organization
    const tagRes = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      cookies: colabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { name: "Prioritário", color: "#c62828" },
    });
    expect(tagRes.statusCode).toBe(201);
    const tag = (tagRes.json() as { data: { id: string; normalizedName: string } }).data;
    expect(tag.normalizedName).toBe("prioritário");

    const dupTagRes = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      cookies: colabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { name: "  PRIORITÁRIO " },
    });
    expect(dupTagRes.statusCode).toBe(409);

    const listTagsRes = await app.inject({
      method: "GET",
      url: "/api/v1/tags?search=priorit",
      cookies: colabCookies,
    });
    expect(listTagsRes.statusCode).toBe(200);
    const listedTags = (listTagsRes.json() as { data: { items: Array<{ id: string }> } }).data
      .items;
    expect(listedTags.map((item) => item.id)).toEqual([tag.id]);

    // 2. Attach tag to authorized document, reject duplicate attach & cross-org tag
    const attachRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docAllowedId}/tags`,
      cookies: colabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { tagId: tag.id },
    });
    expect(attachRes.statusCode).toBe(201);
    expect((attachRes.json() as { data: Array<{ id: string }> }).data.map((t) => t.id)).toEqual([
      tag.id,
    ]);

    const dupAttachRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docAllowedId}/tags`,
      cookies: colabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { tagId: tag.id },
    });
    expect(dupAttachRes.statusCode).toBe(409);

    const crossOrgAttachRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docAllowedId}/tags`,
      cookies: colabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { tagId: foreignTag.id },
    });
    expect(crossOrgAttachRes.statusCode).toBe(404);

    // 3. Explicit DENY on docDeniedId blocks reading and attaching tags
    const deniedListRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docDeniedId}/tags`,
      cookies: colabCookies,
    });
    expect(deniedListRes.statusCode).toBe(403);

    const deniedAttachRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docDeniedId}/tags`,
      cookies: colabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { tagId: tag.id },
    });
    expect(deniedAttachRes.statusCode).toBe(403);

    // 4. Viewer can read tags and document tags, but cannot create, attach or detach
    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: `viewer-tags-${orgId.slice(0, 6)}@docuflow.local`,
        password: "TagsTest!2026",
      },
    });
    expect(viewerLogin.statusCode).toBe(200);
    const viewerSession =
      viewerLogin.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
    const viewerCookies = { [SESSION_COOKIE_NAME]: viewerSession, [CSRF_COOKIE_NAME]: csrfToken };

    const viewerDocTags = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docAllowedId}/tags`,
      cookies: viewerCookies,
    });
    expect(viewerDocTags.statusCode).toBe(200);
    expect((viewerDocTags.json() as { data: Array<{ id: string }> }).data).toHaveLength(1);

    const viewerCreateTag = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      cookies: viewerCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { name: "Bloqueado" },
    });
    expect(viewerCreateTag.statusCode).toBe(403);

    const viewerDetachTag = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${docAllowedId}/tags/${tag.id}`,
      cookies: viewerCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(viewerDetachTag.statusCode).toBe(403);

    // 5. Collaborator detaches tag cleanly
    const detachRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/documents/${docAllowedId}/tags/${tag.id}`,
      cookies: colabCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(detachRes.statusCode).toBe(204);

    const afterDetach = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docAllowedId}/tags`,
      cookies: colabCookies,
    });
    expect(afterDetach.statusCode).toBe(200);
    expect((afterDetach.json() as { data: unknown[] }).data).toEqual([]);

    const recordedAudit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    const actions = recordedAudit.map((row) => row.action);
    expect(actions).toContain("TAG_CREATED");
    expect(actions).toContain("DOCUMENT_TAG_ATTACHED");
    expect(actions).toContain("DOCUMENT_TAG_DETACHED");

    await app.close();
  }, 60_000);
});
