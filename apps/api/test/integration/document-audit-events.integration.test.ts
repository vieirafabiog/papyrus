import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
  categoryFields,
  createAuditRepository,
  createAuthorizationRepository,
  createCategoryRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createFolderRepository,
  createGroupRepository,
  createPermissionScopeRepository,
  createStorageConnectionRepository,
  createTaskInboxRepository,
  createTransactionManager,
  createUploadSessionRepository,
  createUserRepository,
  createWorkflowAssigneeVerifier,
  createWorkflowDecisionRepository,
  createWorkflowDefinitionRepository,
  createWorkflowInstanceRepository,
  createWorkflowTaskRepository,
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
} from "@docuflow/database";
import {
  archiveDocumentUseCase,
  createDecideTaskUseCase,
  createDocumentUseCase,
  createDocumentVersionUseCase,
  createPermissionAdministrationService,
  createStartWorkflowUseCase,
  createWorkflowDefinitionService,
  createWorkflowTasksUseCase,
  moveDocumentUseCase,
  trashDocumentUseCase,
} from "@docuflow/domain";
import { createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq } from "drizzle-orm";
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

describe("Document, version, download, permission and workflow audit events (Step 13.02)", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  let tempStorageDir: string;

  beforeAll(async () => {
    tempStorageDir = await mkdtemp(path.join(os.tmpdir(), "docuflow-audit-events-test-"));
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
    if (tempStorageDir) {
      await rm(tempStorageDir, { recursive: true, force: true });
    }
  });

  it("emits C.10 document, version, download/preview, permission, denial, and workflow audit events without duplicates or sensitive leaks", async () => {
    const db = drizzle(pool);
    const orgId = randomUUID();
    const adminId = randomUUID();
    const readerId = randomUUID();
    const deniedUserId = randomUUID();
    const adminRoleId = randomUUID();
    const reviewerRoleId = randomUUID();
    const viewerRoleId = randomUUID();
    const categoryId = randomUUID();
    const folderAId = randomUUID();
    const folderBId = randomUUID();
    const storageId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Auditoria C10 Org",
      slug: `audit-c10-${orgId.slice(0, 8)}`,
    });

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword("SenhaAuditoria!2026");

    await db.insert(users).values([
      {
        id: adminId,
        organizationId: orgId,
        email: `admin-audit-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Admin Auditoria",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: readerId,
        organizationId: orgId,
        email: `reader-audit-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Leitor Auditoria",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: deniedUserId,
        organizationId: orgId,
        email: `denied-audit-${orgId.slice(0, 6)}@docuflow.local`,
        fullName: "Negado Auditoria",
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
        id: reviewerRoleId,
        organizationId: orgId,
        key: "reviewer",
        name: "Revisor",
        isSystem: true,
      },
      {
        id: viewerRoleId,
        organizationId: orgId,
        key: "viewer",
        name: "Leitor",
        isSystem: true,
      },
    ]);

    const neededPairs = [
      ...SYSTEM_ROLE_DEFINITIONS.admin.permissions,
      ...SYSTEM_ROLE_DEFINITIONS.reviewer.permissions,
      ...SYSTEM_ROLE_DEFINITIONS.viewer.permissions,
    ];
    for (const pair of neededPairs) {
      await db
        .insert(permissions)
        .values({ id: randomUUID(), action: pair.action, resource: pair.resource })
        .onConflictDoNothing();
    }
    const allPerms = await db.select().from(permissions);
    const permByKey = new Map(allPerms.map((p) => [`${p.action}:${p.resource}`, p.id]));

    for (const [roleId, def] of [
      [adminRoleId, SYSTEM_ROLE_DEFINITIONS.admin],
      [reviewerRoleId, SYSTEM_ROLE_DEFINITIONS.reviewer],
      [viewerRoleId, SYSTEM_ROLE_DEFINITIONS.viewer],
    ] as const) {
      for (const pair of def.permissions) {
        const pid = permByKey.get(`${pair.action}:${pair.resource}`);
        if (pid) {
          await db.insert(rolePermissions).values({ roleId, permissionId: pid });
        }
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
        userId: readerId,
        roleId: viewerRoleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
    ]);

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos Auditados",
      isActive: true,
    });
    await db.insert(categoryFields).values({
      id: randomUUID(),
      categoryId,
      key: "secret_salary_note",
      label: "Observação Confidencial",
      type: "TEXT",
      required: false,
      sortOrder: 0,
    });

    await db.insert(folders).values([
      {
        id: folderAId,
        organizationId: orgId,
        parentId: null,
        name: "Pasta Origem",
        materializedPath: `/${folderAId}`,
        status: "ACTIVE",
      },
      {
        id: folderBId,
        organizationId: orgId,
        parentId: null,
        name: "Pasta Destino",
        materializedPath: `/${folderBId}`,
        status: "ACTIVE",
      },
    ]);

    await db.insert(storageConnections).values({
      id: storageId,
      organizationId: orgId,
      name: "Local Audit Storage",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: tempStorageDir },
    });

    const localProvider = createLocalStorageProvider({ rootDirectory: tempStorageDir });
    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", async ({ connection }) => {
      const rootDir = connection.nonSecretConfig.rootDirectory;
      if (typeof rootDir !== "string" || rootDir.length === 0) {
        throw new Error("Missing rootDirectory");
      }
      return createLocalStorageProvider({ rootDirectory: rootDir });
    });

    const createStoredObject = async (opts: {
      readonly docId: string;
      readonly versionId: string;
      readonly fileId: string;
      readonly sessionId: string;
      readonly fileName: string;
      readonly content: Buffer;
      readonly status: "AVAILABLE" | "QUARANTINED";
      readonly finalized?: boolean | undefined;
    }): Promise<void> => {
      const objectKey = `org/${orgId}/documents/${opts.docId}/versions/${opts.versionId}/${opts.fileId}`;
      const sha256 = createHash("sha256").update(opts.content).digest("hex");
      await localProvider.putObject({
        key: { value: objectKey },
        body: Readable.from(opts.content),
        metadata: {
          contentType: "application/pdf",
          contentLength: opts.content.length,
          checksumSha256: sha256,
        },
      });
      await db.insert(fileObjects).values({
        id: opts.fileId,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey,
        originalFileName: opts.fileName,
        detectedContentType: "application/pdf",
        sizeBytes: opts.content.length,
        checksumSha256: sha256,
        status: opts.status,
      });
      if (opts.finalized !== false) {
        await db.insert(uploadSessions).values({
          id: opts.sessionId,
          organizationId: orgId,
          userId: adminId,
          storageConnectionId: storageId,
          fileObjectId: opts.fileId,
          declaredSizeBytes: opts.content.length,
          declaredContentType: "application/pdf",
          idempotencyKey: `audit-idem-${opts.sessionId}`,
          status: "FINALIZED",
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          finalizedAt: new Date("2026-11-21T17:00:00.000Z"),
        });
      }
    };

    const pdfV1 = Buffer.from("%PDF-1.4\n%audit-v1\n%%EOF\n");
    const pdfV2 = Buffer.from("%PDF-1.4\n%audit-v2\n%%EOF\n");
    const pdfQuarantined = Buffer.from("%PDF-1.4\n%quarantined\n%%EOF\n");

    const upload1Id = randomUUID();
    const file1Id = randomUUID();
    const upload2Id = randomUUID();
    const file2Id = randomUUID();
    const docQuarantinedId = randomUUID();
    const verQuarantinedId = randomUUID();
    const fileQuarantinedId = randomUUID();

    await createStoredObject({
      docId: randomUUID(),
      versionId: randomUUID(),
      fileId: file1Id,
      sessionId: upload1Id,
      fileName: "contrato-v1.pdf",
      content: pdfV1,
      status: "AVAILABLE",
    });
    await createStoredObject({
      docId: randomUUID(),
      versionId: randomUUID(),
      fileId: file2Id,
      sessionId: upload2Id,
      fileName: "contrato-v2.pdf",
      content: pdfV2,
      status: "AVAILABLE",
    });
    await createStoredObject({
      docId: docQuarantinedId,
      versionId: verQuarantinedId,
      fileId: fileQuarantinedId,
      sessionId: randomUUID(),
      fileName: "suspeito.pdf",
      content: pdfQuarantined,
      status: "QUARANTINED",
      finalized: false,
    });

    await db.insert(documents).values({
      id: docQuarantinedId,
      organizationId: orgId,
      title: "Arquivo Em Quarentena",
      categoryId,
      folderId: folderAId,
      status: "DRAFT",
      ownerUserId: adminId,
      createdBy: adminId,
      updatedBy: adminId,
    });
    await db.insert(documentVersions).values({
      id: verQuarantinedId,
      documentId: docQuarantinedId,
      versionNumber: 1,
      fileObjectId: fileQuarantinedId,
      uploadedByUserId: adminId,
    });
    await db
      .update(documents)
      .set({ currentVersionId: verQuarantinedId })
      .where(eq(documents.id, docQuarantinedId));

    const transactions = createTransactionManager(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const documentVersionRepository = createDocumentVersionRepository(db);
    const categoryRepository = createCategoryRepository(db);
    const folderRepository = createFolderRepository(db);
    const userRepository = createUserRepository(db);
    const groupRepository = createGroupRepository(db);
    const uploadRepository = createUploadSessionRepository(db);
    const permissionScopeRepository = createPermissionScopeRepository(db);
    const definitionRepository = createWorkflowDefinitionRepository(db);
    const instanceRepository = createWorkflowInstanceRepository(db);
    const taskRepository = createWorkflowTaskRepository(db);
    const decisionRepository = createWorkflowDecisionRepository(db);
    const taskInboxRepository = createTaskInboxRepository(db);

    const createDocumentService = createDocumentUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      categories: categoryRepository,
      folders: folderRepository,
      users: userRepository,
      uploadSessions: uploadRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });
    const createDocumentVersionService = createDocumentVersionUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      uploadSessions: uploadRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });
    const moveDocumentService = moveDocumentUseCase({
      documents: documentRepository,
      folders: folderRepository,
      transactions,
      audit: auditRepository,
    });
    const archiveDocumentService = archiveDocumentUseCase({
      documents: documentRepository,
      transactions,
      audit: auditRepository,
    });
    const trashDocumentService = trashDocumentUseCase({
      documents: documentRepository,
      transactions,
      audit: auditRepository,
    });
    const permissionAdminService = createPermissionAdministrationService({
      permissionScopes: permissionScopeRepository,
      users: userRepository,
      groups: groupRepository,
      documents: documentRepository,
      folders: folderRepository,
      categories: categoryRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });
    const decideTaskService = createDecideTaskUseCase({
      tasks: taskRepository,
      decisions: decisionRepository,
      workflowInstances: instanceRepository,
      definitions: definitionRepository,
      documents: documentRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
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
          const isAdmin = row.id === adminId;
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
            roles: isAdmin
              ? [
                  {
                    id: adminRoleId,
                    key: "admin",
                    name: "Administrador",
                    description: null,
                    isSystem: true,
                  },
                ]
              : [],
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
      permissionAdminService,
      documentDeps: {
        authzRepository,
        documentRepository,
        auditRepository,
        categoryRepository,
        createDocumentService,
        createDocumentVersionService,
        moveDocumentService,
        archiveDocumentService,
        trashDocumentService,
        documentVersionRepository,
        uploadRepository,
        storageConnections: createStorageConnectionRepository(db),
        storageRegistry,
      },
      taskDeps: {
        authzRepository,
        documentRepository,
        taskInboxRepository,
        decideTaskService,
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
        payload: { email, password: "SenhaAuditoria!2026" },
      });
      expect(res.statusCode).toBe(200);
      const sessionCookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
      return { [SESSION_COOKIE_NAME]: sessionCookie, [CSRF_COOKIE_NAME]: csrfToken };
    };

    const adminCookies = await loginAs(`admin-audit-${orgId.slice(0, 6)}@docuflow.local`);
    const deniedCookies = await loginAs(`denied-audit-${orgId.slice(0, 6)}@docuflow.local`);

    const secretMetadataSentinel = "CONFIDENCIAL-SALARIO-999123";

    // 1. Document creation via CreateDocumentService (must emit ONLY 1 DOCUMENT_CREATED)
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/documents",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        title: "Contrato Auditado",
        categoryId,
        folderId: folderAId,
        uploadSessionId: upload1Id,
        metadata: { secret_salary_note: secretMetadataSentinel },
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdDoc = createRes.json().data as {
      id: string;
      version: number;
      currentVersionId: string;
    };

    // 2. View document (DOCUMENT_VIEWED)
    const viewRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${createdDoc.id}`,
      cookies: adminCookies,
    });
    expect(viewRes.statusCode).toBe(200);

    // 3. Update metadata (DOCUMENT_UPDATED with changedFields, WITHOUT raw sensitive metadata value)
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/documents/${createdDoc.id}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: createdDoc.version,
        title: "Contrato Auditado Atualizado",
        metadata: { secret_salary_note: `${secretMetadataSentinel}-V2` },
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const patchedDoc = patchRes.json().data as { id: string; version: number };

    // 4. New version + restore version (DOCUMENT_VERSION_CREATED + DOCUMENT_VERSION_RESTORED)
    const v2Res = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${createdDoc.id}/versions`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: patchedDoc.version,
        uploadSessionId: upload2Id,
        changeNote: "Atualização contratual",
      },
    });
    expect(v2Res.statusCode).toBe(201);
    const afterV2Doc = v2Res.json().document as { version: number };

    const restoreRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${createdDoc.id}/versions/${createdDoc.currentVersionId}/restore`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: afterV2Doc.version,
      },
    });
    expect(restoreRes.statusCode).toBe(201);
    const afterRestoreDoc = restoreRes.json().document as { version: number };

    // 5. Move document (DOCUMENT_MOVED)
    const moveRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${createdDoc.id}/move`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: afterRestoreDoc.version,
        targetFolderId: folderBId,
      },
    });
    expect(moveRes.statusCode).toBe(200);
    const movedDoc = moveRes.json().data as { version: number };

    // 6. Download & Preview success + Quarantined download/preview DENIED
    const targetRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${createdDoc.id}/download-target`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { preferSigned: false },
    });
    expect(targetRes.statusCode).toBe(200);

    const streamRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${createdDoc.id}/download`,
      cookies: adminCookies,
    });
    expect(streamRes.statusCode).toBe(200);

    const previewRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${createdDoc.id}/preview`,
      cookies: adminCookies,
    });
    expect(previewRes.statusCode).toBe(200);

    const deniedQuarantinedDownload = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${docQuarantinedId}/download-target`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { preferSigned: true },
    });
    expect(deniedQuarantinedDownload.statusCode).toBe(409);

    const deniedQuarantinedPreview = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docQuarantinedId}/preview`,
      cookies: adminCookies,
    });
    expect(deniedQuarantinedPreview.statusCode).toBe(409);

    // 7. Authorization denial via guard (AUTHORIZATION_DENIED)
    const deniedAuthzRes = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${createdDoc.id}`,
      cookies: deniedCookies,
    });
    expect(deniedAuthzRes.statusCode).toBe(403);

    // 8. Permission assignment & revocation (PERMISSION_ASSIGNED & PERMISSION_REVOKED)
    const assignPermRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/permissions/scopes",
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        subjectType: "USER",
        subjectId: deniedUserId,
        roleId: reviewerRoleId,
        scopeType: "DOCUMENT",
        scopeTargetId: createdDoc.id,
        effect: "ALLOW",
      },
    });
    expect(assignPermRes.statusCode).toBe(201);
    const assignedScopeId = assignPermRes.json().data.id as string;

    // 9. Workflow start, task generation, and task decision via HTTP
    const workflowDefService = createWorkflowDefinitionService({
      definitions: definitionRepository,
      categories: categoryRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });
    const wfDef = await workflowDefService.createDefinition({
      organizationId: orgId,
      actorUserId: adminId,
      requestId: randomUUID(),
      name: "Aprovação Contrato Auditado",
      steps: [
        {
          stepOrder: 1,
          name: "Revisão do Reviewer",
          assignee: { type: "USER", userId: deniedUserId },
          dueDays: null,
          commentRules: {
            requireOnApprove: false,
            requireOnReject: true,
            requireOnRequestChanges: true,
          },
        },
      ],
    });
    const startWorkflow = createStartWorkflowUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      uploadSessions: uploadRepository,
      definitions: definitionRepository,
      workflowInstances: instanceRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });
    const startedWf = await startWorkflow.startWorkflow({
      organizationId: orgId,
      actorUserId: adminId,
      requestId: randomUUID(),
      documentId: createdDoc.id,
      workflowDefinitionId: wfDef.definition.id,
      expectedDocumentVersion: movedDoc.version,
    });
    const createTasks = createWorkflowTasksUseCase({
      workflowInstances: instanceRepository,
      definitions: definitionRepository,
      documents: documentRepository,
      tasks: taskRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
      assigneeAuthorization: createWorkflowAssigneeVerifier(db),
    });
    const generatedTask = await createTasks.generateTaskForStep({
      organizationId: orgId,
      actorUserId: adminId,
      requestId: randomUUID(),
      workflowInstanceId: startedWf.instance.id,
      stepOrder: 1,
    });

    const decideRes = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${generatedTask.task.id}/decision`,
      cookies: deniedCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        action: "APPROVE",
        comment: "Aprovado dentro da auditoria C.10",
      },
    });
    expect(decideRes.statusCode).toBe(200);
    const decidedDoc = decideRes.json().data.document as { version: number; status: string };
    expect(decidedDoc.status).toBe("APPROVED");

    // Revoke permission assignment after workflow completes (PERMISSION_REVOKED)
    const revokePermRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/permissions/scopes/${assignedScopeId}`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(revokePermRes.statusCode).toBe(200);

    // 10. Archive & Trash document (DOCUMENT_ARCHIVED + DOCUMENT_TRASHED)
    const archiveRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${createdDoc.id}/archive`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: decidedDoc.version,
        reason: "Vigência concluída",
      },
    });
    expect(archiveRes.statusCode).toBe(200);
    const archivedDoc = archiveRes.json().data as { version: number };

    const trashRes = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${createdDoc.id}/trash`,
      cookies: adminCookies,
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        expectedVersion: archivedDoc.version,
        reason: "Descarte controlado de teste",
      },
    });
    expect(trashRes.statusCode).toBe(200);

    await app.close();

    // Verify all persisted audit events for this organization
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));

    const countByAction = new Map<string, number>();
    for (const row of rows) {
      countByAction.set(row.action, (countByAction.get(row.action) ?? 0) + 1);
    }

    // No duplicates for document lifecycle, versions, downloads, preview, permissions, workflow
    expect(countByAction.get("DOCUMENT_CREATED")).toBe(1);
    expect(countByAction.get("DOCUMENT_VIEWED")).toBe(1);
    expect(countByAction.get("DOCUMENT_UPDATED")).toBe(1);
    expect(countByAction.get("DOCUMENT_VERSION_CREATED")).toBe(1);
    expect(countByAction.get("DOCUMENT_VERSION_RESTORED")).toBe(1);
    expect(countByAction.get("DOCUMENT_MOVED")).toBe(1);
    expect(countByAction.get("DOCUMENT_DOWNLOAD_REQUESTED")).toBe(1);
    expect(countByAction.get("DOCUMENT_DOWNLOADED")).toBe(1);
    expect(countByAction.get("DOCUMENT_PREVIEWED")).toBe(1);
    expect(countByAction.get("DOCUMENT_DOWNLOAD_DENIED")).toBe(1);
    expect(countByAction.get("DOCUMENT_PREVIEW_DENIED")).toBe(1);
    expect(countByAction.get("AUTHORIZATION_DENIED")).toBe(1);
    expect(countByAction.get("PERMISSION_ASSIGNED")).toBe(1);
    expect(countByAction.get("PERMISSION_REVOKED")).toBe(1);
    expect(countByAction.get("WORKFLOW_STARTED")).toBe(1);
    expect(countByAction.get("WORKFLOW_TASK_CREATED")).toBe(1);
    expect(countByAction.get("WORKFLOW_TASK_DECIDED")).toBe(1);
    expect(countByAction.get("DOCUMENT_ARCHIVED")).toBe(1);
    expect(countByAction.get("DOCUMENT_TRASHED")).toBe(1);

    // Assert DENIED statuses recorded faithfully
    const authzDenied = rows.find((r) => r.action === "AUTHORIZATION_DENIED");
    expect(authzDenied?.result).toBe("DENIED");
    expect(authzDenied?.actorUserId).toBe(deniedUserId);

    const downloadDenied = rows.find((r) => r.action === "DOCUMENT_DOWNLOAD_DENIED");
    expect(downloadDenied?.result).toBe("DENIED");
    expect(downloadDenied?.resourceId).toBe(docQuarantinedId);

    const previewDenied = rows.find((r) => r.action === "DOCUMENT_PREVIEW_DENIED");
    expect(previewDenied?.result).toBe("DENIED");
    expect(previewDenied?.resourceId).toBe(docQuarantinedId);

    // Assert DOCUMENT_UPDATED logs changed field names without raw sensitive values
    const docUpdated = rows.find((r) => r.action === "DOCUMENT_UPDATED");
    expect(docUpdated?.metadata).toMatchObject({
      version: patchedDoc.version,
      changedFields: "title,metadata",
      metadataKeyCount: 1,
    });

    // Ensure no raw metadata values, signed URLs, secrets, passwords or binary buffers exist in any audit record
    const serializedAudit = JSON.stringify(rows);
    expect(serializedAudit).not.toContain(secretMetadataSentinel);
    expect(serializedAudit).not.toContain("SenhaAuditoria!2026");
    expect(serializedAudit).not.toContain("dfvault:");
    expect(serializedAudit).not.toContain("%PDF-1.4");
  }, 120_000);
});
