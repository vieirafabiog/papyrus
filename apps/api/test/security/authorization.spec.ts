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
} from "@papyrus/auth";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createCategoryRepository,
  createDashboardRepository,
  createDocumentExpirationRepository,
  createDocumentRepository,
  createDocumentSearchRepository,
  createDocumentTrashRepository,
  createDocumentVersionRepository,
  createFolderRepository,
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
  createWorkflowTimelineRepository,
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
  userRoleScopes,
  users,
} from "@papyrus/database";
import {
  createDecideTaskUseCase,
  createDocumentUseCase,
  createDocumentVersionUseCase,
  createStartWorkflowUseCase,
  createWorkflowDefinitionService,
  createWorkflowTasksUseCase,
} from "@papyrus/domain";
import { createStorageProviderRegistry } from "@papyrus/storage-core";
import { createLocalStorageProvider } from "@papyrus/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/modules/auth/auth.routes.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

interface AuthSessionCookies {
  readonly cookies: Record<string, string>;
  readonly csrfHeader: Record<string, string>;
}

async function authenticateUser(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<AuthSessionCookies> {
  const csrfRes = await app.inject({
    method: "GET",
    url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
  });
  expect(csrfRes.statusCode).toBe(200);
  const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";
  expect(csrfToken.length).toBeGreaterThan(0);

  const loginRes = await app.inject({
    method: "POST",
    url: `${CONTRACTS_API_PREFIX}/auth/login`,
    cookies: { [CSRF_COOKIE_NAME]: csrfToken },
    headers: { [CSRF_HEADER_NAME]: csrfToken },
    payload: { email, password },
  });
  expect(loginRes.statusCode).toBe(200);
  const sessionCookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
  expect(sessionCookie.length).toBeGreaterThan(0);

  return {
    cookies: {
      [SESSION_COOKIE_NAME]: sessionCookie,
      [CSRF_COOKIE_NAME]: csrfToken,
    },
    csrfHeader: {
      [CSRF_HEADER_NAME]: csrfToken,
    },
  };
}

describe("Authorization, multi-tenant isolation and IDOR security tests (Step 16.05)", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;
  let app: FastifyInstance;
  let localStorageRoot = "";

  const password = "SecurityIsoPass!2026";

  // Tenant A IDs
  const orgAId = randomUUID();
  const adminAId = randomUUID();
  const scopedReaderAId = randomUUID();
  const noPermAId = randomUUID();
  const assignedReviewerAId = randomUUID();
  const unassignedReviewerAId = randomUUID();

  const catAllowedAId = randomUUID();
  const catSecretAId = randomUUID();
  const folderAllowedAId = randomUUID();
  const folderSecretAId = randomUUID();
  const storageAId = randomUUID();

  const docAllowedAId = randomUUID();
  const docDeniedExplicitAId = randomUUID();
  const docSecretAId = randomUUID();

  const verAllowedAId = randomUUID();
  const verDeniedExplicitAId = randomUUID();
  const verSecretAId = randomUUID();

  const fileAllowedAId = randomUUID();
  const fileDeniedExplicitAId = randomUUID();
  const fileSecretAId = randomUUID();

  const docAllowedTitle = "Contrato Público Permitido Alfa";
  const docDeniedTitle = "Contrato Bloqueado Explicit Deny Beta";
  const docSecretTitle = "Dossiê Confidencial Gama";

  // Tenant B IDs
  const orgBId = randomUUID();
  const adminBId = randomUUID();
  const catBId = randomUUID();
  const folderBId = randomUUID();
  const storageBId = randomUUID();
  const docBId = randomUUID();
  const verBId = randomUUID();
  const fileBId = randomUUID();

  let workflowDefAId = "";
  let taskSecretAId = "";

  const adminAEmail = `admin-a-${orgAId.slice(0, 6)}@tenant-a.local`;
  const scopedReaderAEmail = `reader-a-${orgAId.slice(0, 6)}@tenant-a.local`;
  const noPermAEmail = `noperm-a-${orgAId.slice(0, 6)}@tenant-a.local`;
  const assignedReviewerAEmail = `rev1-a-${orgAId.slice(0, 6)}@tenant-a.local`;
  const unassignedReviewerAEmail = `rev2-a-${orgAId.slice(0, 6)}@tenant-a.local`;
  const adminBEmail = `admin-b-${orgBId.slice(0, 6)}@tenant-b.local`;

  const allowedPdfBytes = Buffer.from("%PDF-1.7\nAllowed Security Document\n%%EOF\n", "utf8");
  const deniedPdfBytes = Buffer.from("%PDF-1.7\nExplicit Deny Document\n%%EOF\n", "utf8");
  const secretPdfBytes = Buffer.from("%PDF-1.7\nTop Secret Document Content\n%%EOF\n", "utf8");
  const tenantBPdfBytes = Buffer.from("%PDF-1.7\nTenant B Isolated Document\n%%EOF\n", "utf8");

  beforeAll(async () => {
    localStorageRoot = await mkdtemp(path.join(os.tmpdir(), "papyrus-authz-sec-"));
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

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword(password);

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

    await db.insert(organizations).values([
      { id: orgAId, name: "Tenant A Corp", slug: `tenant-a-${orgAId.slice(0, 8)}` },
      { id: orgBId, name: "Tenant B Corp", slug: `tenant-b-${orgBId.slice(0, 8)}` },
    ]);

    const adminRoleAId = randomUUID();
    const viewerRoleAId = randomUUID();
    const reviewerRoleAId = randomUUID();
    const adminRoleBId = randomUUID();

    await db.insert(roles).values([
      {
        id: adminRoleAId,
        organizationId: orgAId,
        key: "admin",
        name: "Administrador A",
        isSystem: true,
      },
      {
        id: viewerRoleAId,
        organizationId: orgAId,
        key: "viewer",
        name: "Consulta A",
        isSystem: true,
      },
      {
        id: reviewerRoleAId,
        organizationId: orgAId,
        key: "reviewer",
        name: "Revisor A",
        isSystem: true,
      },
      {
        id: adminRoleBId,
        organizationId: orgBId,
        key: "admin",
        name: "Administrador B",
        isSystem: true,
      },
    ]);

    const allPermPairs = [
      ...SYSTEM_ROLE_DEFINITIONS.admin.permissions,
      ...SYSTEM_ROLE_DEFINITIONS.viewer.permissions,
      ...SYSTEM_ROLE_DEFINITIONS.reviewer.permissions,
    ];
    await db
      .insert(permissions)
      .values(
        allPermPairs.map((pair) => ({
          id: randomUUID(),
          action: pair.action,
          resource: pair.resource,
        })),
      )
      .onConflictDoNothing();

    const permRows = await db.select().from(permissions);
    const permIdByKey = new Map(permRows.map((p) => [`${p.action}:${p.resource}`, p.id]));

    const mapRolePerms = (
      roleId: string,
      pairs: ReadonlyArray<{ readonly action: string; readonly resource: string }>,
    ) =>
      pairs
        .map((pair) => permIdByKey.get(`${pair.action}:${pair.resource}`))
        .filter((id): id is string => id !== undefined)
        .map((permissionId) => ({ roleId, permissionId }));

    await db
      .insert(rolePermissions)
      .values([
        ...mapRolePerms(adminRoleAId, SYSTEM_ROLE_DEFINITIONS.admin.permissions),
        ...mapRolePerms(viewerRoleAId, SYSTEM_ROLE_DEFINITIONS.viewer.permissions),
        ...mapRolePerms(reviewerRoleAId, SYSTEM_ROLE_DEFINITIONS.reviewer.permissions),
        ...mapRolePerms(adminRoleBId, SYSTEM_ROLE_DEFINITIONS.admin.permissions),
      ]);

    await db.insert(users).values([
      {
        id: adminAId,
        organizationId: orgAId,
        email: adminAEmail,
        fullName: "Admin Tenant A",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: scopedReaderAId,
        organizationId: orgAId,
        email: scopedReaderAEmail,
        fullName: "Scoped Reader A",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: noPermAId,
        organizationId: orgAId,
        email: noPermAEmail,
        fullName: "No Perm User A",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: assignedReviewerAId,
        organizationId: orgAId,
        email: assignedReviewerAEmail,
        fullName: "Assigned Reviewer A",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: unassignedReviewerAId,
        organizationId: orgAId,
        email: unassignedReviewerAEmail,
        fullName: "Unassigned Reviewer A",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: adminBId,
        organizationId: orgBId,
        email: adminBEmail,
        fullName: "Admin Tenant B",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(categories).values([
      { id: catAllowedAId, organizationId: orgAId, name: "Categoria Pública A", isActive: true },
      { id: catSecretAId, organizationId: orgAId, name: "Categoria Restrita A", isActive: true },
      { id: catBId, organizationId: orgBId, name: "Categoria B", isActive: true },
    ]);

    await db.insert(folders).values([
      {
        id: folderAllowedAId,
        organizationId: orgAId,
        parentId: null,
        name: "Pasta Permitida A",
        materializedPath: `/${folderAllowedAId}`,
        status: "ACTIVE",
      },
      {
        id: folderSecretAId,
        organizationId: orgAId,
        parentId: null,
        name: "Pasta Confidencial A",
        materializedPath: `/${folderSecretAId}`,
        status: "ACTIVE",
      },
      {
        id: folderBId,
        organizationId: orgBId,
        parentId: null,
        name: "Pasta B",
        materializedPath: `/${folderBId}`,
        status: "ACTIVE",
      },
    ]);

    await db.insert(userRoleScopes).values([
      // Admin A: global allow em Org A
      {
        id: randomUUID(),
        organizationId: orgAId,
        userId: adminAId,
        roleId: adminRoleAId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
      // Scoped Reader A: ALLOW somente na folderAllowedA, DENY explícito em docDeniedExplicitA
      {
        id: randomUUID(),
        organizationId: orgAId,
        userId: scopedReaderAId,
        roleId: viewerRoleAId,
        scopeType: "FOLDER",
        scopeTargetId: folderAllowedAId,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgAId,
        userId: scopedReaderAId,
        roleId: viewerRoleAId,
        scopeType: "DOCUMENT",
        scopeTargetId: docDeniedExplicitAId,
        effect: "DENY",
      },
      // Assigned Reviewer A: acesso de revisor apenas na folderSecretA
      {
        id: randomUUID(),
        organizationId: orgAId,
        userId: assignedReviewerAId,
        roleId: reviewerRoleAId,
        scopeType: "FOLDER",
        scopeTargetId: folderSecretAId,
        effect: "ALLOW",
      },
      // Unassigned Reviewer A: acesso de revisor apenas na folderAllowedA (sem acesso a folderSecretA nem à tarefa)
      {
        id: randomUUID(),
        organizationId: orgAId,
        userId: unassignedReviewerAId,
        roleId: reviewerRoleAId,
        scopeType: "FOLDER",
        scopeTargetId: folderAllowedAId,
        effect: "ALLOW",
      },
      // Admin B: global allow apenas em Org B
      {
        id: randomUUID(),
        organizationId: orgBId,
        userId: adminBId,
        roleId: adminRoleBId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      },
    ]);

    await db.insert(storageConnections).values([
      {
        id: storageAId,
        organizationId: orgAId,
        name: "Local A",
        kind: "local",
        status: "ACTIVE",
        isDefault: true,
        nonSecretConfig: { rootDirectory: localStorageRoot },
      },
      {
        id: storageBId,
        organizationId: orgBId,
        name: "Local B",
        kind: "local",
        status: "ACTIVE",
        isDefault: true,
        nonSecretConfig: { rootDirectory: localStorageRoot },
      },
    ]);

    const localProvider = createLocalStorageProvider({
      rootDirectory: localStorageRoot,
      fsync: false,
    });

    const keyAllowedA = `org/${orgAId}/documents/${docAllowedAId}/versions/${verAllowedAId}/${fileAllowedAId}`;
    const keyDeniedA = `org/${orgAId}/documents/${docDeniedExplicitAId}/versions/${verDeniedExplicitAId}/${fileDeniedExplicitAId}`;
    const keySecretA = `org/${orgAId}/documents/${docSecretAId}/versions/${verSecretAId}/${fileSecretAId}`;
    const keyB = `org/${orgBId}/documents/${docBId}/versions/${verBId}/${fileBId}`;

    const putBinary = async (key: string, data: Buffer) => {
      await localProvider.putObject({
        key: { value: key },
        body: Readable.from(data),
        metadata: {
          contentType: "application/pdf",
          contentLength: data.byteLength,
          checksumSha256: sha256Hex(data),
        },
      });
    };

    await Promise.all([
      putBinary(keyAllowedA, allowedPdfBytes),
      putBinary(keyDeniedA, deniedPdfBytes),
      putBinary(keySecretA, secretPdfBytes),
      putBinary(keyB, tenantBPdfBytes),
    ]);

    await db.insert(fileObjects).values([
      {
        id: fileAllowedAId,
        organizationId: orgAId,
        storageConnectionId: storageAId,
        objectKey: keyAllowedA,
        originalFileName: "permitido-a.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: allowedPdfBytes.byteLength,
        checksumSha256: sha256Hex(allowedPdfBytes),
        status: "AVAILABLE",
      },
      {
        id: fileDeniedExplicitAId,
        organizationId: orgAId,
        storageConnectionId: storageAId,
        objectKey: keyDeniedA,
        originalFileName: "bloqueado-explicit-a.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: deniedPdfBytes.byteLength,
        checksumSha256: sha256Hex(deniedPdfBytes),
        status: "AVAILABLE",
      },
      {
        id: fileSecretAId,
        organizationId: orgAId,
        storageConnectionId: storageAId,
        objectKey: keySecretA,
        originalFileName: "secreto-a.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: secretPdfBytes.byteLength,
        checksumSha256: sha256Hex(secretPdfBytes),
        status: "AVAILABLE",
      },
      {
        id: fileBId,
        organizationId: orgBId,
        storageConnectionId: storageBId,
        objectKey: keyB,
        originalFileName: "tenant-b.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: tenantBPdfBytes.byteLength,
        checksumSha256: sha256Hex(tenantBPdfBytes),
        status: "AVAILABLE",
      },
    ]);

    const futureExpiration = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    await db.insert(documents).values([
      {
        id: docAllowedAId,
        organizationId: orgAId,
        title: docAllowedTitle,
        categoryId: catAllowedAId,
        folderId: folderAllowedAId,
        status: "DRAFT",
        ownerUserId: adminAId,
        expirationDate: futureExpiration,
        createdBy: adminAId,
        updatedBy: adminAId,
      },
      {
        id: docDeniedExplicitAId,
        organizationId: orgAId,
        title: docDeniedTitle,
        categoryId: catAllowedAId,
        folderId: folderAllowedAId,
        status: "DRAFT",
        ownerUserId: adminAId,
        expirationDate: futureExpiration,
        createdBy: adminAId,
        updatedBy: adminAId,
      },
      {
        id: docSecretAId,
        organizationId: orgAId,
        title: docSecretTitle,
        categoryId: catSecretAId,
        folderId: folderSecretAId,
        status: "DRAFT",
        ownerUserId: adminAId,
        expirationDate: futureExpiration,
        createdBy: adminAId,
        updatedBy: adminAId,
      },
      {
        id: docBId,
        organizationId: orgBId,
        title: "Documento Isolado Tenant B",
        categoryId: catBId,
        folderId: folderBId,
        status: "DRAFT",
        ownerUserId: adminBId,
        expirationDate: futureExpiration,
        createdBy: adminBId,
        updatedBy: adminBId,
      },
    ]);

    await db.insert(documentVersions).values([
      {
        id: verAllowedAId,
        documentId: docAllowedAId,
        versionNumber: 1,
        fileObjectId: fileAllowedAId,
        uploadedByUserId: adminAId,
        changeNote: "Versão permitida v1",
      },
      {
        id: verDeniedExplicitAId,
        documentId: docDeniedExplicitAId,
        versionNumber: 1,
        fileObjectId: fileDeniedExplicitAId,
        uploadedByUserId: adminAId,
        changeNote: "Versão negada v1",
      },
      {
        id: verSecretAId,
        documentId: docSecretAId,
        versionNumber: 1,
        fileObjectId: fileSecretAId,
        uploadedByUserId: adminAId,
        changeNote: "Versão secreta v1",
      },
      {
        id: verBId,
        documentId: docBId,
        versionNumber: 1,
        fileObjectId: fileBId,
        uploadedByUserId: adminBId,
        changeNote: "Versão tenant B v1",
      },
    ]);

    await Promise.all([
      db
        .update(documents)
        .set({ currentVersionId: verAllowedAId })
        .where(eq(documents.id, docAllowedAId)),
      db
        .update(documents)
        .set({ currentVersionId: verDeniedExplicitAId })
        .where(eq(documents.id, docDeniedExplicitAId)),
      db
        .update(documents)
        .set({ currentVersionId: verSecretAId })
        .where(eq(documents.id, docSecretAId)),
      db.update(documents).set({ currentVersionId: verBId }).where(eq(documents.id, docBId)),
    ]);

    // Auditoria distinta em Org A e Org B para testar isolamento na exportação
    await db.insert(auditEvents).values([
      {
        id: randomUUID(),
        organizationId: orgAId,
        actorUserId: adminAId,
        action: "DOCUMENT_CREATED",
        resourceType: "DOCUMENT",
        resourceId: docSecretAId,
        result: "SUCCESS",
        requestId: randomUUID(),
        metadata: { tag: "SECRET_ORG_A" },
      },
      {
        id: randomUUID(),
        organizationId: orgBId,
        actorUserId: adminBId,
        action: "DOCUMENT_CREATED",
        resourceType: "DOCUMENT",
        resourceId: docBId,
        result: "SUCCESS",
        requestId: randomUUID(),
        metadata: { tag: "PUBLIC_ORG_B" },
      },
    ]);

    const transactions = createTransactionManager(db);
    const auditRepository = createAuditRepository(db);
    const authzRepository = createAuthorizationRepository(db);
    const documentRepository = createDocumentRepository(db);
    const documentVersionRepository = createDocumentVersionRepository(db);
    const documentSearchRepository = createDocumentSearchRepository(db);
    const documentExpirationRepository = createDocumentExpirationRepository(db);
    const documentTrashRepository = createDocumentTrashRepository(db);
    const dashboardRepository = createDashboardRepository(db);
    const categoryRepository = createCategoryRepository(db);
    const folderRepository = createFolderRepository(db);
    const userRepository = createUserRepository(db);
    const uploadRepository = createUploadSessionRepository(db);
    const connectionRepository = createStorageConnectionRepository(db);
    const workflowDefinitionRepository = createWorkflowDefinitionRepository(db);
    const workflowInstanceRepository = createWorkflowInstanceRepository(db);
    const workflowTaskRepository = createWorkflowTaskRepository(db);
    const workflowDecisionRepository = createWorkflowDecisionRepository(db);
    const workflowTimelineRepository = createWorkflowTimelineRepository(db);
    const workflowAssigneeVerifier = createWorkflowAssigneeVerifier(db);
    const taskInboxRepository = createTaskInboxRepository(db);

    const storageRegistry = createStorageProviderRegistry();
    storageRegistry.registerFactory("local", ({ connection }) =>
      createLocalStorageProvider({
        rootDirectory: String(connection.nonSecretConfig.rootDirectory ?? ""),
        fsync: false,
      }),
    );

    const defService = createWorkflowDefinitionService({
      definitions: workflowDefinitionRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });
    const wfDef = await defService.createDefinition({
      organizationId: orgAId,
      actorUserId: adminAId,
      requestId: randomUUID(),
      name: "Aprovação Confidencial A",
      steps: [
        {
          stepOrder: 1,
          name: "Revisão Restrita",
          assignee: { type: "USER", userId: assignedReviewerAId },
          dueDays: 3,
        },
      ],
    });
    workflowDefAId = wfDef.definition.id;

    const startWorkflowService = createStartWorkflowUseCase({
      documents: documentRepository,
      documentVersions: documentVersionRepository,
      uploadSessions: uploadRepository,
      definitions: workflowDefinitionRepository,
      workflowInstances: workflowInstanceRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const createWorkflowTasksService = createWorkflowTasksUseCase({
      workflowInstances: workflowInstanceRepository,
      definitions: workflowDefinitionRepository,
      documents: documentRepository,
      tasks: workflowTaskRepository,
      transactions,
      audit: auditRepository,
      assigneeAuthorization: workflowAssigneeVerifier,
      generateId: () => randomUUID(),
    });

    const decideTaskService = createDecideTaskUseCase({
      tasks: workflowTaskRepository,
      decisions: workflowDecisionRepository,
      workflowInstances: workflowInstanceRepository,
      definitions: workflowDefinitionRepository,
      documents: documentRepository,
      transactions,
      audit: auditRepository,
      generateId: () => randomUUID(),
    });

    const startedSecretWf = await startWorkflowService.startWorkflow({
      organizationId: orgAId,
      actorUserId: adminAId,
      requestId: randomUUID(),
      documentId: docSecretAId,
      documentVersionId: verSecretAId,
      workflowDefinitionId: workflowDefAId,
    });
    const generatedSecretTask = await createWorkflowTasksService.generateTaskForStep({
      organizationId: orgAId,
      actorUserId: adminAId,
      requestId: randomUUID(),
      workflowInstanceId: startedSecretWf.instance.id,
      stepOrder: 1,
    });
    taskSecretAId = generatedSecretTask.task.id;

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

    const authService = createAuthService({
      passwordService,
      sessionService,
      authzRepository,
      auditRepository,
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
        async findProfileById(uid) {
          const [row] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
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
    });

    app = buildApp({
      logger: false,
      secureCookies: false,
      security: {
        loginRateLimit: { maxAttempts: 100, windowMs: 60_000 },
      },
      authService,
      auditRepository,
      auditDeps: {
        authzRepository,
        auditRepository,
      },
      documentDeps: {
        authzRepository,
        documentRepository,
        auditRepository,
        documentSearchRepository,
        documentExpirationRepository,
        dashboardRepository,
        categoryRepository,
        documentVersionRepository,
        uploadRepository,
        storageConnections: connectionRepository,
        storageRegistry,
        createDocumentService,
        createDocumentVersionService,
        documentTrashRepository,
      },
      taskDeps: {
        authzRepository,
        documentRepository,
        taskInboxRepository,
        decideTaskService,
        createWorkflowTasksService,
      },
      workflowDeps: {
        authzRepository,
        documentRepository,
        workflowDefinitionRepository,
        workflowTimelineRepository,
        startWorkflowService,
        createWorkflowTasksService,
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    if (localStorageRoot) {
      await rm(localStorageRoot, { recursive: true, force: true });
    }
  });

  it("blocks search, list, dashboard counts, and expiration counts from leaking restricted or cross-tenant records", async () => {
    const adminASession = await authenticateUser(app, adminAEmail, password);
    const readerASession = await authenticateUser(app, scopedReaderAEmail, password);
    const noPermASession = await authenticateUser(app, noPermAEmail, password);
    const adminBSession = await authenticateUser(app, adminBEmail, password);

    // 1. Baseline Admin A vê os 3 documentos da Org A (e nunca o do Tenant B)
    const adminList = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/search?page=1&pageSize=20`,
      cookies: adminASession.cookies,
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().pagination.totalItems).toBe(3);

    // 2. Usuário sem permissão recebe lista vazia e contagem 0 mesmo buscando por título/pasta secreta
    for (const query of [
      `${CONTRACTS_API_PREFIX}/documents?page=1&pageSize=20`,
      `${CONTRACTS_API_PREFIX}/documents/search?search=${encodeURIComponent("Confidencial")}`,
      `${CONTRACTS_API_PREFIX}/documents/search?folderId=${folderSecretAId}`,
    ]) {
      const res = await app.inject({
        method: "GET",
        url: query,
        cookies: noPermASession.cookies,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(0);
      expect(res.json().pagination.totalItems).toBe(0);
      expect(res.json().pagination.totalPages).toBe(0);
    }

    const noPermPostSearch = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/search`,
      cookies: noPermASession.cookies,
      headers: noPermASession.csrfHeader,
      payload: { search: "Contrato", folderId: folderAllowedAId, page: 1, pageSize: 20 },
    });
    expect(noPermPostSearch.statusCode).toBe(200);
    expect(noPermPostSearch.json().items).toHaveLength(0);
    expect(noPermPostSearch.json().pagination.totalItems).toBe(0);

    // 3. Usuário com escopo na folderAllowedA e DENY explícito em docDeniedExplicitA vê somente 1 item
    const readerSearch = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/search?folderId=${folderAllowedAId}`,
      cookies: readerASession.cookies,
    });
    expect(readerSearch.statusCode).toBe(200);
    expect(readerSearch.json().pagination.totalItems).toBe(1);
    expect(readerSearch.json().items.map((item: { id: string }) => item.id)).toEqual([
      docAllowedAId,
    ]);

    // Pesquisa direcionada ao documento negado explicitamente retorna 0 sem vazar contagem
    const readerDeniedProbe = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/search?search=${encodeURIComponent(docDeniedTitle)}`,
      cookies: readerASession.cookies,
    });
    expect(readerDeniedProbe.statusCode).toBe(200);
    expect(readerDeniedProbe.json().pagination.totalItems).toBe(0);
    expect(readerDeniedProbe.json().items).toHaveLength(0);

    // 4. Tenant B (mesmo como admin) vê exclusivamente docB e nunca dados de Tenant A
    const tenantBSearch = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/search?folderId=${folderAllowedAId}`,
      cookies: adminBSession.cookies,
    });
    expect(tenantBSearch.statusCode).toBe(200);
    expect(tenantBSearch.json().pagination.totalItems).toBe(0);

    // 5. Contagens de Dashboard e Vencimentos respeitam escopo e isolamento multi-tenant
    const noPermDash = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/dashboard/summary`,
      cookies: noPermASession.cookies,
    });
    expect(noPermDash.statusCode).toBe(200);
    expect(noPermDash.json().data.totalDocuments).toBe(0);
    expect(noPermDash.json().data.expiringSoonDocuments).toBe(0);
    expect(noPermDash.json().data.pendingTasks).toBe(0);

    const readerDash = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/dashboard/summary`,
      cookies: readerASession.cookies,
    });
    expect(readerDash.statusCode).toBe(200);
    expect(readerDash.json().data.totalDocuments).toBe(1);
    expect(readerDash.json().data.expiringSoonDocuments).toBe(1);
    expect(readerDash.json().data.pendingTasks).toBe(0);

    const readerExpirations = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/expirations?bucket=ALL`,
      cookies: readerASession.cookies,
    });
    expect(readerExpirations.statusCode).toBe(200);
    expect(readerExpirations.json().data.pagination.totalItems).toBe(1);
    expect(readerExpirations.json().data.items[0].id).toBe(docAllowedAId);
  });

  it("blocks unauthorized and IDOR attempts across preview and download endpoints", async () => {
    const readerASession = await authenticateUser(app, scopedReaderAEmail, password);
    const noPermASession = await authenticateUser(app, noPermAEmail, password);
    const adminBSession = await authenticateUser(app, adminBEmail, password);

    // Controle positivo: readerA acessa preview e download do docAllowedA
    const okPreview = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/preview`,
      cookies: readerASession.cookies,
    });
    expect(okPreview.statusCode).toBe(200);
    expect(okPreview.rawPayload.equals(allowedPdfBytes)).toBe(true);

    const okDownload = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/download`,
      cookies: readerASession.cookies,
    });
    expect(okDownload.statusCode).toBe(200);
    expect(okDownload.rawPayload.equals(allowedPdfBytes)).toBe(true);

    // Sem autenticação -> 401
    const unauthPreview = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/preview`,
    });
    expect(unauthPreview.statusCode).toBe(401);

    // Preview e /content negados para usuário sem permissão, DENY explícito e cross-tenant
    for (const [session, targetDocId, expectedStatus] of [
      [noPermASession, docAllowedAId, 403],
      [readerASession, docDeniedExplicitAId, 403],
      [readerASession, docSecretAId, 403],
      [adminBSession, docAllowedAId, 404],
      [adminBSession, docSecretAId, 404],
    ] as const) {
      const previewRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/${targetDocId}/preview`,
        cookies: session.cookies,
      });
      expect(previewRes.statusCode).toBe(expectedStatus);

      const contentRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/${targetDocId}/content`,
        cookies: session.cookies,
      });
      expect(contentRes.statusCode).toBe(expectedStatus);

      const targetRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/documents/${targetDocId}/download-target`,
        cookies: session.cookies,
        headers: session.csrfHeader,
        payload: {},
      });
      expect(targetRes.statusCode).toBe(expectedStatus);

      const streamRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/documents/${targetDocId}/download`,
        cookies: session.cookies,
      });
      expect(streamRes.statusCode).toBe(expectedStatus);
    }

    // IDOR por troca de versionId de outro documento no docAllowedA
    const crossDocPreviewIdor = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/preview?versionId=${verSecretAId}`,
      cookies: readerASession.cookies,
    });
    expect(crossDocPreviewIdor.statusCode).toBe(404);

    const crossDocDownloadIdor = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/download-target`,
      cookies: readerASession.cookies,
      headers: readerASession.csrfHeader,
      payload: { versionId: verSecretAId },
    });
    expect(crossDocDownloadIdor.statusCode).toBe(404);
  });

  it("blocks unauthorized version listing, creation, and cross-document version restore IDOR", async () => {
    const adminASession = await authenticateUser(app, adminAEmail, password);
    const readerASession = await authenticateUser(app, scopedReaderAEmail, password);
    const noPermASession = await authenticateUser(app, noPermAEmail, password);
    const adminBSession = await authenticateUser(app, adminBEmail, password);

    // Leitura de versões negada fora do escopo ou para tenant diferente
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/versions`,
          cookies: noPermASession.cookies,
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docDeniedExplicitAId}/versions`,
          cookies: readerASession.cookies,
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/versions`,
          cookies: adminBSession.cookies,
        })
      ).statusCode,
    ).toBe(404);

    // Reader tem READ/DOWNLOAD em docAllowedA, mas não UPLOAD -> criação e restauração bloqueadas (403)
    const createVersionDenied = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/versions`,
      cookies: readerASession.cookies,
      headers: readerASession.csrfHeader,
      payload: {
        expectedVersion: 1,
        fileObjectId: fileAllowedAId,
        changeNote: "Tentativa sem permissão UPLOAD",
      },
    });
    expect(createVersionDenied.statusCode).toBe(403);

    const restoreVersionDenied = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/versions/${verAllowedAId}/restore`,
      cookies: readerASession.cookies,
      headers: readerASession.csrfHeader,
      payload: { expectedVersion: 1 },
    });
    expect(restoreVersionDenied.statusCode).toBe(403);

    // IDOR: mesmo adminA tentando restaurar uma versão de outro documento (docSecretA / docB) em docAllowedA falha (404)
    const crossDocRestore = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/versions/${verSecretAId}/restore`,
      cookies: adminASession.cookies,
      headers: adminASession.csrfHeader,
      payload: { expectedVersion: 1 },
    });
    expect(crossDocRestore.statusCode).toBe(404);

    const crossTenantRestore = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/versions/${verBId}/restore`,
      cookies: adminASession.cookies,
      headers: adminASession.csrfHeader,
      payload: { expectedVersion: 1 },
    });
    expect(crossTenantRestore.statusCode).toBe(404);
  });

  it("blocks unauthorized workflow timeline read, start, task access, and task decision IDOR", async () => {
    const readerASession = await authenticateUser(app, scopedReaderAEmail, password);
    const noPermASession = await authenticateUser(app, noPermAEmail, password);
    const assignedRevSession = await authenticateUser(app, assignedReviewerAEmail, password);
    const unassignedRevSession = await authenticateUser(app, unassignedReviewerAEmail, password);
    const adminBSession = await authenticateUser(app, adminBEmail, password);

    // Timeline negada para usuário sem acesso ao documento
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docSecretAId}/workflows`,
          cookies: noPermASession.cookies,
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docSecretAId}/workflows`,
          cookies: unassignedRevSession.cookies,
        })
      ).statusCode,
    ).toBe(403);

    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/documents/${docSecretAId}/workflows`,
          cookies: adminBSession.cookies,
        })
      ).statusCode,
    ).toBe(404);

    // Usuário leitor sem permissão UPDATE não pode iniciar fluxo
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/documents/${docAllowedAId}/workflows`,
          cookies: readerASession.cookies,
          headers: readerASession.csrfHeader,
          payload: { workflowDefinitionId: workflowDefAId, expectedDocumentVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);

    // Caixa de tarefas: somente assignedReviewerA enxerga taskSecretAId
    const assignedInbox = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks?status=PENDING`,
      cookies: assignedRevSession.cookies,
    });
    expect(assignedInbox.statusCode).toBe(200);
    expect(assignedInbox.json().data.pagination.totalItems).toBe(1);
    expect(assignedInbox.json().data.items[0].id).toBe(taskSecretAId);

    for (const session of [noPermASession, unassignedRevSession, adminBSession]) {
      const inbox = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/tasks`,
        cookies: session.cookies,
      });
      expect(inbox.statusCode).toBe(200);
      expect(inbox.json().data.items).toHaveLength(0);
      expect(inbox.json().data.pagination.totalItems).toBe(0);
    }

    // Acesso direto /tasks/:id e decisão /tasks/:id/decision bloqueados para terceiros e outro tenant
    for (const [session, expectedTaskStatus] of [
      [noPermASession, 403],
      [unassignedRevSession, 403],
      [readerASession, 403],
      [adminBSession, 404],
    ] as const) {
      const getTaskRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/tasks/${taskSecretAId}`,
        cookies: session.cookies,
      });
      expect(getTaskRes.statusCode).toBe(expectedTaskStatus);

      const decideRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/tasks/${taskSecretAId}/decision`,
        cookies: session.cookies,
        headers: session.csrfHeader,
        payload: { decision: "APPROVE", comment: "Tentativa IDOR" },
      });
      expect([403, 404]).toContain(decideRes.statusCode);
    }

    // Tarefa permanece PENDING após todas as tentativas bloqueadas
    const stillPending = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/tasks/${taskSecretAId}`,
      cookies: assignedRevSession.cookies,
    });
    expect(stillPending.statusCode).toBe(200);
    expect(stillPending.json().data.status).toBe("PENDING");
  });

  it("blocks unauthorized audit queries/exports and prevents cross-tenant export leakage", async () => {
    const readerASession = await authenticateUser(app, scopedReaderAEmail, password);
    const noPermASession = await authenticateUser(app, noPermAEmail, password);
    const adminBSession = await authenticateUser(app, adminBEmail, password);

    for (const session of [readerASession, noPermASession]) {
      const listRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/admin/audit-events`,
        cookies: session.cookies,
      });
      expect(listRes.statusCode).toBe(403);

      const facetsRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/admin/audit-events/facets`,
        cookies: session.cookies,
      });
      expect(facetsRes.statusCode).toBe(403);

      const exportCsvRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/admin/audit-events/export?format=csv`,
        cookies: session.cookies,
      });
      expect(exportCsvRes.statusCode).toBe(403);

      const exportJsonRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/admin/audit-events/export?format=json`,
        cookies: session.cookies,
      });
      expect(exportJsonRes.statusCode).toBe(403);
    }

    // Exportação do Admin B inclui apenas eventos do Tenant B, jamais eventos/IDs do Tenant A
    const exportOrgBRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/admin/audit-events/export?format=json`,
      cookies: adminBSession.cookies,
    });
    expect(exportOrgBRes.statusCode).toBe(200);
    expect(exportOrgBRes.body).not.toContain(orgAId);
    expect(exportOrgBRes.body).not.toContain(docSecretAId);
    expect(exportOrgBRes.body).not.toContain("SECRET_ORG_A");
    expect(exportOrgBRes.body).toContain(docBId);
  });
});
