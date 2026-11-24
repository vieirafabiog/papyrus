import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import {
  createAuditRepository,
  createGroupRepository,
  createTransactionManager,
  createUserRepository,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import {
  createGroupAdministrationService,
  createUserAdministrationService,
} from "@docuflow/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { createDrizzleSetupRepository } from "../../src/modules/setup/setup.repository.js";
import { createSetupService } from "../../src/modules/setup/setup.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Groups and membership integration", () => {
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

  it("creates groups, links users, prevents duplicate memberships, and removes members", async () => {
    const db = drizzle(pool);
    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });

    const sessionStore: SessionStorePort = {
      async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
        const [row] = await db.insert(sessions).values(input).returning();
        if (!row) {
          throw new Error("Session insert failed");
        }
        return row;
      },
      async findByTokenHash(tokenHash: string): Promise<StoredSessionRecord | null> {
        const [row] = await db
          .select()
          .from(sessions)
          .where(eq(sessions.tokenHash, tokenHash))
          .limit(1);
        return row ?? null;
      },
      async revokeById(sessionId: string, revokedAt: Date): Promise<void> {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.id, sessionId));
      },
      async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, userId));
      },
    };

    const sessionService = createSessionService({ store: sessionStore });
    const setupService = createSetupService({
      repository: createDrizzleSetupRepository(db),
      passwordService,
    });

    const authService = createAuthService({
      passwordService,
      sessionService,
      users: {
        async findCredentialByEmail(normalizedEmail: string) {
          const [row] = await db
            .select()
            .from(users)
            .where(eq(users.email, normalizedEmail))
            .limit(1);
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
        async findProfileById(userId: string) {
          const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
          if (!row) {
            return null;
          }
          const assignedRoles = await db
            .select({
              id: roles.id,
              key: roles.key,
              name: roles.name,
              description: roles.description,
              isSystem: roles.isSystem,
            })
            .from(userRoleScopes)
            .innerJoin(roles, eq(roles.id, userRoleScopes.roleId))
            .where(and(eq(userRoleScopes.userId, userId), eq(userRoleScopes.effect, "ALLOW")));
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
            roles: assignedRoles,
            permissions: [],
          };
        },
      },
    });

    const userRepo = createUserRepository(db);
    const txManager = createTransactionManager(db);
    const auditRepo = createAuditRepository(db);

    const userAdminService = createUserAdministrationService({
      users: userRepo,
      transactions: txManager,
      audit: auditRepo,
      passwordHasher: passwordService,
      generateId: () => randomUUID(),
    });

    const groupAdminService = createGroupAdministrationService({
      groups: createGroupRepository(db),
      users: userRepo,
      transactions: txManager,
      audit: auditRepo,
      generateId: () => randomUUID(),
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      setupService,
      authService,
      userAdminService,
      groupAdminService,
    });

    const adminPass = "AdminGroupPassword2026!";
    await setupService.bootstrapFirstAdmin(
      {
        organizationName: "Empresa Grupos",
        organizationSlug: "empresa-grupos",
        email: "admin@grupos.invalid",
        fullName: "Admin Grupos",
        password: adminPass,
      },
      randomUUID(),
    );

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.json().data.csrfToken as string;

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { email: "admin@grupos.invalid", password: adminPass },
    });
    const adminCookie = adminLogin.cookies.find((c) => c.name === "docuflow_session")?.value ?? "";

    const createUserRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: "juridico@grupos.invalid",
        fullName: "Analista Jurídico",
        password: "JuridicoPassword2026!",
      },
    });
    const targetUserId = createUserRes.json().data.id as string;

    // Create group
    const createGroupRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/groups",
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { name: "Jurídico", description: "Equipe de revisão contratual" },
    });
    expect(createGroupRes.statusCode).toBe(201);
    const groupId = createGroupRes.json().data.id as string;

    // Duplicate group name returns 409
    const dupGroupRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/groups",
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { name: "Jurídico" },
    });
    expect(dupGroupRes.statusCode).toBe(409);

    // Link user to group
    const addMemberRes = await app.inject({
      method: "POST",
      url: `/api/v1/admin/groups/${groupId}/members`,
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { userId: targetUserId },
    });
    expect(addMemberRes.statusCode).toBe(201);

    // Duplicate membership returns 409
    const dupMemberRes = await app.inject({
      method: "POST",
      url: `/api/v1/admin/groups/${groupId}/members`,
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { userId: targetUserId },
    });
    expect(dupMemberRes.statusCode).toBe(409);

    // List members
    const listMembersRes = await app.inject({
      method: "GET",
      url: `/api/v1/admin/groups/${groupId}/members`,
      cookies: { docuflow_session: adminCookie },
    });
    expect(listMembersRes.statusCode).toBe(200);
    expect(listMembersRes.json().data).toHaveLength(1);
    expect(listMembersRes.json().data[0].id).toBe(targetUserId);

    // Remove member
    const removeMemberRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/groups/${groupId}/members/${targetUserId}`,
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(removeMemberRes.statusCode).toBe(200);

    await app.close();
  });
});
