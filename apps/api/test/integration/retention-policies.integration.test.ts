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
  createCategoryRepository,
  createDocumentRepository,
  createDocumentRetentionHoldRepository,
  createRetentionPolicyRepository,
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
import { createRetentionGovernanceService } from "@docuflow/domain";
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

describe("Retention policies and legal holds API integration (Step 13.06)", () => {
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

  it("manages configurable retention policies, places/releases document holds, blocks purge when held, and enforces permissions", async () => {
    const db = drizzle(pool);
    const fixedNow = new Date("2026-11-21T12:00:00.000Z");

    const orgId = randomUUID();
    const adminId = randomUUID();
    const viewerId = randomUUID();
    const adminRoleId = randomUUID();
    const viewerRoleId = randomUUID();
    const categoryId = randomUUID();
    const docId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Retenção",
      slug: `ret-${orgId.slice(0, 8)}`,
    });

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword("SenhaRetencao!2026");

    await db.insert(users).values([
      {
        id: adminId,
        organizationId: orgId,
        email: `admin-ret-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Admin Retenção",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: viewerId,
        organizationId: orgId,
        email: `viewer-ret-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Leitor Comum",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(roles).values([
      {
        id: adminRoleId,
        organizationId: orgId,
        key: "admin",
        name: "Administrador",
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

    for (const pair of SYSTEM_ROLE_DEFINITIONS.admin.permissions) {
      await db
        .insert(permissions)
        .values({ id: randomUUID(), action: pair.action, resource: pair.resource })
        .onConflictDoNothing();
    }
    const permRows = await db.select().from(permissions);
    const permMap = new Map(permRows.map((p) => [`${p.action}:${p.resource}`, p.id]));
    for (const pair of SYSTEM_ROLE_DEFINITIONS.admin.permissions) {
      const pid = permMap.get(`${pair.action}:${pair.resource}`);
      if (pid) {
        await db.insert(rolePermissions).values({ roleId: adminRoleId, permissionId: pid });
      }
    }
    for (const pair of SYSTEM_ROLE_DEFINITIONS.viewer.permissions) {
      const pid = permMap.get(`${pair.action}:${pair.resource}`);
      if (pid) {
        await db.insert(rolePermissions).values({ roleId: viewerRoleId, permissionId: pid });
      }
    }

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: adminId,
        roleId: adminRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
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

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos",
      isActive: true,
    });

    await db.insert(documents).values({
      id: docId,
      organizationId: orgId,
      title: "Contrato em Lixeira",
      categoryId,
      status: "DELETED",
      deletedAt: new Date("2026-10-01T00:00:00.000Z"),
      ownerUserId: adminId,
      createdBy: adminId,
      updatedBy: adminId,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });

    const transactions = createTransactionManager(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const categoryRepository = createCategoryRepository(db);
    const retentionService = createRetentionGovernanceService({
      policies: createRetentionPolicyRepository(db),
      holds: createDocumentRetentionHoldRepository(db),
      documents: documentRepository,
      categories: categoryRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
      now: () => fixedNow,
    });

    const sessionStore: SessionStorePort = {
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
    };
    const sessionService = createSessionService({ store: sessionStore });
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
      auditRepository,
      retentionDeps: {
        authzRepository,
        retentionService,
        documentRepository,
      },
    });
    await app.ready();

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";
    const loginAs = async (email: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password: "SenhaRetencao!2026" },
      });
      expect(res.statusCode).toBe(200);
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
      return { [SESSION_COOKIE_NAME]: cookie, [CSRF_COOKIE_NAME]: csrfToken };
    };

    const adminCookies = await loginAs(`admin-ret-${orgId.slice(0, 6)}@docuflow.local`);
    const viewerCookies = await loginAs(`viewer-ret-${orgId.slice(0, 6)}@docuflow.local`);

    // Initially empty (no pre-seeded universal legal timeframes)
    const initialListRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/retention-policies",
      cookies: adminCookies,
    });
    expect(initialListRes.statusCode).toBe(200);
    expect(initialListRes.json().data.items).toEqual([]);

    // Non-admin viewer cannot manage policies or holds (403)
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/retention-policies",
          cookies: viewerCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { name: "Tentativa", retentionDays: 60 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${docId}/retention-holds`,
          cookies: viewerCookies,
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { reason: "Tentativa sem permissão" },
        })
      ).statusCode,
    ).toBe(403);

    // Admin creates configurable policy
    const createPolicyRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/retention-policies",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        name: "Política Interna Contratos",
        categoryId,
        retentionDays: 120,
        trashGraceDays: 30,
        actionOnExpiry: "PURGE",
      },
    });
    expect(createPolicyRes.statusCode).toBe(201);
    const policyId = createPolicyRes.json().data.id as string;

    const patchPolicyRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/retention-policies/${policyId}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { trashGraceDays: 20 },
    });
    expect(patchPolicyRes.statusCode).toBe(200);
    expect(patchPolicyRes.json().data.trashGraceDays).toBe(20);

    // Place legal hold -> blocks purge check with 409 RETENTION_HOLD_ACTIVE
    const holdRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/retention-holds`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { reason: "Preservação por auditoria interna" },
    });
    expect(holdRes.statusCode).toBe(201);
    const holdId = holdRes.json().data.id as string;

    const blockedPurgeRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/purge-check`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(blockedPurgeRes.statusCode).toBe(409);
    expect(blockedPurgeRes.json().error.code).toBe("RETENTION_HOLD_ACTIVE");

    // Release hold -> purge check passes cleanly
    const releaseRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/retention-holds/${holdId}/release`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { releaseReason: "Auditoria concluída" },
    });
    expect(releaseRes.statusCode).toBe(200);

    const eligiblePurgeRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docId}/purge-check`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(eligiblePurgeRes.statusCode).toBe(200);
    expect(eligiblePurgeRes.json().data.eligible).toBe(true);

    await app.close();

    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    const actions = auditRows.map((row) => row.action);
    expect(actions).toContain("RETENTION_POLICY_CREATED");
    expect(actions).toContain("RETENTION_POLICY_UPDATED");
    expect(actions).toContain("RETENTION_HOLD_PLACED");
    expect(actions).toContain("RETENTION_HOLD_RELEASED");
  }, 120_000);
});
