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
  createOrganizationRepository,
  createTransactionManager,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createOrganizationService } from "@docuflow/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, desc, eq } from "drizzle-orm";
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

describe("Organization data and preferences API integration (Step 14.01)", () => {
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

  it("reads and updates organization identity, locale, timezone, and allowed preferences with authorization and audit", async () => {
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
    const adminId = randomUUID();
    const readOnlyId = randomUUID();
    const collabId = randomUUID();
    const adminRoleId = randomUUID();
    const readOnlyRoleId = randomUUID();
    const collabRoleId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Empresa Inicial Ltda",
      slug: `empresa-${orgId.slice(0, 8)}`,
      defaultLanguage: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    const passwordHash = await passwordService.hashPassword("OrgPrefs!2026");
    await db.insert(users).values([
      {
        id: adminId,
        organizationId: orgId,
        email: `admin-org-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Administrador Organização",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: readOnlyId,
        organizationId: orgId,
        email: `reader-org-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Auditor Organização",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: collabId,
        organizationId: orgId,
        email: `collab-org-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Colaborador Comum",
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
        id: readOnlyRoleId,
        organizationId: orgId,
        key: "org_reader",
        name: "Leitor Organização",
        isSystem: false,
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
    const ensurePermission = async (
      action: (typeof SYSTEM_ROLE_DEFINITIONS.admin.permissions)[number]["action"],
      resource: (typeof SYSTEM_ROLE_DEFINITIONS.admin.permissions)[number]["resource"],
    ): Promise<string> => {
      const key = `${action}:${resource}`;
      const existing = permMap.get(key);
      if (existing) {
        return existing;
      }
      const id = randomUUID();
      permMap.set(key, id);
      await db.insert(permissions).values({ id, action, resource });
      return id;
    };

    for (const pair of SYSTEM_ROLE_DEFINITIONS.admin.permissions) {
      const pid = await ensurePermission(pair.action, pair.resource);
      await db.insert(rolePermissions).values({ roleId: adminRoleId, permissionId: pid });
    }
    for (const pair of SYSTEM_ROLE_DEFINITIONS.collaborator.permissions) {
      const pid = await ensurePermission(pair.action, pair.resource);
      await db.insert(rolePermissions).values({ roleId: collabRoleId, permissionId: pid });
    }
    const readOrgPermId = await ensurePermission("READ", "ORGANIZATION");
    await db
      .insert(rolePermissions)
      .values({ roleId: readOnlyRoleId, permissionId: readOrgPermId });

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
        userId: readOnlyId,
        roleId: readOnlyRoleId,
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

    const authzRepository = createAuthorizationRepository(db);
    const auditRepository = createAuditRepository(db);
    const organizationService = createOrganizationService({
      organizations: createOrganizationRepository(db),
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
      authzRepository,
      auditRepository,
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      organizationDeps: {
        authzRepository,
        organizationService,
      },
    });
    await app.ready();

    async function loginAndGetHeaders(email: string): Promise<{
      cookieHeader: string;
      csrfToken: string;
    }> {
      const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
      const csrfToken =
        csrfRes.cookies.find((cookie) => cookie.name === CSRF_COOKIE_NAME)?.value ?? "";
      expect(csrfToken).toBeTruthy();

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password: "OrgPrefs!2026" },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie = loginRes.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
      return {
        cookieHeader: `${SESSION_COOKIE_NAME}=${sessionCookie?.value ?? ""}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
        csrfToken,
      };
    }

    // 1. Unauthenticated access returns 401
    const unauthRes = await app.inject({ method: "GET", url: "/api/v1/organization" });
    expect(unauthRes.statusCode).toBe(401);

    const adminAuth = await loginAndGetHeaders(`admin-org-${orgId.slice(0, 6)}@docuflow.local`);
    const readerAuth = await loginAndGetHeaders(`reader-org-${orgId.slice(0, 6)}@docuflow.local`);
    const collabAuth = await loginAndGetHeaders(`collab-org-${orgId.slice(0, 6)}@docuflow.local`);

    // 2. Collaborator without ORGANIZATION permissions receives 403 on GET and PATCH
    const collabGet = await app.inject({
      method: "GET",
      url: "/api/v1/organization",
      headers: { cookie: collabAuth.cookieHeader },
    });
    expect(collabGet.statusCode).toBe(403);

    const collabPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/organization",
      headers: {
        cookie: collabAuth.cookieHeader,
        [CSRF_HEADER_NAME]: collabAuth.csrfToken,
      },
      payload: { name: "Tentativa Indevida" },
    });
    expect(collabPatch.statusCode).toBe(403);

    // 3. Read-only user reads with canEdit=false and receives 403 on PATCH
    const readerGet = await app.inject({
      method: "GET",
      url: "/api/v1/organization",
      headers: { cookie: readerAuth.cookieHeader },
    });
    expect(readerGet.statusCode).toBe(200);
    expect(readerGet.json().data.canEdit).toBe(false);
    expect(readerGet.json().data.organization.name).toBe("Empresa Inicial Ltda");
    expect(readerGet.json().data.organization.preferences.defaultExpirationWindowDays).toBe(30);

    const readerPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/organization",
      headers: {
        cookie: readerAuth.cookieHeader,
        [CSRF_HEADER_NAME]: readerAuth.csrfToken,
      },
      payload: { name: "Sem Permissão Escrita" },
    });
    expect(readerPatch.statusCode).toBe(403);

    // 4. Rejects invalid timezone, unsupported locale, and disallowed preference keys
    const invalidTzRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/organization",
      headers: {
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: { timezone: "Mars/Olympus" },
    });
    expect(invalidTzRes.statusCode).toBe(400);

    const unknownPrefRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/organization",
      headers: {
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: {
        preferences: {
          shellAccessEnabled: true,
        },
      },
    });
    expect(unknownPrefRes.statusCode).toBe(400);

    // 5. Admin updates organization settings and allowed preferences cleanly
    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/organization",
      headers: {
        cookie: adminAuth.cookieHeader,
        [CSRF_HEADER_NAME]: adminAuth.csrfToken,
      },
      payload: {
        name: "DocuFlow Corporativo S.A.",
        defaultLanguage: "en-US",
        timezone: "America/Manaus",
        preferences: {
          defaultExpirationWindowDays: 45,
          trashGraceDays: 14,
          dateFormat: "YYYY-MM-DD",
          defaultListPageSize: 50,
          auditDocumentViews: false,
          auditDocumentDownloads: true,
        },
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.canEdit).toBe(true);
    expect(patchRes.json().data.organization).toMatchObject({
      id: orgId,
      name: "DocuFlow Corporativo S.A.",
      defaultLanguage: "en-US",
      timezone: "America/Manaus",
      preferences: {
        defaultExpirationWindowDays: 45,
        trashGraceDays: 14,
        dateFormat: "YYYY-MM-DD",
        defaultListPageSize: 50,
        auditDocumentViews: false,
        auditDocumentDownloads: true,
      },
    });

    // Verify persisted via GET and audit event logged
    const verifyGetRes = await app.inject({
      method: "GET",
      url: "/api/v1/organization",
      headers: { cookie: adminAuth.cookieHeader },
    });
    expect(verifyGetRes.statusCode).toBe(200);
    expect(verifyGetRes.json().data.organization.name).toBe("DocuFlow Corporativo S.A.");

    const [auditRow] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, orgId),
          eq(auditEvents.action, "ORGANIZATION_SETTINGS_UPDATED"),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);
    expect(auditRow).toBeTruthy();
    expect(auditRow?.actorUserId).toBe(adminId);
    expect(auditRow?.result).toBe("SUCCESS");

    await app.close();
  });
});
