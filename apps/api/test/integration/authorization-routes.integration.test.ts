import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPasswordService,
  createSessionService,
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
} from "@docuflow/auth";
import {
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  folders,
  organizations,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Route and repository authorization integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;

  beforeAll(async () => {
    const externalUrl = process.env["DATABASE_URL"];
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = container.getConnectionUri();
    }

    pool = new Pool({ connectionString });
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

  it("enforces scope authorization before counting, listing, reading, creating, or mutating documents", async () => {
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
    const userId = randomUUID();
    const roleColabId = randomUUID();
    const catPublicId = randomUUID();
    const catRestrictedId = randomUUID();
    const folderRootId = randomUUID();
    const folderRestrictedId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Authz",
      slug: "org-authz",
    });

    const userPassword = "UserAuthzPass2026!";
    const passwordHash = await passwordService.hashPassword(userPassword);
    await db.insert(users).values({
      id: userId,
      organizationId: orgId,
      email: "colab@authz.invalid",
      fullName: "Colaborador Escopo",
      passwordHash,
      status: "ACTIVE",
    });

    await db.insert(roles).values({
      id: roleColabId,
      organizationId: orgId,
      key: "collaborator",
      name: "Colaborador",
      isSystem: true,
    });

    await db.insert(categories).values([
      { id: catPublicId, organizationId: orgId, name: "Geral" },
      { id: catRestrictedId, organizationId: orgId, name: "Diretoria" },
    ]);

    await db.insert(folders).values([
      {
        id: folderRootId,
        organizationId: orgId,
        parentId: null,
        name: "Operacional",
        materializedPath: `/${folderRootId}`,
      },
      {
        id: folderRestrictedId,
        organizationId: orgId,
        parentId: folderRootId,
        name: "Sigiloso",
        materializedPath: `/${folderRootId}/${folderRestrictedId}`,
      },
    ]);

    const docRepo = createDocumentRepository(db);
    const docAllowedId = randomUUID();
    const docInRestrictedFolderId = randomUUID();
    const docDeniedExceptionId = randomUUID();
    const docOtherCategoryId = randomUUID();

    await docRepo.create({
      id: docAllowedId,
      organizationId: orgId,
      title: "Manual Operacional",
      categoryId: catPublicId,
      folderId: folderRootId,
      ownerUserId: userId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
    });
    await docRepo.create({
      id: docInRestrictedFolderId,
      organizationId: orgId,
      title: "Ata Sigilosa",
      categoryId: catPublicId,
      folderId: folderRestrictedId,
      ownerUserId: userId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
    });
    await docRepo.create({
      id: docDeniedExceptionId,
      organizationId: orgId,
      title: "Exceção Bloqueada",
      categoryId: catPublicId,
      folderId: folderRootId,
      ownerUserId: userId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
    });
    await docRepo.create({
      id: docOtherCategoryId,
      organizationId: orgId,
      title: "Relatório Diretoria",
      categoryId: catRestrictedId,
      folderId: null,
      ownerUserId: userId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
    });

    // Grant collaborator on folderRootId, explicit DENY on folderRestrictedId and docDeniedExceptionId
    await db.insert(userRoleScopes).values([
      {
        organizationId: orgId,
        userId,
        roleId: roleColabId,
        scopeType: "FOLDER",
        scopeTargetId: folderRootId,
        effect: "ALLOW",
      },
      {
        organizationId: orgId,
        userId,
        roleId: roleColabId,
        scopeType: "FOLDER",
        scopeTargetId: folderRestrictedId,
        effect: "DENY",
      },
      {
        organizationId: orgId,
        userId,
        roleId: roleColabId,
        scopeType: "DOCUMENT",
        scopeTargetId: docDeniedExceptionId,
        effect: "DENY",
      },
    ]);

    const authService = createAuthService({
      passwordService,
      sessionService,
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
        async findProfileById(id) {
          const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
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
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      documentDeps: {
        authzRepository: createAuthorizationRepository(db),
        documentRepository: docRepo,
        auditRepository: createAuditRepository(db),
      },
    });

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.json().data.csrfToken as string;

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { email: "colab@authz.invalid", password: userPassword },
    });
    const sessionCookie = loginRes.cookies.find((c) => c.name === "docuflow_session")?.value ?? "";

    // 1. Listing counts and returns ONLY the 1 authorized document (no count leak!)
    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents",
      cookies: { docuflow_session: sessionCookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().pagination.totalItems).toBe(1);
    expect(listRes.json().items.map((d: { id: string }) => d.id)).toEqual([docAllowedId]);

    // 2. Reading authorized document succeeds; reading restricted folder / denied doc / other category returns 403
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${docAllowedId}`,
          cookies: { docuflow_session: sessionCookie },
        })
      ).statusCode,
    ).toBe(200);

    for (const deniedId of [docInRestrictedFolderId, docDeniedExceptionId, docOtherCategoryId]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/documents/${deniedId}`,
        cookies: { docuflow_session: sessionCookie },
      });
      expect(res.statusCode).toBe(403);
    }

    // 3. Mutating denied document returns 403
    const patchDenied = await app.inject({
      method: "PATCH",
      url: `/api/v1/documents/${docDeniedExceptionId}`,
      cookies: { docuflow_session: sessionCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { expectedVersion: 1, title: "Tentativa Indevida" },
    });
    expect(patchDenied.statusCode).toBe(403);

    // 4. Creating document in unauthorized folder returns 403
    const createDenied = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      cookies: { docuflow_session: sessionCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        title: "Novo em pasta negada",
        categoryId: catPublicId,
        folderId: folderRestrictedId,
      },
    });
    expect(createDenied.statusCode).toBe(403);

    await app.close();
  });
});
