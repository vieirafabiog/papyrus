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
  CONTRACTS_API_PREFIX,
  taskDetailResponseSchema,
  taskInboxListResponseSchema,
} from "@docuflow/contracts";
import {
  categories,
  createAuthorizationRepository,
  createDocumentRepository,
  createTaskInboxRepository,
  createWorkflowDefinitionRepository,
  documentVersions,
  documents,
  fileObjects,
  folders,
  groups,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  userGroups,
  userRoleScopes,
  users,
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

describe("Task inbox HTTP filtering, pagination and scope authorization integration", () => {
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

  it("lists authorized user and group tasks with SQL filters/pagination while blocking unauthorized task detail and count leaks", async () => {
    const db = drizzle(pool);
    const fixedNow = new Date("2026-11-21T18:00:00.000Z");

    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const aliceId = randomUUID();
    const bobId = randomUUID();
    const carolId = randomUUID();
    const juridicoGroupId = randomUUID();
    const reviewerRoleId = randomUUID();
    const otherRoleId = randomUUID();
    const categoryId = randomUUID();
    const otherCategoryId = randomUUID();
    const folderAllowedId = randomUUID();
    const folderDeniedId = randomUUID();
    const storageId = randomUUID();
    const otherStorageId = randomUUID();

    await db.insert(organizations).values([
      { id: orgId, name: "Org Task Inbox", slug: `inbox-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Org Outra Inbox", slug: `inbox-other-${otherOrgId.slice(0, 8)}` },
    ]);

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword("SenhaTaskInbox123!");

    await db.insert(users).values([
      {
        id: aliceId,
        organizationId: orgId,
        email: "alice-inbox@docuflow.local",
        fullName: "Alice Revisora",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: bobId,
        organizationId: orgId,
        email: "bob-inbox@docuflow.local",
        fullName: "Bob Revisor",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: carolId,
        organizationId: otherOrgId,
        email: "carol-other@other.local",
        fullName: "Carol Externa",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(groups).values({
      id: juridicoGroupId,
      organizationId: orgId,
      name: "Jurídico",
    });
    await db.insert(userGroups).values({
      id: randomUUID(),
      userId: aliceId,
      groupId: juridicoGroupId,
    });

    await db.insert(roles).values([
      {
        id: reviewerRoleId,
        organizationId: orgId,
        key: `reviewer_${orgId.slice(0, 6)}`,
        name: "Revisor",
        isSystem: true,
      },
      {
        id: otherRoleId,
        organizationId: otherOrgId,
        key: `reviewer_${otherOrgId.slice(0, 6)}`,
        name: "Revisor Ext",
        isSystem: true,
      },
    ]);

    const permMap = new Map<string, string>();
    for (const pair of SYSTEM_ROLE_DEFINITIONS.reviewer.permissions) {
      await db
        .insert(permissions)
        .values({ id: randomUUID(), action: pair.action, resource: pair.resource })
        .onConflictDoNothing();
    }
    const existingPerms = await db.select().from(permissions);
    for (const p of existingPerms) {
      permMap.set(`${p.action}:${p.resource}`, p.id);
    }
    for (const pair of SYSTEM_ROLE_DEFINITIONS.reviewer.permissions) {
      const pid = permMap.get(`${pair.action}:${pair.resource}`);
      if (pid) {
        await db.insert(rolePermissions).values([
          { roleId: reviewerRoleId, permissionId: pid },
          { roleId: otherRoleId, permissionId: pid },
        ]);
      }
    }

    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        groupId: juridicoGroupId,
        roleId: reviewerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderAllowedId,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: bobId,
        roleId: reviewerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderDeniedId,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: otherOrgId,
        userId: carolId,
        roleId: otherRoleId,
        scopeType: "GLOBAL",
        scopeTargetId: null,
        effect: "ALLOW",
      },
    ]);

    await db.insert(categories).values([
      { id: categoryId, organizationId: orgId, name: "Contratos", isActive: true },
      { id: otherCategoryId, organizationId: otherOrgId, name: "Externo", isActive: true },
    ]);

    await db.insert(folders).values([
      {
        id: folderAllowedId,
        organizationId: orgId,
        parentId: null,
        name: "Permitida",
        materializedPath: "/Permitida",
        status: "ACTIVE",
      },
      {
        id: folderDeniedId,
        organizationId: orgId,
        parentId: null,
        name: "Restrita Bob",
        materializedPath: "/Restrita Bob",
        status: "ACTIVE",
      },
    ]);

    await db.insert(storageConnections).values([
      {
        id: storageId,
        organizationId: orgId,
        name: "Local Inbox",
        kind: "local",
        status: "ACTIVE",
        isDefault: true,
        nonSecretConfig: { rootDirectory: "/tmp/inbox-local" },
      },
      {
        id: otherStorageId,
        organizationId: otherOrgId,
        name: "Local Other",
        kind: "local",
        status: "ACTIVE",
        isDefault: true,
        nonSecretConfig: { rootDirectory: "/tmp/inbox-other" },
      },
    ]);

    const fileAId = randomUUID();
    const fileBId = randomUUID();
    const fileDelId = randomUUID();
    const fileForeignId = randomUUID();
    await db.insert(fileObjects).values([
      {
        id: fileAId,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/fa`,
        originalFileName: "a.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1000,
        checksumSha256: "a".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileBId,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/fb`,
        originalFileName: "b.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1000,
        checksumSha256: "b".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileDelId,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/fd`,
        originalFileName: "del.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1000,
        checksumSha256: "c".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: fileForeignId,
        organizationId: otherOrgId,
        storageConnectionId: otherStorageId,
        objectKey: `org/${otherOrgId}/ff`,
        originalFileName: "f.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1000,
        checksumSha256: "d".repeat(64),
        status: "AVAILABLE",
      },
    ]);

    const docAId = randomUUID();
    const docBId = randomUUID();
    const docDeletedId = randomUUID();
    const docForeignId = randomUUID();
    await db.insert(documents).values([
      {
        id: docAId,
        organizationId: orgId,
        title: "Contrato Principal Alice",
        categoryId,
        folderId: folderAllowedId,
        status: "IN_REVIEW",
        ownerUserId: aliceId,
        createdBy: aliceId,
        updatedBy: aliceId,
      },
      {
        id: docBId,
        organizationId: orgId,
        title: "Documento Restrito Bob",
        categoryId,
        folderId: folderDeniedId,
        status: "IN_REVIEW",
        ownerUserId: bobId,
        createdBy: bobId,
        updatedBy: bobId,
      },
      {
        id: docDeletedId,
        organizationId: orgId,
        title: "Documento Excluído",
        categoryId,
        folderId: folderAllowedId,
        status: "DELETED",
        ownerUserId: aliceId,
        createdBy: aliceId,
        updatedBy: aliceId,
      },
      {
        id: docForeignId,
        organizationId: otherOrgId,
        title: "Documento Estrangeiro",
        categoryId: otherCategoryId,
        folderId: null,
        status: "IN_REVIEW",
        ownerUserId: carolId,
        createdBy: carolId,
        updatedBy: carolId,
      },
    ]);

    const verAId = randomUUID();
    const verBId = randomUUID();
    const verDelId = randomUUID();
    const verForeignId = randomUUID();
    await db.insert(documentVersions).values([
      {
        id: verAId,
        documentId: docAId,
        versionNumber: 1,
        fileObjectId: fileAId,
        uploadedByUserId: aliceId,
      },
      {
        id: verBId,
        documentId: docBId,
        versionNumber: 1,
        fileObjectId: fileBId,
        uploadedByUserId: bobId,
      },
      {
        id: verDelId,
        documentId: docDeletedId,
        versionNumber: 1,
        fileObjectId: fileDelId,
        uploadedByUserId: aliceId,
      },
      {
        id: verForeignId,
        documentId: docForeignId,
        versionNumber: 1,
        fileObjectId: fileForeignId,
        uploadedByUserId: carolId,
      },
    ]);

    const defRepo = createWorkflowDefinitionRepository(db);
    const createdDef = await defRepo.createWithInitialVersion({
      definitionId: randomUUID(),
      versionId: randomUUID(),
      organizationId: orgId,
      name: "Fluxo Aprovação Inbox",
      description: null,
      steps: [
        {
          stepOrder: 1,
          name: "Revisão Inicial",
          assignee: { type: "USER", userId: aliceId },
          dueDays: 1,
        },
        {
          stepOrder: 2,
          name: "Comitê Jurídico",
          assignee: { type: "GROUP", groupId: juridicoGroupId },
          dueDays: 5,
        },
        {
          stepOrder: 3,
          name: "Arquivo Final",
          assignee: { type: "USER", userId: aliceId },
          dueDays: 3,
        },
      ],
      createdByUserId: aliceId,
    });

    const foreignDef = await defRepo.createWithInitialVersion({
      definitionId: randomUUID(),
      versionId: randomUUID(),
      organizationId: otherOrgId,
      name: "Fluxo Externo",
      description: null,
      steps: [
        {
          stepOrder: 1,
          name: "Etapa Ext",
          assignee: { type: "USER", userId: carolId },
          dueDays: 2,
        },
      ],
      createdByUserId: carolId,
    });

    const instAId = randomUUID();
    const instBId = randomUUID();
    const instDelId = randomUUID();
    const instForeignId = randomUUID();

    await db.insert(workflowInstances).values([
      {
        id: instAId,
        organizationId: orgId,
        documentId: docAId,
        documentVersionId: verAId,
        workflowDefinitionVersionId: createdDef.version.id,
        status: "ACTIVE",
        currentStepOrder: 1,
        startedByUserId: aliceId,
      },
      {
        id: instBId,
        organizationId: orgId,
        documentId: docBId,
        documentVersionId: verBId,
        workflowDefinitionVersionId: createdDef.version.id,
        status: "ACTIVE",
        currentStepOrder: 1,
        startedByUserId: bobId,
      },
      {
        id: instDelId,
        organizationId: orgId,
        documentId: docDeletedId,
        documentVersionId: verDelId,
        workflowDefinitionVersionId: createdDef.version.id,
        status: "ACTIVE",
        currentStepOrder: 1,
        startedByUserId: aliceId,
      },
      {
        id: instForeignId,
        organizationId: otherOrgId,
        documentId: docForeignId,
        documentVersionId: verForeignId,
        workflowDefinitionVersionId: foreignDef.version.id,
        status: "ACTIVE",
        currentStepOrder: 1,
        startedByUserId: carolId,
      },
    ]);

    const taskOverdueAliceId = randomUUID();
    const taskGroupAliceId = randomUUID();
    const taskApprovedAliceId = randomUUID();
    const taskBobId = randomUUID();
    const taskDeletedDocId = randomUUID();
    const taskForeignId = randomUUID();

    await db.insert(workflowTasks).values([
      {
        id: taskOverdueAliceId,
        organizationId: orgId,
        workflowInstanceId: instAId,
        documentId: docAId,
        documentVersionId: verAId,
        stepOrder: 1,
        status: "PENDING",
        assigneeType: "USER",
        assigneeTargetId: aliceId,
        dueAt: new Date("2026-11-20T12:00:00.000Z"), // Overdue relative to fixedNow!
      },
      {
        id: taskGroupAliceId,
        organizationId: orgId,
        workflowInstanceId: instAId,
        documentId: docAId,
        documentVersionId: verAId,
        stepOrder: 2,
        status: "PENDING",
        assigneeType: "GROUP",
        assigneeTargetId: juridicoGroupId,
        dueAt: new Date("2026-11-26T12:00:00.000Z"),
      },
      {
        id: taskApprovedAliceId,
        organizationId: orgId,
        workflowInstanceId: instAId,
        documentId: docAId,
        documentVersionId: verAId,
        stepOrder: 3,
        status: "APPROVED",
        assigneeType: "USER",
        assigneeTargetId: aliceId,
        dueAt: null,
        decidedAt: new Date("2026-11-21T10:00:00.000Z"),
      },
      {
        id: taskBobId,
        organizationId: orgId,
        workflowInstanceId: instBId,
        documentId: docBId,
        documentVersionId: verBId,
        stepOrder: 1,
        status: "PENDING",
        assigneeType: "USER",
        assigneeTargetId: bobId,
      },
      {
        id: taskDeletedDocId,
        organizationId: orgId,
        workflowInstanceId: instDelId,
        documentId: docDeletedId,
        documentVersionId: verDelId,
        stepOrder: 1,
        status: "PENDING",
        assigneeType: "USER",
        assigneeTargetId: aliceId,
      },
      {
        id: taskForeignId,
        organizationId: otherOrgId,
        workflowInstanceId: instForeignId,
        documentId: docForeignId,
        documentVersionId: verForeignId,
        stepOrder: 1,
        status: "PENDING",
        assigneeType: "USER",
        assigneeTargetId: carolId,
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
    };

    const sessionService = createSessionService({ store: sessionStore });
    const authService = createAuthService({
      passwordService,
      sessionService,
      users: {
        async findCredentialByEmail(email) {
          const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
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
          const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
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
      taskDeps: {
        authzRepository: createAuthorizationRepository(db),
        documentRepository: createDocumentRepository(db),
        taskInboxRepository: createTaskInboxRepository(db),
        now: () => fixedNow,
      },
    });

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
        payload: { email, password: "SenhaTaskInbox123!" },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie =
        loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
      return { [SESSION_COOKIE_NAME]: sessionCookie };
    };

    // Unauthenticated rejected
    const anonRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks`,
    });
    expect(anonRes.statusCode).toBe(401);

    const aliceCookies = await login("alice-inbox@docuflow.local");

    // 1. Alice sees her USER + GROUP tasks (3 total), excluding Bob's task, deleted doc task, and foreign task
    const allAliceRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks?sortBy=stepOrder&sortDirection=asc`,
      cookies: aliceCookies,
    });
    expect(allAliceRes.statusCode).toBe(200);
    const allParsed = taskInboxListResponseSchema.parse(allAliceRes.json());
    expect(allParsed.data.pagination.totalItems).toBe(3);
    expect(allParsed.data.items.map((t) => t.id)).toEqual([
      taskOverdueAliceId,
      taskGroupAliceId,
      taskApprovedAliceId,
    ]);
    expect(allParsed.data.items[0]?.stepName).toBe("Revisão Inicial");
    expect(allParsed.data.items[0]?.isOverdue).toBe(true);
    expect(allParsed.data.items[1]?.stepName).toBe("Comitê Jurídico");
    expect(allParsed.data.items[1]?.isOverdue).toBe(false);

    // 2. Server-side filters & pagination
    const pendingGroupRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks?status=PENDING&assigneeType=GROUP`,
      cookies: aliceCookies,
    });
    expect(pendingGroupRes.statusCode).toBe(200);
    const pendingGroup = taskInboxListResponseSchema.parse(pendingGroupRes.json());
    expect(pendingGroup.data.pagination.totalItems).toBe(1);
    expect(pendingGroup.data.items[0]?.id).toBe(taskGroupAliceId);

    const overdueRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks?overdueOnly=true`,
      cookies: aliceCookies,
    });
    expect(overdueRes.statusCode).toBe(200);
    const overdue = taskInboxListResponseSchema.parse(overdueRes.json());
    expect(overdue.data.pagination.totalItems).toBe(1);
    expect(overdue.data.items[0]?.id).toBe(taskOverdueAliceId);

    const page2Res = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks?status=PENDING&sortBy=stepOrder&sortDirection=asc&page=2&pageSize=1`,
      cookies: aliceCookies,
    });
    expect(page2Res.statusCode).toBe(200);
    const page2 = taskInboxListResponseSchema.parse(page2Res.json());
    expect(page2.data.pagination.totalItems).toBe(2);
    expect(page2.data.pagination.totalPages).toBe(2);
    expect(page2.data.items).toHaveLength(1);
    expect(page2.data.items[0]?.id).toBe(taskGroupAliceId);

    // 3. Task detail authorization & IDOR protection
    const ownTaskDetailRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks/${taskGroupAliceId}`,
      cookies: aliceCookies,
    });
    expect(ownTaskDetailRes.statusCode).toBe(200);
    const detail = taskDetailResponseSchema.parse(ownTaskDetailRes.json());
    expect(detail.data.documentVersionNumber).toBe(1);
    expect(detail.data.workflowDefinitionName).toBe("Fluxo Aprovação Inbox");

    const forbiddenBobTaskRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks/${taskBobId}`,
      cookies: aliceCookies,
    });
    expect(forbiddenBobTaskRes.statusCode).toBe(403);

    const foreignTaskRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks/${taskForeignId}`,
      cookies: aliceCookies,
    });
    expect(foreignTaskRes.statusCode).toBe(404);

    await app.close();
  }, 60_000);
});
