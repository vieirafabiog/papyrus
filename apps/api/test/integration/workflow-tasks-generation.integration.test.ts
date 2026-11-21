import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_ROLE_DEFINITIONS, createPasswordService } from "@docuflow/auth";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createTransactionManager,
  createUploadSessionRepository,
  createWorkflowAssigneeVerifier,
  createWorkflowDefinitionRepository,
  createWorkflowInstanceRepository,
  createWorkflowTaskRepository,
  documentVersions,
  documents,
  fileObjects,
  folders,
  groups,
  organizations,
  permissions,
  rolePermissions,
  roles,
  storageConnections,
  userGroups,
  userRoleScopes,
  users,
  workflowTasks,
} from "@docuflow/database";
import {
  DomainError,
  createStartWorkflowUseCase,
  createWorkflowDefinitionService,
  createWorkflowTasksUseCase,
} from "@docuflow/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Workflow task generation idempotency and authorization integration", () => {
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

  it("generates step tasks for authorized users/groups idempotently across concurrent retries and blocks unauthorized assignees", async () => {
    const db = drizzle(pool);
    const fixedNow = new Date("2026-11-21T17:00:00.000Z");

    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const requesterId = randomUUID();
    const reviewerUserId = randomUUID();
    const deniedUserId = randomUUID();
    const inactiveUserId = randomUUID();
    const reviewerGroupId = randomUUID();
    const foreignGroupId = randomUUID();
    const reviewerRoleId = randomUUID();
    const categoryId = randomUUID();
    const folderId = randomUUID();
    const storageId = randomUUID();
    const fileId = randomUUID();
    const docId = randomUUID();
    const versionId = randomUUID();

    await db.insert(organizations).values([
      { id: orgId, name: "Org Workflow Tasks", slug: `wf-tasks-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Org Externa", slug: `wf-ext-${otherOrgId.slice(0, 8)}` },
    ]);

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword("SenhaWorkflowTasks123!");

    await db.insert(users).values([
      {
        id: requesterId,
        organizationId: orgId,
        email: "requester-wf@docuflow.local",
        fullName: "Solicitante WF",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: reviewerUserId,
        organizationId: orgId,
        email: "reviewer-wf@docuflow.local",
        fullName: "Revisor WF",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: deniedUserId,
        organizationId: orgId,
        email: "denied-wf@docuflow.local",
        fullName: "Usuário Negado WF",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: inactiveUserId,
        organizationId: orgId,
        email: "inactive-wf@docuflow.local",
        fullName: "Usuário Inativo WF",
        passwordHash,
        status: "INACTIVE",
      },
    ]);

    await db.insert(groups).values([
      { id: reviewerGroupId, organizationId: orgId, name: "Comitê Jurídico" },
      { id: foreignGroupId, organizationId: otherOrgId, name: "Comitê Externo" },
    ]);
    await db.insert(userGroups).values({
      id: randomUUID(),
      userId: reviewerUserId,
      groupId: reviewerGroupId,
    });

    await db.insert(roles).values({
      id: reviewerRoleId,
      organizationId: orgId,
      key: `reviewer_${orgId.slice(0, 6)}`,
      name: "Revisor",
      isSystem: true,
    });

    const permMap = new Map<string, string>();
    for (const pair of SYSTEM_ROLE_DEFINITIONS.reviewer.permissions) {
      const pid = randomUUID();
      await db
        .insert(permissions)
        .values({ id: pid, action: pair.action, resource: pair.resource })
        .onConflictDoNothing();
    }
    const existingPerms = await db.select().from(permissions);
    for (const p of existingPerms) {
      permMap.set(`${p.action}:${p.resource}`, p.id);
    }
    for (const pair of SYSTEM_ROLE_DEFINITIONS.reviewer.permissions) {
      const pid = permMap.get(`${pair.action}:${pair.resource}`);
      if (pid) {
        await db.insert(rolePermissions).values({ roleId: reviewerRoleId, permissionId: pid });
      }
    }

    await db.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos WF",
      isActive: true,
    });
    await db.insert(folders).values({
      id: folderId,
      organizationId: orgId,
      parentId: null,
      name: "Pasta Jurídico",
      materializedPath: "/Pasta Jurídico",
      status: "ACTIVE",
    });

    // Grant reviewerGroup ALLOW on folderId, and explicitly DENY deniedUserId on folderId
    await db.insert(userRoleScopes).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        groupId: reviewerGroupId,
        roleId: reviewerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderId,
        effect: "ALLOW",
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        userId: deniedUserId,
        roleId: reviewerRoleId,
        scopeType: "FOLDER",
        scopeTargetId: folderId,
        effect: "DENY",
      },
    ]);

    await db.insert(storageConnections).values({
      id: storageId,
      organizationId: orgId,
      name: "Local WF",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/wf-local" },
    });

    await db.insert(fileObjects).values({
      id: fileId,
      organizationId: orgId,
      storageConnectionId: storageId,
      objectKey: `org/${orgId}/wf-doc`,
      originalFileName: "contrato.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 2048,
      checksumSha256: "a".repeat(64),
      status: "AVAILABLE",
    });

    await db.insert(documents).values({
      id: docId,
      organizationId: orgId,
      title: "Contrato Fluxo Tarefas",
      categoryId,
      folderId,
      status: "DRAFT",
      ownerUserId: requesterId,
      createdBy: requesterId,
      updatedBy: requesterId,
    });
    await db.insert(documentVersions).values({
      id: versionId,
      documentId: docId,
      versionNumber: 1,
      fileObjectId: fileId,
      uploadedByUserId: requesterId,
    });
    await db.update(documents).set({ currentVersionId: versionId }).where(eq(documents.id, docId));

    const transactions = createTransactionManager(db);
    const audit = createAuditRepository(db);
    const definitionRepo = createWorkflowDefinitionRepository(db);
    const instanceRepo = createWorkflowInstanceRepository(db);
    const taskRepo = createWorkflowTaskRepository(db);
    const assigneeVerifier = createWorkflowAssigneeVerifier(db);
    const docRepo = createDocumentRepository(db);
    const docVersionRepo = createDocumentVersionRepository(db);
    const uploadRepo = createUploadSessionRepository(db);

    const defService = createWorkflowDefinitionService({
      definitions: definitionRepo,
      transactions,
      audit,
      generateId: () => randomUUID(),
    });

    const startService = createStartWorkflowUseCase({
      documents: docRepo,
      documentVersions: docVersionRepo,
      uploadSessions: uploadRepo,
      definitions: definitionRepo,
      workflowInstances: instanceRepo,
      transactions,
      audit,
      generateId: () => randomUUID(),
      now: () => fixedNow,
    });

    const taskService = createWorkflowTasksUseCase({
      workflowInstances: instanceRepo,
      definitions: definitionRepo,
      documents: docRepo,
      tasks: taskRepo,
      transactions,
      audit,
      assigneeAuthorization: assigneeVerifier,
      generateId: () => randomUUID(),
      now: () => fixedNow,
    });

    const validDef = await defService.createDefinition({
      organizationId: orgId,
      actorUserId: requesterId,
      requestId: randomUUID(),
      name: "Fluxo Sequencial Comitê",
      steps: [
        {
          stepOrder: 1,
          name: "Parecer do Comitê",
          assignee: { type: "GROUP", groupId: reviewerGroupId },
          dueDays: 4,
        },
        {
          stepOrder: 2,
          name: "Validação Individual",
          assignee: { type: "USER", userId: reviewerUserId },
          dueDays: 2,
        },
      ],
    });

    const started = await startService.startWorkflow({
      organizationId: orgId,
      actorUserId: requesterId,
      requestId: randomUUID(),
      documentId: docId,
      documentVersionId: versionId,
      workflowDefinitionId: validDef.definition.id,
    });

    // 1. Concurrent retries for step 1 produce EXACTLY 1 row in workflow_tasks without duplicates
    const [resA, resB, resC] = await Promise.all([
      taskService.generateTaskForStep({
        organizationId: orgId,
        actorUserId: requesterId,
        requestId: randomUUID(),
        workflowInstanceId: started.instance.id,
        stepOrder: 1,
      }),
      taskService.generateTaskForStep({
        organizationId: orgId,
        actorUserId: requesterId,
        requestId: randomUUID(),
        workflowInstanceId: started.instance.id,
        stepOrder: 1,
      }),
      taskService.generateTaskForStep({
        organizationId: orgId,
        actorUserId: requesterId,
        requestId: randomUUID(),
        workflowInstanceId: started.instance.id,
        stepOrder: 1,
      }),
    ]);

    expect(resA.task.id).toBe(resB.task.id);
    expect(resB.task.id).toBe(resC.task.id);
    expect([resA.created, resB.created, resC.created].filter(Boolean)).toHaveLength(1);
    expect(resA.task.status).toBe("PENDING");
    expect(resA.task.documentVersionId).toBe(versionId);
    expect(resA.task.assignee).toEqual({ type: "GROUP", groupId: reviewerGroupId });
    expect(resA.task.dueAt).toBe("2026-11-25T17:00:00.000Z");

    const dbTasks = await db
      .select()
      .from(workflowTasks)
      .where(eq(workflowTasks.workflowInstanceId, started.instance.id));
    expect(dbTasks).toHaveLength(1);

    const taskAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId));
    expect(taskAudits.filter((e) => e.action === "WORKFLOW_TASK_CREATED")).toHaveLength(1);

    // 2. Step 2 assigned to reviewerUserId (authorized via group membership on folder) succeeds
    const step2Res = await taskService.generateTaskForStep({
      organizationId: orgId,
      actorUserId: requesterId,
      requestId: randomUUID(),
      workflowInstanceId: started.instance.id,
      stepOrder: 2,
    });
    expect(step2Res.created).toBe(true);
    expect(step2Res.task.assignee).toEqual({ type: "USER", userId: reviewerUserId });

    // 3. Unauthorized / inactive / cross-org assignees are blocked before inserting any task
    const badDocId = randomUUID();
    const badVerId = randomUUID();
    await db.insert(documents).values({
      id: badDocId,
      organizationId: orgId,
      title: "Documento Sem Autorização",
      categoryId,
      folderId,
      status: "DRAFT",
      ownerUserId: requesterId,
      createdBy: requesterId,
      updatedBy: requesterId,
    });
    const badFileId = randomUUID();
    await db.insert(fileObjects).values({
      id: badFileId,
      organizationId: orgId,
      storageConnectionId: storageId,
      objectKey: `org/${orgId}/bad-wf`,
      originalFileName: "bad.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: "b".repeat(64),
      status: "AVAILABLE",
    });
    await db.insert(documentVersions).values({
      id: badVerId,
      documentId: badDocId,
      versionNumber: 1,
      fileObjectId: badFileId,
      uploadedByUserId: requesterId,
    });
    await db
      .update(documents)
      .set({ currentVersionId: badVerId })
      .where(eq(documents.id, badDocId));

    const deniedDef = await defService.createDefinition({
      organizationId: orgId,
      actorUserId: requesterId,
      requestId: randomUUID(),
      name: "Fluxo Negado",
      steps: [
        {
          stepOrder: 1,
          name: "Aprovador Negado",
          assignee: { type: "USER", userId: deniedUserId },
          dueDays: 1,
        },
        {
          stepOrder: 2,
          name: "Grupo Outra Org",
          assignee: { type: "GROUP", groupId: foreignGroupId },
          dueDays: 1,
        },
        {
          stepOrder: 3,
          name: "Usuário Inativo",
          assignee: { type: "USER", userId: inactiveUserId },
          dueDays: 1,
        },
      ],
    });

    const badStart = await startService.startWorkflow({
      organizationId: orgId,
      actorUserId: requesterId,
      requestId: randomUUID(),
      documentId: badDocId,
      documentVersionId: badVerId,
      workflowDefinitionId: deniedDef.definition.id,
    });

    await expect(
      taskService.generateTaskForStep({
        organizationId: orgId,
        requestId: randomUUID(),
        workflowInstanceId: badStart.instance.id,
        stepOrder: 1,
      }),
    ).rejects.toThrowError(DomainError);

    await expect(
      taskService.generateTaskForStep({
        organizationId: orgId,
        requestId: randomUUID(),
        workflowInstanceId: badStart.instance.id,
        stepOrder: 2,
      }),
    ).rejects.toThrowError("Grupo aprovador não encontrado");

    await expect(
      taskService.generateTaskForStep({
        organizationId: orgId,
        requestId: randomUUID(),
        workflowInstanceId: badStart.instance.id,
        stepOrder: 3,
      }),
    ).rejects.toThrowError("não encontrado ou inativo");

    const badTasks = await db
      .select()
      .from(workflowTasks)
      .where(eq(workflowTasks.workflowInstanceId, badStart.instance.id));
    expect(badTasks).toHaveLength(0);
  }, 60_000);
});
