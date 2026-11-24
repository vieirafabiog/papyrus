import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@papyrus/auth";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import {
  createAuditRepository,
  createStorageConnectionRepository,
  createTransactionManager,
  createUserRepository,
  fileObjects,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@papyrus/database";
import {
  createStorageConnectionAdminService,
  createUserAdministrationService,
} from "@papyrus/domain";
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
import { createLocalStorageHealthTester } from "../../src/modules/storage/storage-health.adapter.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Local storage administrative routes integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  const tempDirs: string[] = [];

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
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("exposes local storage listing, registration, health check, and default selection for admins only", async () => {
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

    const auditRepository = createAuditRepository(db);
    const transactions = createTransactionManager(db);
    const userAdminService = createUserAdministrationService({
      users: createUserRepository(db),
      transactions,
      audit: auditRepository,
      passwordHasher: passwordService,
      generateId: () => randomUUID(),
    });
    const storageAdminService = createStorageConnectionAdminService({
      connections: createStorageConnectionRepository(db),
      transactions,
      audit: auditRepository,
      healthTester: createLocalStorageHealthTester(),
      generateId: () => randomUUID(),
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      setupService,
      authService,
      userAdminService,
      storageAdminService,
    });

    // Bootstrap first admin and create a non-admin regular user
    const adminPass = "AdminStoragePass2026!";
    const bootstrapped = await setupService.bootstrapFirstAdmin(
      {
        organizationName: "Empresa Storage",
        organizationSlug: "empresa-storage",
        email: "admin@storage.invalid",
        fullName: "Admin Storage",
        password: adminPass,
      },
      randomUUID(),
    );

    const regularUser = await userAdminService.createUser({
      organizationId: bootstrapped.organizationId,
      actorUserId: bootstrapped.adminUserId,
      requestId: randomUUID(),
      email: "colab@storage.invalid",
      fullName: "Colaborador Comum",
      password: "ColabStoragePass2026!",
    });

    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    const csrfToken = csrfRes.json().data.csrfToken as string;

    const login = async (email: string, password: string): Promise<string> => {
      const res = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password },
      });
      expect(res.statusCode).toBe(200);
      return res.cookies.find((c) => c.name === "papyrus_session")?.value ?? "";
    };

    const adminCookie = await login("admin@storage.invalid", adminPass);
    const collabCookie = await login("colab@storage.invalid", "ColabStoragePass2026!");

    const storageDirPrimary = await mkdtemp(path.join(os.tmpdir(), "papyrus-api-storage-1-"));
    const storageDirSecondary = await mkdtemp(path.join(os.tmpdir(), "papyrus-api-storage-2-"));
    tempDirs.push(storageDirPrimary, storageDirSecondary);

    // 1. Unauthenticated and non-admin requests are blocked (401 / 403)
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
        })
      ).statusCode,
    ).toBe(401);

    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
          cookies: { papyrus_session: collabCookie },
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
          cookies: { papyrus_session: collabCookie, [CSRF_COOKIE_NAME]: csrfToken },
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: {
            name: "Tentativa Não Autorizada",
            rootDirectory: storageDirPrimary,
          },
        })
      ).statusCode,
    ).toBe(403);

    // 2. Admin creates two local storage connections (primary as default)
    const createPrimaryRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        name: "Volume Local Primário",
        rootDirectory: storageDirPrimary,
        isDefault: true,
      },
    });
    expect(createPrimaryRes.statusCode).toBe(201);
    const primaryConn = createPrimaryRes.json().data as {
      id: string;
      name: string;
      kind: string;
      isDefault: boolean;
      status: string;
    };
    expect(primaryConn.kind).toBe("local");
    expect(primaryConn.isDefault).toBe(true);

    const createSecondaryRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        name: "Volume Local Secundário",
        rootDirectory: storageDirSecondary,
        isDefault: false,
      },
    });
    expect(createSecondaryRes.statusCode).toBe(201);
    const secondaryId = createSecondaryRes.json().data.id as string;

    // 3. Health check succeeds on real filesystem directory and persists result without exposing host path in message
    const healthRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections/${primaryConn.id}/test`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().data.health.healthy).toBe(true);
    expect(healthRes.json().data.health.message).not.toContain(storageDirPrimary);
    expect(healthRes.json().data.connection.lastHealthCheckAt).toBeTruthy();

    // Missing directory reports unhealthy cleanly
    const badPathRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        name: "Volume Inexistente",
        rootDirectory: path.join(os.tmpdir(), "papyrus-missing-health-dir-987654"),
      },
    });
    expect(badPathRes.statusCode).toBe(201);
    const badConnId = badPathRes.json().data.id as string;

    const badHealthRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections/${badConnId}/test`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(badHealthRes.statusCode).toBe(200);
    expect(badHealthRes.json().data.health.healthy).toBe(false);
    expect(badHealthRes.json().data.connection.status).toBe("ERROR");

    // 4. Switch default destination to secondary connection and list all connections
    const setDefaultRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections/${secondaryId}/default`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(setDefaultRes.statusCode).toBe(200);
    expect(setDefaultRes.json().data.isDefault).toBe(true);

    const listRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
      cookies: { papyrus_session: adminCookie },
    });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json().data as Array<{ id: string; isDefault: boolean }>;
    expect(listed).toHaveLength(3);
    expect(listed.find((c) => c.id === primaryConn.id)?.isDefault).toBe(false);
    expect(listed.find((c) => c.id === secondaryId)?.isDefault).toBe(true);

    // 5. Deactivating a connection that has linked file objects returns 409 Conflict
    await db.insert(fileObjects).values({
      organizationId: bootstrapped.organizationId,
      storageConnectionId: primaryConn.id,
      objectKey: `org/${bootstrapped.organizationId}/documents/${regularUser.id}/versions/${randomUUID()}/${randomUUID()}`,
      originalFileName: "contrato.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 128,
      checksumSha256: "a".repeat(64),
      status: "AVAILABLE",
    });

    const blockedDeactivateRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections/${primaryConn.id}/deactivate`,
      cookies: { papyrus_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(blockedDeactivateRes.statusCode).toBe(409);

    await app.close();
  });
});
