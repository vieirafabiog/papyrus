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
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentExpirationRepository,
  createDocumentRepository,
  documents,
  folders,
  organizations,
  permissions,
  rolePermissions,
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
import { SESSION_COOKIE_NAME } from "../../src/modules/auth/auth.routes.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Document expirations listing, timezone awareness, and authorization integration (Step 13.04)", () => {
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

  it("filters expired, expiring-soon, up-to-date, and undated documents while enforcing timezone and authorization scopes", async () => {
    const db = drizzle(pool);
    // Fixed instant: 2026-11-22T01:30:00Z
    // In America/Sao_Paulo (UTC-3) this is 2026-11-21 22:30 (calendar date 2026-11-21)
    // In Asia/Tokyo (UTC+9) this is 2026-11-22 10:30 (calendar date 2026-11-22)
    const fixedNow = new Date("2026-11-22T01:30:00.000Z");

    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const managerId = randomUUID();
    const scopedReaderId = randomUUID();
    const unprivilegedId = randomUUID();
    const readerRoleId = randomUUID();
    const categoryId = randomUUID();
    const folderAllowedId = randomUUID();
    const folderChildAllowedId = randomUUID();
    const folderRestrictedId = randomUUID();

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Org Vencimentos",
        slug: `exp-${orgId.slice(0, 8)}`,
        timezone: "America/Sao_Paulo",
      },
      {
        id: otherOrgId,
        name: "Org Externa Vencimentos",
        slug: `exp-ext-${otherOrgId.slice(0, 8)}`,
        timezone: "America/Sao_Paulo",
      },
    ]);

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword("SenhaVencimento!2026");

    await db.insert(users).values([
      {
        id: managerId,
        organizationId: orgId,
        email: `manager-exp-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Gestor Vencimentos",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: scopedReaderId,
        organizationId: orgId,
        email: `scoped-exp-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Leitor Pasta A",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: unprivilegedId,
        organizationId: orgId,
        email: `noperm-exp-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Sem Permissão",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(roles).values({
      id: readerRoleId,
      organizationId: orgId,
      key: "viewer",
      name: "Consulta",
      isSystem: true,
    });

    for (const pair of SYSTEM_ROLE_DEFINITIONS.viewer.permissions) {
      await db
        .insert(permissions)
        .values({ id: randomUUID(), action: pair.action, resource: pair.resource })
        .onConflictDoNothing();
    }
    const permRows = await db.select().from(permissions);
    const permMap = new Map(permRows.map((p) => [`${p.action}:${p.resource}`, p.id]));
    for (const pair of SYSTEM_ROLE_DEFINITIONS.viewer.permissions) {
      const pid = permMap.get(`${pair.action}:${pair.resource}`);
      if (pid) {
        await db.insert(rolePermissions).values({ roleId: readerRoleId, permissionId: pid });
      }
    }

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Licenças e Contratos",
      isActive: true,
    });

    await db.insert(folders).values([
      {
        id: folderAllowedId,
        organizationId: orgId,
        parentId: null,
        name: "Contratos Operacionais",
        materializedPath: `/${folderAllowedId}`,
        status: "ACTIVE",
      },
      {
        id: folderChildAllowedId,
        organizationId: orgId,
        parentId: folderAllowedId,
        name: "Anexos Operacionais",
        materializedPath: `/${folderAllowedId}/${folderChildAllowedId}`,
        status: "ACTIVE",
      },
      {
        id: folderRestrictedId,
        organizationId: orgId,
        parentId: null,
        name: "Diretoria Confidencial",
        materializedPath: `/${folderRestrictedId}`,
        status: "ACTIVE",
      },
    ]);

    const docOverdueId = randomUUID();
    const docBoundaryTodayId = randomUUID();
    const docSoonChildFolderId = randomUUID();
    const docDeniedExplicitId = randomUUID();
    const docUpToDateId = randomUUID();
    const docNoDateId = randomUUID();
    const docRestrictedFolderId = randomUUID();
    const docArchivedId = randomUUID();
    const docDeletedId = randomUUID();

    // Manager has GLOBAL ALLOW; scopedReader has ALLOW on folderAllowedId + explicit DENY on docDeniedExplicitId
    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: managerId,
        roleId: readerRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: scopedReaderId,
        roleId: readerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderAllowedId,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: scopedReaderId,
        roleId: readerRoleId,
        scopeType: "DOCUMENT",
        scopeTargetId: docDeniedExplicitId,
        effect: "DENY",
      },
    ]);

    await db.insert(documents).values([
      {
        id: docOverdueId,
        organizationId: orgId,
        title: "Alvará Vencido",
        categoryId,
        folderId: folderAllowedId,
        status: "APPROVED",
        ownerUserId: managerId,
        issueDate: "2025-01-01",
        expirationDate: "2026-11-10",
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: docBoundaryTodayId,
        organizationId: orgId,
        title: "Certidão Limite Fuso",
        categoryId,
        folderId: folderAllowedId,
        status: "APPROVED",
        ownerUserId: managerId,
        issueDate: "2025-01-01",
        expirationDate: "2026-11-21",
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: docSoonChildFolderId,
        organizationId: orgId,
        title: "Contrato Filho Próximo",
        categoryId,
        folderId: folderChildAllowedId,
        status: "APPROVED",
        ownerUserId: managerId,
        issueDate: "2025-01-01",
        expirationDate: "2026-12-05",
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: docDeniedExplicitId,
        organizationId: orgId,
        title: "Contrato Negado Explicitamente",
        categoryId,
        folderId: folderAllowedId,
        status: "APPROVED",
        ownerUserId: managerId,
        issueDate: "2025-01-01",
        expirationDate: "2026-11-05",
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: docUpToDateId,
        organizationId: orgId,
        title: "Apólice Longa",
        categoryId,
        folderId: folderAllowedId,
        status: "APPROVED",
        ownerUserId: managerId,
        issueDate: "2026-01-01",
        expirationDate: "2027-06-30",
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: docNoDateId,
        organizationId: orgId,
        title: "Estatuto Sem Vencimento",
        categoryId,
        folderId: folderAllowedId,
        status: "APPROVED",
        ownerUserId: managerId,
        issueDate: "2026-01-01",
        expirationDate: null,
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: docRestrictedFolderId,
        organizationId: orgId,
        title: "Segredo Diretoria Vencido",
        categoryId,
        folderId: folderRestrictedId,
        status: "APPROVED",
        ownerUserId: managerId,
        issueDate: "2025-01-01",
        expirationDate: "2026-11-01",
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: docArchivedId,
        organizationId: orgId,
        title: "Contrato Arquivado Vencido",
        categoryId,
        folderId: folderAllowedId,
        status: "ARCHIVED",
        ownerUserId: managerId,
        issueDate: "2024-01-01",
        expirationDate: "2025-01-01",
        createdBy: managerId,
        updatedBy: managerId,
      },
      {
        id: docDeletedId,
        organizationId: orgId,
        title: "Documento Lixeira",
        categoryId,
        folderId: folderAllowedId,
        status: "DELETED",
        ownerUserId: managerId,
        issueDate: "2024-01-01",
        expirationDate: "2025-01-01",
        createdBy: managerId,
        updatedBy: managerId,
      },
    ]);

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
      documentDeps: {
        authzRepository: createAuthorizationRepository(db),
        documentRepository: createDocumentRepository(db),
        auditRepository: createAuditRepository(db),
        documentExpirationRepository: createDocumentExpirationRepository(db),
        expirationsNow: () => fixedNow,
      },
    });
    await app.ready();

    expect(
      (await app.inject({ method: "GET", url: "/api/v1/documents/expirations" })).statusCode,
    ).toBe(401);

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";
    const loginAs = async (email: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password: "SenhaVencimento!2026" },
      });
      expect(res.statusCode).toBe(200);
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
      return { [SESSION_COOKIE_NAME]: cookie, [CSRF_COOKIE_NAME]: csrfToken };
    };

    const managerCookies = await loginAs(`manager-exp-${orgId.slice(0, 6)}@docuflow.local`);
    const scopedCookies = await loginAs(`scoped-exp-${orgId.slice(0, 6)}@docuflow.local`);
    const unprivCookies = await loginAs(`noperm-exp-${orgId.slice(0, 6)}@docuflow.local`);

    // 1. Default organization timezone (America/Sao_Paulo -> 2026-11-21)
    // For manager (non-archived, non-deleted):
    // EXPIRED: docOverdue (11-10), docDeniedExplicit (11-05), docRestrictedFolder (11-01) -> 3
    // EXPIRING_SOON (windowDays=30 -> 11-21 .. 12-21): docBoundaryToday (11-21), docSoonChildFolder (12-05) -> 2
    // UP_TO_DATE: docUpToDate -> 1
    // NO_DATE: docNoDate -> 1
    const managerAllRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/expirations?bucket=ALL&windowDays=30",
      cookies: managerCookies,
    });
    expect(managerAllRes.statusCode).toBe(200);
    const managerAllData = managerAllRes.json().data as {
      timezone: string;
      referenceDate: string;
      summary: {
        expiredCount: number;
        expiringSoonCount: number;
        upToDateCount: number;
        noExpirationCount: number;
      };
      items: Array<{ id: string; expirationState: string; daysUntilExpiration: number | null }>;
    };
    expect(managerAllData.timezone).toBe("America/Sao_Paulo");
    expect(managerAllData.referenceDate).toBe("2026-11-21");
    expect(managerAllData.summary).toEqual({
      expiredCount: 3,
      expiringSoonCount: 2,
      upToDateCount: 1,
      noExpirationCount: 1,
    });

    const boundaryItemSaoPaulo = managerAllData.items.find((i) => i.id === docBoundaryTodayId);
    expect(boundaryItemSaoPaulo?.expirationState).toBe("EXPIRING_SOON");
    expect(boundaryItemSaoPaulo?.daysUntilExpiration).toBe(0);

    // 2. Timezone shift to Asia/Tokyo (+9h -> 2026-11-22): 2026-11-21 flips from EXPIRING_SOON to EXPIRED!
    const tokyoExpiredRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/expirations?bucket=EXPIRED&timezone=Asia%2FTokyo",
      cookies: managerCookies,
    });
    expect(tokyoExpiredRes.statusCode).toBe(200);
    const tokyoData = tokyoExpiredRes.json().data as {
      timezone: string;
      referenceDate: string;
      summary: { expiredCount: number; expiringSoonCount: number };
      items: Array<{ id: string; daysUntilExpiration: number | null }>;
    };
    expect(tokyoData.timezone).toBe("Asia/Tokyo");
    expect(tokyoData.referenceDate).toBe("2026-11-22");
    expect(tokyoData.summary.expiredCount).toBe(4);
    expect(tokyoData.summary.expiringSoonCount).toBe(1);
    const boundaryItemTokyo = tokyoData.items.find((i) => i.id === docBoundaryTodayId);
    expect(boundaryItemTokyo?.daysUntilExpiration).toBe(-1);

    // 3. Bucket NO_DATE returns only undated authorized docs
    const noDateRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/expirations?bucket=NO_DATE",
      cookies: scopedCookies,
    });
    expect(noDateRes.statusCode).toBe(200);
    const noDateData = noDateRes.json().data as {
      items: Array<{ id: string; expirationState: string }>;
      pagination: { totalItems: number };
    };
    expect(noDateData.pagination.totalItems).toBe(1);
    expect(noDateData.items[0]?.id).toBe(docNoDateId);
    expect(noDateData.items[0]?.expirationState).toBe("NO_DATE");

    // 4. Scoped reader enforces folder inheritance AND explicit DENY BEFORE summary counts & listing!
    // Scoped reader cannot see docRestrictedFolderId OR docDeniedExplicitId!
    const scopedExpiredRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/expirations?bucket=EXPIRED",
      cookies: scopedCookies,
    });
    expect(scopedExpiredRes.statusCode).toBe(200);
    const scopedExpiredData = scopedExpiredRes.json().data as {
      summary: {
        expiredCount: number;
        expiringSoonCount: number;
        upToDateCount: number;
        noExpirationCount: number;
      };
      items: Array<{ id: string }>;
    };
    expect(scopedExpiredData.summary).toEqual({
      expiredCount: 1,
      expiringSoonCount: 2,
      upToDateCount: 1,
      noExpirationCount: 1,
    });
    expect(scopedExpiredData.items.map((i) => i.id)).toEqual([docOverdueId]);

    // 5. Unprivileged user sees zero items and zero counts (anti-count-leakage)
    const unprivRes = await app.inject({
      method: "GET",
      url: "/api/v1/documents/expirations?bucket=ALL",
      cookies: unprivCookies,
    });
    expect(unprivRes.statusCode).toBe(200);
    expect(unprivRes.json().data.summary).toEqual({
      expiredCount: 0,
      expiringSoonCount: 0,
      upToDateCount: 0,
      noExpirationCount: 0,
    });
    expect(unprivRes.json().data.items).toHaveLength(0);

    // 6. Invalid timezone returns 400 VALIDATION_ERROR
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/documents/expirations?timezone=Invalid%2FZone",
          cookies: managerCookies,
        })
      ).statusCode,
    ).toBe(400);

    await app.close();
  }, 120_000);
});
