import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DomainError,
  createDecideTaskUseCase,
  createDocumentVersionUseCase,
  createRetentionGovernanceService,
  createStartWorkflowUseCase,
  createWorkflowDefinitionService,
  createWorkflowTasksUseCase,
  restoreDocumentUseCase,
  trashDocumentUseCase,
} from "@papyrus/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createDocumentPurgeRepository,
  createDocumentRepository,
  createDocumentRetentionHoldRepository,
  createDocumentVersionRepository,
  createRetentionPolicyRepository,
  createStorageConnectionRepository,
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
  organizations,
  storageConnections,
  uploadSessions,
  workflowDecisions,
} from "../src/index.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../drizzle");
const VALID_SHA256 = "e".repeat(64);

describe("Governance concurrency invariants and append-only audit trail integration (Step 13.09)", () => {
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

  it("prevents concurrent actions from dropping versions or workflow decisions and preserves audit trail across trash, restore and purge", async () => {
    const db = drizzle(pool);
    const transactions = createTransactionManager(db);
    const documentsRepo = createDocumentRepository(db);
    const documentVersionsRepo = createDocumentVersionRepository(db);
    const uploadSessionsRepo = createUploadSessionRepository(db);
    const userRepo = createUserRepository(db);
    const auditRepo = createAuditRepository(db);
    const storageRepo = createStorageConnectionRepository(db);
    const workflowDefinitionsRepo = createWorkflowDefinitionRepository(db);
    const workflowInstancesRepo = createWorkflowInstanceRepository(db);
    const workflowTasksRepo = createWorkflowTaskRepository(db);
    const workflowDecisionsRepo = createWorkflowDecisionRepository(db);
    const assigneeVerifier = createWorkflowAssigneeVerifier(db);
    const policiesRepo = createRetentionPolicyRepository(db);
    const holdsRepo = createDocumentRetentionHoldRepository(db);
    const purgeRepo = createDocumentPurgeRepository(db);

    const orgId = randomUUID();
    const authorId = randomUUID();
    const reviewerId = randomUUID();
    const catId = randomUUID();
    const connId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "papyrus Governance Org",
      slug: `gov-org-${orgId.slice(0, 8)}`,
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    await userRepo.create({
      id: authorId,
      organizationId: orgId,
      email: `author-${orgId.slice(0, 6)}@papyrus.local`,
      fullName: "Autor Documental",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$salt$hash",
      status: "ACTIVE",
    });
    await userRepo.create({
      id: reviewerId,
      organizationId: orgId,
      email: `reviewer-${orgId.slice(0, 6)}@papyrus.local`,
      fullName: "Revisor Sênior",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$salt$hash",
      status: "ACTIVE",
    });

    await db.insert(categories).values({
      id: catId,
      organizationId: orgId,
      name: "Governança Crítica",
      isActive: true,
    });

    await storageRepo.create({
      id: connId,
      organizationId: orgId,
      name: "Local Governança",
      kind: "local",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/papyrus-gov-test" },
      createdBy: authorId,
    });

    const f1Id = randomUUID();
    const f2Id = randomUUID();
    const f3Id = randomUUID();
    const docId = randomUUID();
    const v1Id = randomUUID();

    await db.insert(fileObjects).values([
      {
        id: f1Id,
        organizationId: orgId,
        storageConnectionId: connId,
        objectKey: `org/${orgId}/doc/${docId}/f1`,
        originalFileName: "politica-v1.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: VALID_SHA256,
        status: "AVAILABLE",
      },
      {
        id: f2Id,
        organizationId: orgId,
        storageConnectionId: connId,
        objectKey: `org/${orgId}/doc/${docId}/f2`,
        originalFileName: "politica-v2.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: VALID_SHA256,
        status: "AVAILABLE",
      },
      {
        id: f3Id,
        organizationId: orgId,
        storageConnectionId: connId,
        objectKey: `org/${orgId}/doc/${docId}/f3`,
        originalFileName: "politica-v3.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 3072,
        checksumSha256: VALID_SHA256,
        status: "AVAILABLE",
      },
    ]);

    const s2Id = randomUUID();
    const s3Id = randomUUID();
    const expiresAt = new Date("2026-12-31T00:00:00.000Z");
    await db.insert(uploadSessions).values([
      {
        id: s2Id,
        organizationId: orgId,
        userId: authorId,
        storageConnectionId: connId,
        fileObjectId: f2Id,
        declaredSizeBytes: 2048,
        declaredContentType: "application/pdf",
        idempotencyKey: `idem-2-${docId}`,
        status: "FINALIZED",
        expiresAt,
      },
      {
        id: s3Id,
        organizationId: orgId,
        userId: authorId,
        storageConnectionId: connId,
        fileObjectId: f3Id,
        declaredSizeBytes: 3072,
        declaredContentType: "application/pdf",
        idempotencyKey: `idem-3-${docId}`,
        status: "FINALIZED",
        expiresAt,
      },
    ]);

    await documentsRepo.create({
      id: docId,
      organizationId: orgId,
      title: "Política de Segurança Empresarial",
      categoryId: catId,
      folderId: null,
      ownerUserId: authorId,
      metadata: {},
    });

    const v1 = await documentVersionsRepo.create({
      id: v1Id,
      documentId: docId,
      versionNumber: 1,
      fileObjectId: f1Id,
      uploadedByUserId: authorId,
      changeNote: "Versão inicial",
    });
    await documentsRepo.setCurrentVersion(docId, v1.id, 1);

    let clockMs = Date.parse("2026-04-01T10:00:00.000Z");
    const nextNow = () => {
      clockMs += 1_000;
      return new Date(clockMs);
    };

    const versionService = createDocumentVersionUseCase({
      documents: documentsRepo,
      documentVersions: documentVersionsRepo,
      uploadSessions: uploadSessionsRepo,
      transactions,
      audit: auditRepo,
      generateId: () => randomUUID(),
      now: nextNow,
    });
    const definitionService = createWorkflowDefinitionService({
      definitions: workflowDefinitionsRepo,
      transactions,
      audit: auditRepo,
      generateId: () => randomUUID(),
    });
    const startWorkflowService = createStartWorkflowUseCase({
      documents: documentsRepo,
      documentVersions: documentVersionsRepo,
      uploadSessions: uploadSessionsRepo,
      definitions: workflowDefinitionsRepo,
      workflowInstances: workflowInstancesRepo,
      transactions,
      audit: auditRepo,
      generateId: () => randomUUID(),
      now: nextNow,
    });
    const createTasksService = createWorkflowTasksUseCase({
      workflowInstances: workflowInstancesRepo,
      definitions: workflowDefinitionsRepo,
      documents: documentsRepo,
      tasks: workflowTasksRepo,
      transactions,
      audit: auditRepo,
      generateId: () => randomUUID(),
      now: nextNow,
    });
    const decideTaskService = createDecideTaskUseCase({
      tasks: workflowTasksRepo,
      decisions: workflowDecisionsRepo,
      workflowInstances: workflowInstancesRepo,
      definitions: workflowDefinitionsRepo,
      documents: documentsRepo,
      transactions,
      audit: auditRepo,
      generateId: () => randomUUID(),
      now: nextNow,
    });
    const trashService = trashDocumentUseCase({
      documents: documentsRepo,
      transactions,
      audit: auditRepo,
    });
    const restoreService = restoreDocumentUseCase({
      documents: documentsRepo,
      transactions,
      audit: auditRepo,
      policies: policiesRepo,
      holds: holdsRepo,
      now: () => new Date(clockMs),
    });
    const retentionService = createRetentionGovernanceService({
      policies: policiesRepo,
      holds: holdsRepo,
      documents: documentsRepo,
      categories: {
        async findById(categoryId) {
          const [row] = await db
            .select()
            .from(categories)
            .where(eq(categories.id, categoryId))
            .limit(1);
          if (!row) {
            return null;
          }
          return {
            id: row.id,
            organizationId: row.organizationId,
            name: row.name,
            description: row.description,
            color: row.color,
            icon: row.icon,
            isActive: row.isActive,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        },
        async findByName() {
          return null;
        },
        async listByOrganization() {
          return [];
        },
        async create() {
          throw new Error("Not used");
        },
        async update() {
          return null;
        },
      },
      transactions,
      audit: auditRepo,
      generateId: () => randomUUID(),
      now: nextNow,
    });

    // 1. Concurrent version creation racing with same expectedVersion=2
    const versionRace = await Promise.allSettled([
      versionService.createVersion({
        organizationId: orgId,
        actorUserId: authorId,
        requestId: randomUUID(),
        documentId: docId,
        expectedVersion: 2,
        uploadSessionId: s2Id,
        changeNote: "Revisão concorrente A",
      }),
      versionService.createVersion({
        organizationId: orgId,
        actorUserId: authorId,
        requestId: randomUUID(),
        documentId: docId,
        expectedVersion: 2,
        uploadSessionId: s3Id,
        changeNote: "Revisão concorrente B",
      }),
    ]);

    const versionFulfilled = versionRace.filter((r) => r.status === "fulfilled");
    const versionRejected = versionRace.filter((r) => r.status === "rejected");
    expect(versionFulfilled).toHaveLength(1);
    expect(versionRejected).toHaveLength(1);
    const winningVersion = versionFulfilled[0]?.value.version;
    expect(winningVersion?.versionNumber).toBe(2);
    expect(versionRejected[0]?.reason).toBeInstanceOf(DomainError);
    expect((versionRejected[0]?.reason as DomainError).code).toBe("DOCUMENT_VERSION_CONFLICT");

    // 2. Start approval workflow pinned to winning v2 and race two conflicting task decisions
    const defResult = await definitionService.createDefinition({
      organizationId: orgId,
      actorUserId: authorId,
      requestId: randomUUID(),
      name: "Aprovação Governança",
      steps: [
        {
          stepOrder: 1,
          name: "Revisão Única",
          assignee: { type: "USER", userId: reviewerId },
          dueDays: 5,
        },
      ],
    });
    const started = await startWorkflowService.startWorkflow({
      organizationId: orgId,
      actorUserId: authorId,
      requestId: randomUUID(),
      documentId: docId,
      workflowDefinitionId: defResult.definition.id,
      workflowDefinitionVersionId: defResult.version.id,
    });
    const createdTask = await createTasksService.generateTaskForStep({
      organizationId: orgId,
      actorUserId: authorId,
      requestId: randomUUID(),
      workflowInstanceId: started.instance.id,
      stepOrder: 1,
    });

    const decisionRace = await Promise.allSettled([
      decideTaskService.decideTask({
        organizationId: orgId,
        actorUserId: reviewerId,
        requestId: randomUUID(),
        taskId: createdTask.task.id,
        action: "APPROVE",
        comment: "Aprovado após análise",
      }),
      decideTaskService.decideTask({
        organizationId: orgId,
        actorUserId: reviewerId,
        requestId: randomUUID(),
        taskId: createdTask.task.id,
        action: "REJECT",
        comment: "Rejeição concorrente",
      }),
    ]);

    const decisionWins = decisionRace.filter((r) => r.status === "fulfilled");
    const decisionConflicts = decisionRace.filter((r) => r.status === "rejected");
    expect(decisionWins).toHaveLength(1);
    expect(decisionConflicts).toHaveLength(1);
    expect((decisionConflicts[0]?.reason as DomainError).code).toMatch(
      /TASK_DECISION_CONFLICT|TASK_ALREADY_DECIDED/,
    );

    const persistedDecisionsBeforeTrash = await db
      .select()
      .from(workflowDecisions)
      .where(eq(workflowDecisions.taskId, createdTask.task.id));
    expect(persistedDecisionsBeforeTrash).toHaveLength(1);
    const winningDecisionId = persistedDecisionsBeforeTrash[0]?.id;

    // 3. Place & release hold, trash & restore concurrently, verifying versions, decision and audit remain intact
    const hold = await retentionService.placeHold({
      organizationId: orgId,
      actorUserId: reviewerId,
      requestId: randomUUID(),
      documentId: docId,
      reason: "Preservação preventiva",
    });
    await retentionService.releaseHold({
      organizationId: orgId,
      actorUserId: reviewerId,
      requestId: randomUUID(),
      documentId: docId,
      holdId: hold.id,
      releaseReason: "Liberação concluída",
    });

    const docBeforeTrash = await documentsRepo.findById(docId);
    expect(docBeforeTrash).toBeTruthy();
    const preTrashVersion = docBeforeTrash?.version ?? 0;

    // Concurrent trash vs metadata update racing the same optimistic version
    const trashRace = await Promise.allSettled([
      trashService.trashDocument({
        organizationId: orgId,
        actorUserId: authorId,
        requestId: randomUUID(),
        documentId: docId,
        expectedVersion: preTrashVersion,
        reason: "Descarte controlado",
      }),
      documentsRepo.updateWithOptimisticLock({
        documentId: docId,
        expectedVersion: preTrashVersion,
        title: "Título Concorrente Perdido",
      }),
    ]);
    // At least trash succeeded or threw optimistic conflict; check deterministic final state before continuing
    expect(trashRace).toHaveLength(2);
    const afterTrashAttempt = await documentsRepo.findById(docId);
    if (afterTrashAttempt && afterTrashAttempt.status !== "DELETED") {
      await trashService.trashDocument({
        organizationId: orgId,
        actorUserId: authorId,
        requestId: randomUUID(),
        documentId: docId,
        expectedVersion: afterTrashAttempt.version,
        reason: "Descarte controlado",
      });
    }

    const docInTrash = await documentsRepo.findById(docId);
    expect(docInTrash?.status).toBe("DELETED");

    // Concurrent restore calls racing on deleted doc -> strictly 1 restores, 1 conflicts
    const restoreRace = await Promise.allSettled([
      restoreService.restoreDocument({
        organizationId: orgId,
        actorUserId: authorId,
        requestId: randomUUID(),
        documentId: docId,
        expectedVersion: docInTrash?.version ?? 0,
        targetStatus: "ARCHIVED",
        reason: "Restauração concorrente 1",
      }),
      restoreService.restoreDocument({
        organizationId: orgId,
        actorUserId: authorId,
        requestId: randomUUID(),
        documentId: docId,
        expectedVersion: docInTrash?.version ?? 0,
        targetStatus: "DRAFT",
        reason: "Restauração concorrente 2",
      }),
    ]);

    const restoreWins = restoreRace.filter((r) => r.status === "fulfilled");
    const restoreConflicts = restoreRace.filter((r) => r.status === "rejected");
    expect(restoreWins).toHaveLength(1);
    expect(restoreConflicts).toHaveLength(1);
    expect((restoreConflicts[0]?.reason as DomainError).code).toBe("DOCUMENT_VERSION_CONFLICT");

    // Versions and workflow decision remain intact after trash -> restore!
    const preservedVersions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, docId));
    expect(preservedVersions).toHaveLength(2);

    const preservedDecisions = await db
      .select()
      .from(workflowDecisions)
      .where(eq(workflowDecisions.taskId, createdTask.task.id));
    expect(preservedDecisions).toHaveLength(1);
    expect(preservedDecisions[0]?.id).toBe(winningDecisionId);

    const docAuditAfterRestore = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.resourceId, docId)))
      .orderBy(asc(auditEvents.occurredAt));

    const docAuditActions = docAuditAfterRestore.map((event) => event.action);
    expect(docAuditActions).toContain("DOCUMENT_VERSION_CREATED");
    expect(docAuditActions).toContain("RETENTION_HOLD_PLACED");
    expect(docAuditActions).toContain("RETENTION_HOLD_RELEASED");
    expect(docAuditActions).toContain("DOCUMENT_TRASHED");
    expect(docAuditActions).toContain("DOCUMENT_RESTORED");

    const orgAuditAfterRestore = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId))
      .orderBy(asc(auditEvents.occurredAt));
    const orgAuditActions = orgAuditAfterRestore.map((event) => event.action);
    expect(orgAuditActions).toContain("WORKFLOW_STARTED");
    expect(orgAuditActions).toContain("WORKFLOW_TASK_DECIDED");

    // 4. Separate deleted document claimed concurrently by physical purge retains its audit trail permanently
    const purgeDocId = randomUUID();
    const purgeVerId = randomUUID();
    await db.insert(documents).values({
      id: purgeDocId,
      organizationId: orgId,
      title: "Documento Expurgado Auditoria",
      categoryId: catId,
      status: "DELETED",
      deletedAt: new Date("2025-12-01T00:00:00.000Z"),
      ownerUserId: authorId,
      createdAt: new Date("2025-10-01T00:00:00.000Z"),
      updatedAt: new Date("2025-12-01T00:00:00.000Z"),
    });
    await documentVersionsRepo.create({
      id: purgeVerId,
      documentId: purgeDocId,
      versionNumber: 1,
      fileObjectId: f3Id,
      uploadedByUserId: authorId,
    });
    await auditRepo.append({
      organizationId: orgId,
      actorUserId: authorId,
      action: "DOCUMENT_TRASHED",
      resourceType: "DOCUMENT",
      resourceId: purgeDocId,
      result: "SUCCESS",
      requestId: randomUUID(),
      metadata: { reason: "Expirado" },
    });

    const purgeRace = await Promise.all([
      transactions.runInTransaction((tx) =>
        purgeRepo.claimEligibleDeletedDocument(
          {
            documentId: purgeDocId,
            referenceNow: new Date("2026-04-10T00:00:00.000Z"),
            fallbackTrashGraceDays: 30,
            maxAttempts: 5,
            generateId: () => randomUUID(),
          },
          tx,
        ),
      ),
      transactions.runInTransaction((tx) =>
        purgeRepo.claimEligibleDeletedDocument(
          {
            documentId: purgeDocId,
            referenceNow: new Date("2026-04-10T00:00:00.000Z"),
            fallbackTrashGraceDays: 30,
            maxAttempts: 5,
            generateId: () => randomUUID(),
          },
          tx,
        ),
      ),
    ]);

    const purgeClaimed = purgeRace.filter((outcome) => outcome.status === "CLAIMED");
    const purgeSkipped = purgeRace.filter((outcome) => outcome.status === "SKIPPED");
    expect(purgeClaimed).toHaveLength(1);
    expect(purgeSkipped).toHaveLength(1);
    expect(purgeSkipped[0]?.reasons).toContain("DOCUMENT_NOT_FOUND");

    // Audit trail for purged document MUST persist permanently in PostgreSQL
    const purgedDocAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.resourceId, purgeDocId)));
    expect(purgedDocAudits.some((event) => event.action === "DOCUMENT_TRASHED")).toBe(true);
  });
});
