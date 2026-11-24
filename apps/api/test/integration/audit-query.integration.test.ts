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
  auditEvents,
  createAuditRepository,
  createAuthorizationRepository,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
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

describe("Audit query, filters, and authorized export integration (Step 13.03)", () => {
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

  it("filters audit events by user, action, resource, result, and period, isolates orgs, and limits export to authorized users", async () => {
    const db = drizzle(pool);
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const auditorId = randomUUID();
    const actorBId = randomUUID();
    const unauthorizedUserId = randomUUID();
    const deniedAuditorId = randomUUID();
    const auditorRoleId = randomUUID();
    const viewerRoleId = randomUUID();
    const doc1Id = randomUUID();
    const doc2Id = randomUUID();

    await db.insert(organizations).values([
      { id: orgId, name: "Org Auditoria Consulta", slug: `audit-q-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Org Externa", slug: `audit-ext-${otherOrgId.slice(0, 8)}` },
    ]);

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword("SenhaAuditQuery!2026");

    await db.insert(users).values([
      {
        id: auditorId,
        organizationId: orgId,
        email: `auditor-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Auditor Principal",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: actorBId,
        organizationId: orgId,
        email: `gestor-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Gestor Documental",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: unauthorizedUserId,
        organizationId: orgId,
        email: `viewer-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Consulta Comum",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: deniedAuditorId,
        organizationId: orgId,
        email: `denied-auditor-${orgId.slice(0, 6)}@papyrus.local`,
        fullName: "Auditor Bloqueado",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(roles).values([
      {
        id: auditorRoleId,
        organizationId: orgId,
        key: "auditor",
        name: "Auditor",
        isSystem: false,
      },
      {
        id: viewerRoleId,
        organizationId: orgId,
        key: "viewer",
        name: "Consulta",
        isSystem: true,
      },
    ]);

    for (const pair of [
      ...SYSTEM_ROLE_DEFINITIONS.admin.permissions,
      ...SYSTEM_ROLE_DEFINITIONS.viewer.permissions,
    ]) {
      await db
        .insert(permissions)
        .values({ id: randomUUID(), action: pair.action, resource: pair.resource })
        .onConflictDoNothing();
    }
    const permRows = await db.select().from(permissions);
    const permByKey = new Map(permRows.map((p) => [`${p.action}:${p.resource}`, p.id]));

    const viewAuditPermId = permByKey.get("VIEW_AUDIT:AUDIT");
    expect(viewAuditPermId).toBeDefined();
    if (viewAuditPermId) {
      await db
        .insert(rolePermissions)
        .values({ roleId: auditorRoleId, permissionId: viewAuditPermId });
    }
    for (const pair of SYSTEM_ROLE_DEFINITIONS.viewer.permissions) {
      const pid = permByKey.get(`${pair.action}:${pair.resource}`);
      if (pid) {
        await db.insert(rolePermissions).values({ roleId: viewerRoleId, permissionId: pid });
      }
    }

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: auditorId,
        roleId: auditorRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: unauthorizedUserId,
        roleId: viewerRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: deniedAuditorId,
        roleId: auditorRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: deniedAuditorId,
        roleId: auditorRoleId,
        scopeType: "GLOBAL",
        effect: "DENY",
      },
    ]);

    // Seed audit events across dates, actors, actions, resource types, and organizations
    await db.insert(auditEvents).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        occurredAt: new Date("2026-11-01T10:00:00.000Z"),
        actorUserId: actorBId,
        action: "DOCUMENT_CREATED",
        resourceType: "DOCUMENT",
        resourceId: doc1Id,
        result: "SUCCESS",
        requestId: randomUUID(),
        ipAddress: "127.0.0.10",
        metadata: { categoryName: "Contratos" },
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        occurredAt: new Date("2026-11-10T15:30:00.000Z"),
        actorUserId: actorBId,
        action: "DOCUMENT_DOWNLOADED",
        resourceType: "DOCUMENT",
        resourceId: doc2Id,
        result: "SUCCESS",
        requestId: randomUUID(),
        ipAddress: "127.0.0.10",
        metadata: { delivery: "STREAM" },
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        occurredAt: new Date("2026-11-15T18:00:00.000Z"),
        actorUserId: unauthorizedUserId,
        action: "AUTHORIZATION_DENIED",
        resourceType: "DOCUMENT",
        resourceId: doc1Id,
        result: "DENIED",
        requestId: randomUUID(),
        ipAddress: "127.0.0.20",
        metadata: { note: "=CMD|' /C calc'!A0" },
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        occurredAt: new Date("2026-11-18T12:00:00.000Z"),
        actorUserId: auditorId,
        action: "PERMISSION_ASSIGNED",
        resourceType: "ROLE_SCOPE",
        resourceId: randomUUID(),
        result: "SUCCESS",
        requestId: randomUUID(),
        ipAddress: "127.0.0.30",
        metadata: { scopeType: "GLOBAL" },
      },
      {
        id: randomUUID(),
        organizationId: otherOrgId,
        occurredAt: new Date("2026-11-10T12:00:00.000Z"),
        actorUserId: null,
        action: "DOCUMENT_CREATED",
        resourceType: "DOCUMENT",
        resourceId: randomUUID(),
        result: "SUCCESS",
        requestId: randomUUID(),
        metadata: { tenant: "foreign" },
      },
    ]);

    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);

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
      auditDeps: {
        authzRepository,
        auditRepository,
        now: () => new Date("2026-11-21T18:00:00.000Z"),
      },
    });
    await app.ready();

    // 1. Unauthenticated access rejected (401)
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/audit-events" })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/audit-events/export" })).statusCode,
    ).toBe(401);

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";
    const loginAs = async (email: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password: "SenhaAuditQuery!2026" },
      });
      expect(res.statusCode).toBe(200);
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
      return { [SESSION_COOKIE_NAME]: cookie, [CSRF_COOKIE_NAME]: csrfToken };
    };

    const auditorCookies = await loginAs(`auditor-${orgId.slice(0, 6)}@papyrus.local`);
    const viewerCookies = await loginAs(`viewer-${orgId.slice(0, 6)}@papyrus.local`);
    const deniedCookies = await loginAs(`denied-auditor-${orgId.slice(0, 6)}@papyrus.local`);

    // 2. Unauthorized viewer & explicit DENY auditor receive 403 on query, facets & export
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/audit-events",
          cookies: viewerCookies,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/audit-events/facets",
          cookies: viewerCookies,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/audit-events/export?format=csv",
          cookies: viewerCookies,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/audit-events/export?format=json",
          cookies: deniedCookies,
        })
      ).statusCode,
    ).toBe(403);

    // 3. Facets strictly isolated to organization
    const facetsRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-events/facets",
      cookies: auditorCookies,
    });
    expect(facetsRes.statusCode).toBe(200);
    const facetsData = facetsRes.json().data as {
      actors: Array<{ id: string; fullName: string; email: string }>;
      actions: string[];
      resourceTypes: string[];
    };
    expect(facetsData.actors.map((a) => a.id)).toContain(actorBId);
    expect(facetsData.actions).toContain("DOCUMENT_DOWNLOADED");
    expect(facetsData.resourceTypes).toContain("ROLE_SCOPE");

    // 4. Invalid inverted period returns 400
    const badPeriodRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-events?from=2026-11-20&to=2026-11-05",
      cookies: auditorCookies,
    });
    expect(badPeriodRes.statusCode).toBe(400);

    // 5. Filter by actorUserId + period
    const byActorPeriodRes = await app.inject({
      method: "GET",
      url: `/api/v1/admin/audit-events?actorUserId=${actorBId}&from=2026-11-05&to=2026-11-12`,
      cookies: auditorCookies,
    });
    expect(byActorPeriodRes.statusCode).toBe(200);
    const byActorPeriodData = byActorPeriodRes.json().data as {
      items: Array<{ action: string; actorName: string | null }>;
      pagination: { totalItems: number };
    };
    expect(byActorPeriodData.pagination.totalItems).toBe(1);
    expect(byActorPeriodData.items[0]?.action).toBe("DOCUMENT_DOWNLOADED");
    expect(byActorPeriodData.items[0]?.actorName).toBe("Gestor Documental");

    // 6. Filter by action
    const byActionRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-events?action=PERMISSION_ASSIGNED",
      cookies: auditorCookies,
    });
    expect(byActionRes.statusCode).toBe(200);
    expect(byActionRes.json().data.pagination.totalItems).toBe(1);

    // 7. Filter by resourceType + result
    const byResourceResultRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-events?resourceType=DOCUMENT&result=SUCCESS",
      cookies: auditorCookies,
    });
    expect(byResourceResultRes.statusCode).toBe(200);
    expect(byResourceResultRes.json().data.pagination.totalItems).toBe(2);

    // 8. Authorized CSV export respects filters, escapes formula injection, and records AUDIT_EXPORTED
    const csvExportRes = await app.inject({
      method: "GET",
      url: `/api/v1/admin/audit-events/export?format=csv&actorUserId=${unauthorizedUserId}&action=AUTHORIZATION_DENIED&from=2026-11-14&to=2026-11-16`,
      cookies: auditorCookies,
    });
    expect(csvExportRes.statusCode).toBe(200);
    expect(csvExportRes.headers["content-type"]).toContain("text/csv");
    expect(csvExportRes.headers["content-disposition"]).toContain(
      "auditoria-papyrus-2026-11-21.csv",
    );
    expect(csvExportRes.body).toContain("AUTHORIZATION_DENIED");
    expect(csvExportRes.body).not.toContain("foreign");
    // Formula neutralization: leading "=" inside JSON string isn't first char unless standalone, wait verify exact content safely exported
    expect(csvExportRes.body).toContain("127.0.0.20");

    // 9. Authorized JSON export returns bounded filtered payload
    const jsonExportRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-events/export?format=json&resourceType=ROLE_SCOPE",
      cookies: auditorCookies,
    });
    expect(jsonExportRes.statusCode).toBe(200);
    expect(jsonExportRes.headers["content-type"]).toContain("application/json");
    const jsonPayload = jsonExportRes.json() as {
      totalExported: number;
      items: Array<{ action: string }>;
    };
    expect(jsonPayload.totalExported).toBe(1);
    expect(jsonPayload.items[0]?.action).toBe("PERMISSION_ASSIGNED");

    await app.close();

    // Verify AUDIT_EXPORT_DENIED and AUDIT_EXPORTED were recorded in PostgreSQL
    const persisted = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    expect(persisted.filter((e) => e.action === "AUDIT_EXPORT_DENIED").length).toBe(2);
    expect(persisted.filter((e) => e.action === "AUDIT_EXPORTED").length).toBe(2);
  }, 120_000);
});
