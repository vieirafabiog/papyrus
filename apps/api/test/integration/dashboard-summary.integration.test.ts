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
import { CONTRACTS_API_PREFIX, dashboardSummarySchema } from "@docuflow/contracts";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDashboardRepository,
  createDocumentRepository,
  documentVersions,
  documents,
  fileObjects,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  uploadSessions,
  userRoleScopes,
  users,
  workflowDefinitionVersions,
  workflowDefinitions,
  workflowInstances,
  workflowTasks,
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

describe("Dashboard summary authorized PostgreSQL aggregations integration", () => {
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
    await pool.end();
    await container?.stop();
  });

  it("computes authorized document, task, expiration, quarantine, storage and audit counts strictly in PostgreSQL", async () => {
    const db = drizzle(pool);
    const fixedNow = new Date("2026-11-21T12:00:00.000Z");

    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const categoryId = randomUUID();
    const otherCategoryId = randomUUID();
    const allowedFolderId = randomUUID();
    const allowedSubfolderId = randomUUID();
    const restrictedFolderId = randomUUID();
    const adminId = randomUUID();
    const scopedUserId = randomUUID();
    const adminRoleId = randomUUID();
    const viewerRoleId = randomUUID();
    const storageId = randomUUID();
    const otherStorageId = randomUUID();

    await db.insert(organizations).values([
      { id: orgId, name: "DocuFlow Dashboard Corp", slug: `dash-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Outra Organização Corp", slug: `other-${otherOrgId.slice(0, 8)}` },
    ]);

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword("SenhaDashboard123!");

    await db.insert(users).values([
      {
        id: adminId,
        organizationId: orgId,
        email: "admin-dash@docuflow.local",
        fullName: "Admin Dashboard",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: scopedUserId,
        organizationId: orgId,
        email: "scoped-dash@docuflow.local",
        fullName: "Scoped Dashboard",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    const adminPerms = SYSTEM_ROLE_DEFINITIONS.admin.permissions;
    const viewerPerms = SYSTEM_ROLE_DEFINITIONS.viewer.permissions;

    const permMap = new Map<string, string>();
    for (const pair of adminPerms) {
      const id = randomUUID();
      permMap.set(`${pair.action}:${pair.resource}`, id);
      await db
        .insert(permissions)
        .values({ id, action: pair.action, resource: pair.resource })
        .onConflictDoNothing();
    }
    const existingPerms = await db.select().from(permissions);
    for (const row of existingPerms) {
      permMap.set(`${row.action}:${row.resource}`, row.id);
    }

    await db.insert(roles).values([
      {
        id: adminRoleId,
        organizationId: orgId,
        key: `admin_${orgId.slice(0, 8)}`,
        name: "Admin Dash",
        description: null,
        isSystem: true,
      },
      {
        id: viewerRoleId,
        organizationId: orgId,
        key: `viewer_${orgId.slice(0, 8)}`,
        name: "Viewer Dash",
        description: null,
        isSystem: true,
      },
    ]);

    for (const pair of adminPerms) {
      const permId = permMap.get(`${pair.action}:${pair.resource}`);
      if (permId) {
        await db.insert(rolePermissions).values({ roleId: adminRoleId, permissionId: permId });
      }
    }
    for (const pair of viewerPerms) {
      const permId = permMap.get(`${pair.action}:${pair.resource}`);
      if (permId) {
        await db.insert(rolePermissions).values({ roleId: viewerRoleId, permissionId: permId });
      }
    }

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: adminId,
        roleId: adminRoleId,
        scopeType: "GLOBAL",
        scopeTargetId: null,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: scopedUserId,
        roleId: viewerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: allowedFolderId,
        effect: "ALLOW",
      },
    ]);

    await db.insert(categories).values([
      {
        id: categoryId,
        organizationId: orgId,
        name: "Contratos Dashboard",
        isActive: true,
      },
      {
        id: otherCategoryId,
        organizationId: otherOrgId,
        name: "Contratos Outra Org",
        isActive: true,
      },
    ]);

    await db.insert(folders).values([
      {
        id: allowedFolderId,
        organizationId: orgId,
        parentId: null,
        name: "Pasta Permitida",
        materializedPath: "/Pasta Permitida",
        status: "ACTIVE",
      },
      {
        id: allowedSubfolderId,
        organizationId: orgId,
        parentId: allowedFolderId,
        name: "Subpasta Permitida",
        materializedPath: "/Pasta Permitida/Subpasta Permitida",
        status: "ACTIVE",
      },
      {
        id: restrictedFolderId,
        organizationId: orgId,
        parentId: null,
        name: "Pasta Confidencial",
        materializedPath: "/Pasta Confidencial",
        status: "ACTIVE",
      },
    ]);

    await db.insert(storageConnections).values([
      {
        id: storageId,
        organizationId: orgId,
        name: "Local Dash",
        kind: "local",
        status: "ACTIVE",
        isDefault: true,
        nonSecretConfig: { rootDirectory: "/tmp/dash-local" },
      },
      {
        id: otherStorageId,
        organizationId: otherOrgId,
        name: "Local Outra Org",
        kind: "local",
        status: "ACTIVE",
        isDefault: true,
        nonSecretConfig: { rootDirectory: "/tmp/other-local" },
      },
    ]);

    // File objects:
    // - file1 (AVAILABLE, 1000 bytes) in allowed folder doc1 (linked twice to test no double-counting)
    // - file2 (QUARANTINED, 2500 bytes) in allowed subfolder doc2
    // - file3 (AVAILABLE, 4000 bytes) in restricted folder doc3
    // - file4 (REJECTED, 9999 bytes) should NOT count in active storageUsedBytes
    // - file5 (AVAILABLE, 5000 bytes) in DELETED doc4 (should NOT count)
    // - fileForeign (AVAILABLE, 7777 bytes) in otherOrg (should NEVER leak)
    const file1 = randomUUID();
    const file2 = randomUUID();
    const file3 = randomUUID();
    const file4 = randomUUID();
    const file5 = randomUUID();
    const fileForeign = randomUUID();

    await db.insert(fileObjects).values([
      {
        id: file1,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/f1`,
        originalFileName: "f1.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1_000,
        checksumSha256: "1".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: file2,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/f2`,
        originalFileName: "f2.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 2_500,
        checksumSha256: "2".repeat(64),
        status: "QUARANTINED",
      },
      {
        id: file3,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/f3`,
        originalFileName: "f3.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 4_000,
        checksumSha256: "3".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: file4,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/f4`,
        originalFileName: "f4.exe",
        detectedContentType: "application/octet-stream",
        sizeBytes: 9_999,
        checksumSha256: "4".repeat(64),
        status: "REJECTED",
      },
      {
        id: file5,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/f5`,
        originalFileName: "f5.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 5_000,
        checksumSha256: "5".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileForeign,
        organizationId: otherOrgId,
        storageConnectionId: otherStorageId,
        objectKey: `org/${otherOrgId}/foreign`,
        originalFileName: "foreign.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 7_777,
        checksumSha256: "6".repeat(64),
        status: "AVAILABLE",
      },
    ]);

    // Upload session from scopedUser pointing to a separate quarantined file uploaded by scopedUser
    const userDirectQuarantineFile = randomUUID();
    await db.insert(fileObjects).values({
      id: userDirectQuarantineFile,
      organizationId: orgId,
      storageConnectionId: storageId,
      objectKey: `org/${orgId}/direct-q`,
      originalFileName: "direct-q.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 600,
      checksumSha256: "7".repeat(64),
      status: "QUARANTINED",
    });
    await db.insert(uploadSessions).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: scopedUserId,
      storageConnectionId: storageId,
      fileObjectId: userDirectQuarantineFile,
      declaredSizeBytes: 600,
      declaredContentType: "application/pdf",
      idempotencyKey: "dash-q-1",
      status: "FINALIZED",
      expiresAt: new Date(Date.now() + 600_000),
      finalizedAt: new Date(),
    });

    const doc1Id = randomUUID();
    const doc2Id = randomUUID();
    const doc3Id = randomUUID();
    const docDeletedId = randomUUID();
    const docForeignId = randomUUID();

    // fixedNow = 2026-11-21 -> 30d window = 2026-11-21 .. 2026-12-21
    await db.insert(documents).values([
      {
        id: doc1Id,
        organizationId: orgId,
        title: "Contrato Permitido Vigente",
        categoryId,
        folderId: allowedFolderId,
        status: "APPROVED",
        ownerUserId: adminId,
        expirationDate: "2026-12-05", // Expiring soon!
        createdBy: adminId,
        updatedBy: adminId,
      },
      {
        id: doc2Id,
        organizationId: orgId,
        title: "Aditivo Subpasta Em Análise",
        categoryId,
        folderId: allowedSubfolderId,
        status: "DRAFT",
        ownerUserId: adminId,
        expirationDate: "2027-06-01", // Far future (not expiring soon)
        createdBy: adminId,
        updatedBy: adminId,
      },
      {
        id: doc3Id,
        organizationId: orgId,
        title: "Documento Pasta Restrita",
        categoryId,
        folderId: restrictedFolderId,
        status: "IN_REVIEW",
        ownerUserId: adminId,
        expirationDate: "2026-11-28", // Expiring soon, restricted!
        createdBy: adminId,
        updatedBy: adminId,
      },
      {
        id: docDeletedId,
        organizationId: orgId,
        title: "Documento Na Lixeira",
        categoryId,
        folderId: allowedFolderId,
        status: "DELETED",
        ownerUserId: adminId,
        expirationDate: "2026-11-25",
        createdBy: adminId,
        updatedBy: adminId,
      },
      {
        id: docForeignId,
        organizationId: otherOrgId,
        title: "Documento Outra Organização",
        categoryId: otherCategoryId,
        folderId: null,
        status: "APPROVED",
        ownerUserId: adminId,
        expirationDate: "2026-11-25",
        createdBy: adminId,
        updatedBy: adminId,
      },
    ]);

    const ver1aId = randomUUID();
    const ver1bId = randomUUID();
    const ver2Id = randomUUID();
    const ver3Id = randomUUID();
    const verRejectedId = randomUUID();
    const verDeletedId = randomUUID();
    await db.insert(documentVersions).values([
      {
        id: ver1aId,
        documentId: doc1Id,
        versionNumber: 1,
        fileObjectId: file1,
        uploadedByUserId: adminId,
      },
      {
        id: ver1bId,
        documentId: doc1Id,
        versionNumber: 2,
        fileObjectId: file1, // Restored version sharing file1 -> must NOT double-count storage!
        uploadedByUserId: adminId,
      },
      {
        id: ver2Id,
        documentId: doc2Id,
        versionNumber: 1,
        fileObjectId: file2,
        uploadedByUserId: adminId,
      },
      {
        id: ver3Id,
        documentId: doc3Id,
        versionNumber: 1,
        fileObjectId: file3,
        uploadedByUserId: adminId,
      },
      {
        id: verRejectedId,
        documentId: doc2Id,
        versionNumber: 2,
        fileObjectId: file4, // REJECTED
        uploadedByUserId: adminId,
      },
      {
        id: verDeletedId,
        documentId: docDeletedId,
        versionNumber: 1,
        fileObjectId: file5,
        uploadedByUserId: adminId,
      },
    ]);

    // Pending workflow tasks: 1 for scopedUser on doc1 (allowed), 1 for scopedUser on doc3 (restricted!), 1 for admin on doc3
    const wfDefId = randomUUID();
    const wfDefVerId = randomUUID();
    const wfInstAllowedId = randomUUID();
    const wfInstRestrictedId = randomUUID();

    await db.insert(workflowDefinitions).values({
      id: wfDefId,
      organizationId: orgId,
      name: "Fluxo Dashboard",
      isActive: true,
      latestVersionNumber: 1,
      createdBy: adminId,
      updatedBy: adminId,
    });
    await db.insert(workflowDefinitionVersions).values({
      id: wfDefVerId,
      workflowDefinitionId: wfDefId,
      versionNumber: 1,
      steps: [
        {
          stepOrder: 1,
          name: "Revisão",
          assigneeType: "USER",
          assigneeTargetId: scopedUserId,
          dueDays: 5,
        },
      ],
      createdBy: adminId,
    });
    await db.insert(workflowInstances).values([
      {
        id: wfInstAllowedId,
        organizationId: orgId,
        documentId: doc1Id,
        documentVersionId: ver1bId,
        workflowDefinitionVersionId: wfDefVerId,
        status: "ACTIVE",
        currentStepOrder: 1,
        startedByUserId: adminId,
      },
      {
        id: wfInstRestrictedId,
        organizationId: orgId,
        documentId: doc3Id,
        documentVersionId: ver3Id,
        workflowDefinitionVersionId: wfDefVerId,
        status: "ACTIVE",
        currentStepOrder: 1,
        startedByUserId: adminId,
      },
    ]);
    await db.insert(workflowTasks).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        workflowInstanceId: wfInstAllowedId,
        documentId: doc1Id,
        documentVersionId: ver1bId,
        stepOrder: 1,
        status: "PENDING",
        assigneeType: "USER",
        assigneeTargetId: scopedUserId,
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        workflowInstanceId: wfInstRestrictedId,
        documentId: doc3Id,
        documentVersionId: ver3Id,
        stepOrder: 1,
        status: "PENDING",
        assigneeType: "USER",
        assigneeTargetId: adminId,
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        workflowInstanceId: wfInstRestrictedId,
        documentId: doc3Id,
        documentVersionId: ver3Id,
        stepOrder: 2,
        status: "PENDING",
        assigneeType: "USER",
        assigneeTargetId: scopedUserId, // Even if assigned, doc3 is outside scopedUser READ scope -> must NOT leak count!
      },
    ]);

    // Audit events: one on doc1 (allowed), one on doc3 (restricted!), one global USER action
    await db.insert(auditEvents).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        actorUserId: adminId,
        action: "DOCUMENT_CREATED",
        resourceType: "DOCUMENT",
        resourceId: doc1Id,
        result: "SUCCESS",
        requestId: randomUUID(),
        occurredAt: new Date("2026-11-21T11:00:00.000Z"),
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        actorUserId: adminId,
        action: "DOCUMENT_CREATED",
        resourceType: "DOCUMENT",
        resourceId: doc3Id,
        result: "SUCCESS",
        requestId: randomUUID(),
        occurredAt: new Date("2026-11-21T11:30:00.000Z"),
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        actorUserId: adminId,
        action: "USER_ROLE_CHANGED",
        resourceType: "USER",
        resourceId: scopedUserId,
        result: "SUCCESS",
        requestId: randomUUID(),
        occurredAt: new Date("2026-11-21T11:45:00.000Z"),
      },
    ]);

    const sessionStore: SessionStorePort = {
      async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
        await db.insert(sessions).values({
          id: input.id,
          organizationId: input.organizationId,
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          revokedAt: null,
        });
        return { ...input, revokedAt: null, createdAt: fixedNow };
      },
      async findByTokenHash(tokenHash: string) {
        const rows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.tokenHash, tokenHash))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        return {
          id: row.id,
          organizationId: row.organizationId,
          userId: row.userId,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          createdAt: row.createdAt,
        };
      },
      async revokeById(sessionId: string, revokedAt: Date) {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.id, sessionId));
      },
      async revokeAllForUser(userId: string, revokedAt: Date) {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, userId));
      },
    };

    const sessionService = createSessionService({ store: sessionStore });
    const authService = createAuthService({
      passwordService,
      sessionService,
      users: {
        async findCredentialByEmail(email) {
          const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
          const row = rows[0];
          if (!row) return null;
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
          const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
          const row = rows[0];
          if (!row) return null;
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
      authService,
      secureCookies: false,
      documentDeps: {
        authzRepository: createAuthorizationRepository(db),
        documentRepository: createDocumentRepository(db),
        auditRepository: createAuditRepository(db),
        dashboardRepository: createDashboardRepository(db),
        dashboardNow: () => fixedNow,
      },
    });

    // Unauthenticated rejected
    const anonRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/dashboard/summary`,
    });
    expect(anonRes.statusCode).toBe(401);

    const login = async (email: string) => {
      const csrfRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
      });
      const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;
      const loginRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password: "SenhaDashboard123!" },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie =
        loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
      return { [SESSION_COOKIE_NAME]: sessionCookie };
    };

    const adminCookies = await login("admin-dash@docuflow.local");
    const scopedCookies = await login("scoped-dash@docuflow.local");

    // 1. Admin summary sees all non-deleted org docs (doc1, doc2, doc3 = 3),
    //    expiring soon (doc1 + doc3 = 2), quarantined linked to accessible docs (file2 = 1; excludes unlinked upload session owned by scopedUser),
    //    unique active storage bytes linked to non-deleted docs (1000 + 2500 + 4000 = 7500; 3 active files),
    //    admin pending task (1), and all 3 audit events.
    const adminRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/dashboard/summary`,
      cookies: adminCookies,
    });
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.headers["cache-control"]).toContain("private");
    expect(adminRes.headers["cache-control"]).toContain("no-store");

    const adminParsed = dashboardSummarySchema.parse(adminRes.json().data);
    expect(adminParsed.totalDocuments).toBe(3);
    expect(adminParsed.expiringSoonDocuments).toBe(2);
    expect(adminParsed.quarantinedFiles).toBe(1);
    expect(adminParsed.storageUsedBytes).toBe(7_500);
    expect(adminParsed.storageFileCount).toBe(3);
    expect(adminParsed.pendingTasks).toBe(1);
    expect(adminParsed.recentActivity).toHaveLength(3);

    // 2. Folder-scoped user sees ONLY allowed subtree (doc1 + doc2 = 2),
    //    expiring soon (doc1 = 1), quarantined (file2 + userDirectQuarantineFile = 2),
    //    storage bytes (1000 + 2500 = 3500; 2 active files — no double-counting file1!),
    //    pending task only on authorized doc1 (1), and ONLY audit events on authorized doc1 (1).
    const scopedRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/dashboard/summary`,
      cookies: scopedCookies,
    });
    expect(scopedRes.statusCode).toBe(200);
    const scopedParsed = dashboardSummarySchema.parse(scopedRes.json().data);
    expect(scopedParsed.totalDocuments).toBe(2);
    expect(scopedParsed.expiringSoonDocuments).toBe(1);
    expect(scopedParsed.quarantinedFiles).toBe(2);
    expect(scopedParsed.storageUsedBytes).toBe(3_500);
    expect(scopedParsed.storageFileCount).toBe(2);
    expect(scopedParsed.pendingTasks).toBe(1);
    expect(scopedParsed.recentActivity).toHaveLength(1);
    expect(scopedParsed.recentActivity[0]?.resourceId).toBe(doc1Id);

    await app.close();
  }, 60_000);
});
