import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@papyrus/auth";
import {
  createAuditRepository,
  createTransactionManager,
  createUserRepository,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@papyrus/database";
import { createUserAdministrationService } from "@papyrus/domain";
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

describe("User administration integration", () => {
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

  it("creates, edits, deactivates, reactivates users and prevents deactivating the last active admin", async () => {
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

    const userAdminService = createUserAdministrationService({
      users: createUserRepository(db),
      transactions: createTransactionManager(db),
      audit: createAuditRepository(db),
      passwordHasher: passwordService,
      generateId: () => randomUUID(),
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      setupService,
      authService,
      userAdminService,
    });

    // Bootstrap first admin
    const adminPass = "AdminMasterPassword2026!";
    const bootstrapped = await setupService.bootstrapFirstAdmin(
      {
        organizationName: "Empresa Teste",
        organizationSlug: "empresa-teste",
        email: "admin@teste.invalid",
        fullName: "Admin Principal",
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
      payload: { email: "admin@teste.invalid", password: adminPass },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminCookie = adminLogin.cookies.find((c) => c.name === "papyrus_session")?.value ?? "";

    // Cannot deactivate the last active admin
    const selfDeactivate = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${bootstrapped.adminUserId}/deactivate`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(selfDeactivate.statusCode).toBe(409);

    // Create collaborator user
    const colabPass = "ColabPassword2026!";
    const createColab = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        email: "colab@teste.invalid",
        fullName: "Colaborador Inicial",
        password: colabPass,
      },
    });
    expect(createColab.statusCode).toBe(201);
    const colabId = createColab.json().data.id as string;

    // Non-admin user receives 403 on admin user listing
    const colabLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { email: "colab@teste.invalid", password: colabPass },
    });
    const colabCookie = colabLogin.cookies.find((c) => c.name === "papyrus_session")?.value ?? "";
    const forbiddenList = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      cookies: { papyrus_session: colabCookie },
    });
    expect(forbiddenList.statusCode).toBe(403);

    // Edit, deactivate, and reactivate collaborator
    const editColab = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${colabId}`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { fullName: "Colaborador Renomeado" },
    });
    expect(editColab.statusCode).toBe(200);
    expect(editColab.json().data.fullName).toBe("Colaborador Renomeado");

    const deactivateColab = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${colabId}/deactivate`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(deactivateColab.statusCode).toBe(200);
    expect(deactivateColab.json().data.status).toBe("INACTIVE");

    const reactivateColab = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${colabId}/reactivate`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(reactivateColab.statusCode).toBe(200);
    expect(reactivateColab.json().data.status).toBe("ACTIVE");

    // Promote collaborator to admin -> now first admin can be deactivated, second cannot
    const [adminRole] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.organizationId, bootstrapped.organizationId), eq(roles.key, "admin")))
      .limit(1);
    if (!adminRole) {
      throw new Error("Expected admin role");
    }
    await db.insert(userRoleScopes).values({
      organizationId: bootstrapped.organizationId,
      userId: colabId,
      roleId: adminRole.id,
      scopeType: "GLOBAL",
      scopeTargetId: null,
      effect: "ALLOW",
    });

    const deactivateFirstAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${bootstrapped.adminUserId}/deactivate`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(deactivateFirstAdmin.statusCode).toBe(200);
    expect(deactivateFirstAdmin.json().data.status).toBe("INACTIVE");

    // Now colabId is the last active admin -> must return 409
    const deactivateSecondAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${colabId}/deactivate`,
      cookies: { papyrus_session: colabCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(deactivateSecondAdmin.statusCode).toBe(409);

    await app.close();
  });
});
