import { describe, expect, it } from "vitest";
import {
  type AuditEventInput,
  type AuditEventRecord,
  type AuditListFilter,
  type AuditRepositoryPort,
  type CreateDocumentInput,
  type CreateDocumentVersionInput,
  type CreateWorkflowDecisionRecordInput,
  type CreateWorkflowInstanceRecordInput,
  type CreateWorkflowTaskIdempotentInput,
  type DocumentEntity,
  type DocumentListFilter,
  type DocumentRepositoryPort,
  type DocumentStatus,
  type DocumentVersionEntity,
  type DocumentVersionRepositoryPort,
  DomainError,
  type FileObjectEntity,
  type FinalizeUploadToQuarantineInput,
  type MarkFileObjectProcessedInput,
  type MarkUploadReceivedInput,
  type PaginatedResult,
  type TransactionContext,
  type TransactionManagerPort,
  type TransitionWorkflowTaskFromPendingInput,
  type UpdateDocumentInput,
  type UploadSessionRepositoryPort,
  type WorkflowDecisionEntity,
  type WorkflowDecisionRepositoryPort,
  type WorkflowDefinitionEntity,
  type WorkflowDefinitionRepositoryPort,
  type WorkflowDefinitionVersionEntity,
  type WorkflowInstanceEntity,
  type WorkflowInstanceRepositoryPort,
  type WorkflowTaskEntity,
  type WorkflowTaskRepositoryPort,
  createDecideTaskUseCase,
  createStartWorkflowUseCase,
  createWorkflowDefinitionService,
  createWorkflowTasksUseCase,
} from "../src/index.js";

function createDecisionHarness() {
  const now = new Date("2026-11-21T19:00:00.000Z");
  let seq = 0;

  const orgId = "11111111-1111-4111-8111-111111111111";
  const initiatorId = "22222222-2222-4222-8222-222222222222";
  const reviewer1Id = "33333333-3333-4333-8333-333333333333";
  const reviewer2Id = "44444444-4444-4444-8444-444444444444";
  const groupId = "55555555-5555-4555-8555-555555555555";
  const outsiderId = "66666666-6666-4666-8666-666666666666";

  const documents = new Map<string, DocumentEntity>();
  const versions = new Map<string, DocumentVersionEntity>();
  const fileObjects = new Map<string, FileObjectEntity>();
  const definitions = new Map<string, WorkflowDefinitionEntity>();
  const definitionVersions = new Map<string, WorkflowDefinitionVersionEntity>();
  const instances = new Map<string, WorkflowInstanceEntity>();
  const tasks = new Map<string, WorkflowTaskEntity>();
  const decisions = new Map<string, WorkflowDecisionEntity>();
  const auditEvents: AuditEventRecord[] = [];

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const docRepo: DocumentRepositoryPort = {
    async findById(id) {
      return documents.get(id) ?? null;
    },
    async list(_f: DocumentListFilter): Promise<PaginatedResult<DocumentEntity>> {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
    async create(input: CreateDocumentInput): Promise<DocumentEntity> {
      const doc: DocumentEntity = {
        ...input,
        status: "DRAFT",
        currentVersionId: null,
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      documents.set(doc.id, doc);
      return doc;
    },
    async updateWithOptimisticLock(_id, _exp, _input: UpdateDocumentInput) {
      return null;
    },
    async setCurrentVersion(docId, verId, expected) {
      const d = documents.get(docId);
      if (!d || d.version !== expected) return null;
      const updated = { ...d, currentVersionId: verId, version: d.version + 1 };
      documents.set(docId, updated);
      return updated;
    },
    async updateStatus(docId, status: DocumentStatus, expected) {
      const d = documents.get(docId);
      if (!d || d.version !== expected) return null;
      const updated = { ...d, status, version: d.version + 1 };
      documents.set(docId, updated);
      return updated;
    },
  };

  const versionRepo: DocumentVersionRepositoryPort = {
    async findById(id) {
      return versions.get(id) ?? null;
    },
    async findByFileObjectId(fid) {
      return Array.from(versions.values()).find((v) => v.fileObjectId === fid) ?? null;
    },
    async findLatestByDocumentId(docId) {
      return Array.from(versions.values()).find((v) => v.documentId === docId) ?? null;
    },
    async listByDocumentId(docId) {
      return Array.from(versions.values()).filter((v) => v.documentId === docId);
    },
    async create(input: CreateDocumentVersionInput) {
      const ver: DocumentVersionEntity = { ...input, createdAt: now.toISOString() };
      versions.set(ver.id, ver);
      return ver;
    },
  };

  const uploadRepo: UploadSessionRepositoryPort = {
    async findById() {
      return null;
    },
    async findByIdempotencyKey() {
      return null;
    },
    async findFileObjectById(id) {
      return fileObjects.get(id) ?? null;
    },
    async createSessionWithFileObject() {
      throw new Error("Unused");
    },
    async markUploadReceived(_i: MarkUploadReceivedInput) {
      return null;
    },
    async finalizeToQuarantine(_i: FinalizeUploadToQuarantineInput) {
      return null;
    },
    async markFileObjectProcessed(_i: MarkFileObjectProcessedInput) {
      return null;
    },
    async markSessionExpired() {},
  };

  const defRepo: WorkflowDefinitionRepositoryPort = {
    async findById(id) {
      return definitions.get(id) ?? null;
    },
    async findByName(oId, name) {
      for (const d of definitions.values()) {
        if (d.organizationId === oId && d.name.toLowerCase() === name.toLowerCase()) return d;
      }
      return null;
    },
    async listByOrganization(oId) {
      return Array.from(definitions.values()).filter((d) => d.organizationId === oId);
    },
    async findVersionById(vid) {
      return definitionVersions.get(vid) ?? null;
    },
    async findVersionByNumber(defId, num) {
      for (const v of definitionVersions.values()) {
        if (v.workflowDefinitionId === defId && v.versionNumber === num) return v;
      }
      return null;
    },
    async listVersions(defId) {
      return Array.from(definitionVersions.values()).filter(
        (v) => v.workflowDefinitionId === defId,
      );
    },
    async createWithInitialVersion(input) {
      const def: WorkflowDefinitionEntity = {
        id: input.definitionId,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        isActive: true,
        latestVersionNumber: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const ver: WorkflowDefinitionVersionEntity = {
        id: input.versionId,
        workflowDefinitionId: def.id,
        versionNumber: 1,
        steps: input.steps,
        createdAt: now.toISOString(),
      };
      definitions.set(def.id, def);
      definitionVersions.set(ver.id, ver);
      return { definition: def, version: ver };
    },
    async publishNewVersion() {
      return null;
    },
    async updateMetadata() {
      return null;
    },
  };

  const instanceRepo: WorkflowInstanceRepositoryPort = {
    async findById(id) {
      return instances.get(id) ?? null;
    },
    async findActiveByDocumentId(docId) {
      return (
        Array.from(instances.values()).find(
          (i) => i.documentId === docId && i.status === "ACTIVE",
        ) ?? null
      );
    },
    async findActiveByDocumentVersionId(vid) {
      return (
        Array.from(instances.values()).find(
          (i) => i.documentVersionId === vid && i.status === "ACTIVE",
        ) ?? null
      );
    },
    async listByDocumentId(docId) {
      return Array.from(instances.values()).filter((i) => i.documentId === docId);
    },
    async create(input: CreateWorkflowInstanceRecordInput) {
      const inst: WorkflowInstanceEntity = {
        id: input.id,
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        workflowDefinitionVersionId: input.workflowDefinitionVersionId,
        status: "ACTIVE",
        currentStepOrder: input.currentStepOrder,
        startedByUserId: input.startedByUserId,
        startedAt: input.startedAt.toISOString(),
        completedAt: null,
      };
      instances.set(inst.id, inst);
      return inst;
    },
    async updateProgress(input) {
      const existing = instances.get(input.instanceId);
      if (!existing || existing.status !== input.expectedStatus) return null;
      const updated: WorkflowInstanceEntity = {
        ...existing,
        status: input.status,
        currentStepOrder: input.currentStepOrder,
        completedAt: input.completedAt ? input.completedAt.toISOString() : null,
      };
      instances.set(updated.id, updated);
      return updated;
    },
  };

  const taskRepo: WorkflowTaskRepositoryPort = {
    async findById(id) {
      return tasks.get(id) ?? null;
    },
    async findByInstanceAndStep(instanceId, stepOrder) {
      return (
        Array.from(tasks.values()).find(
          (t) => t.workflowInstanceId === instanceId && t.stepOrder === stepOrder,
        ) ?? null
      );
    },
    async listByInstanceId(instanceId) {
      return Array.from(tasks.values()).filter((t) => t.workflowInstanceId === instanceId);
    },
    async createIdempotent(input: CreateWorkflowTaskIdempotentInput) {
      const existing = await this.findByInstanceAndStep(input.workflowInstanceId, input.stepOrder);
      if (existing) {
        return { task: existing, created: false };
      }
      const created: WorkflowTaskEntity = {
        id: input.id,
        workflowInstanceId: input.workflowInstanceId,
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        stepOrder: input.stepOrder,
        status: "PENDING",
        assignee: input.assignee,
        dueAt: input.dueAt ? input.dueAt.toISOString() : null,
        createdAt: now.toISOString(),
        decidedAt: null,
      };
      tasks.set(created.id, created);
      return { task: created, created: true };
    },
    async transitionFromPending(input: TransitionWorkflowTaskFromPendingInput) {
      const existing = tasks.get(input.taskId);
      if (!existing || existing.status !== input.expectedStatus) {
        return null;
      }
      const updated: WorkflowTaskEntity = {
        ...existing,
        status: input.nextStatus,
        decidedAt: input.decidedAt.toISOString(),
      };
      tasks.set(updated.id, updated);
      return updated;
    },
    async cancelPendingByInstanceId(instanceId, cancelledAt) {
      let count = 0;
      for (const [id, task] of tasks.entries()) {
        if (task.workflowInstanceId === instanceId && task.status === "PENDING") {
          tasks.set(id, { ...task, status: "CANCELLED", decidedAt: cancelledAt.toISOString() });
          count += 1;
        }
      }
      return count;
    },
  };

  const decisionRepo: WorkflowDecisionRepositoryPort = {
    async findByTaskId(taskId) {
      return Array.from(decisions.values()).find((d) => d.taskId === taskId) ?? null;
    },
    async create(input: CreateWorkflowDecisionRecordInput) {
      const rec: WorkflowDecisionEntity = {
        id: input.id,
        taskId: input.taskId,
        actorUserId: input.actorUserId,
        decision: input.decision,
        comment: input.comment,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: input.createdAt.toISOString(),
      };
      decisions.set(rec.id, rec);
      return rec;
    },
  };

  const auditRepo: AuditRepositoryPort = {
    async append(input: AuditEventInput) {
      const rec: AuditEventRecord = {
        id: `audit-${++seq}`,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        result: input.result,
        requestId: input.requestId,
        metadata: input.metadata ?? {},
        occurredAt: now.toISOString(),
      };
      auditEvents.push(rec);
      return rec;
    },
    async list(_f: AuditListFilter) {
      return {
        items: auditEvents,
        page: 1,
        pageSize: 50,
        totalItems: auditEvents.length,
        totalPages: 1,
      };
    },
  };

  const defService = createWorkflowDefinitionService({
    definitions: defRepo,
    transactions,
    audit: auditRepo,
    generateId: () => `def-${++seq}`,
  });

  const startService = createStartWorkflowUseCase({
    documents: docRepo,
    documentVersions: versionRepo,
    uploadSessions: uploadRepo,
    definitions: defRepo,
    workflowInstances: instanceRepo,
    transactions,
    audit: auditRepo,
    generateId: () => `inst-${++seq}`,
    now: () => now,
  });

  const taskService = createWorkflowTasksUseCase({
    workflowInstances: instanceRepo,
    definitions: defRepo,
    documents: docRepo,
    tasks: taskRepo,
    transactions,
    audit: auditRepo,
    generateId: () => `task-${++seq}`,
    now: () => now,
  });

  const decideService = createDecideTaskUseCase({
    tasks: taskRepo,
    decisions: decisionRepo,
    workflowInstances: instanceRepo,
    definitions: defRepo,
    documents: docRepo,
    transactions,
    audit: auditRepo,
    generateId: () => `dec-${++seq}`,
    now: () => now,
  });

  const seedDocumentAndWorkflow = async (twoSteps = true) => {
    const docId = `doc-${++seq}`;
    const verId = `ver-${++seq}`;
    const fileId = `file-${++seq}`;

    fileObjects.set(fileId, {
      id: fileId,
      storageConnectionId: "conn-1",
      objectKey: `org/${orgId}/${docId}`,
      originalFileName: "minuta.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: "a".repeat(64),
      status: "AVAILABLE",
      createdAt: now.toISOString(),
    });

    documents.set(docId, {
      id: docId,
      organizationId: orgId,
      title: "Minuta Teste",
      categoryId: "cat-1",
      folderId: null,
      status: "DRAFT",
      currentVersionId: verId,
      ownerUserId: initiatorId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    versions.set(verId, {
      id: verId,
      documentId: docId,
      versionNumber: 1,
      fileObjectId: fileId,
      uploadedByUserId: initiatorId,
      changeNote: null,
      createdAt: now.toISOString(),
    });

    const def = await defService.createDefinition({
      organizationId: orgId,
      actorUserId: initiatorId,
      requestId: "req-def",
      name: `Fluxo ${seq}`,
      steps: twoSteps
        ? [
            {
              stepOrder: 1,
              name: "Grupo Jurídico",
              assignee: { type: "GROUP", groupId },
              dueDays: 2,
            },
            {
              stepOrder: 2,
              name: "Diretor Financeiro",
              assignee: { type: "USER", userId: reviewer2Id },
              dueDays: 3,
              commentRules: { requireOnApprove: true },
            },
          ]
        : [
            {
              stepOrder: 1,
              name: "Aprovação Única",
              assignee: { type: "USER", userId: reviewer1Id },
              dueDays: 2,
            },
          ],
    });

    const started = await startService.startWorkflow({
      organizationId: orgId,
      actorUserId: initiatorId,
      requestId: "req-start",
      documentId: docId,
      documentVersionId: verId,
      workflowDefinitionId: def.definition.id,
    });

    const firstTask = await taskService.generateTaskForStep({
      organizationId: orgId,
      requestId: "req-t1",
      workflowInstanceId: started.instance.id,
      stepOrder: 1,
    });

    return {
      docId,
      verId,
      instance: started.instance,
      step1Task: firstTask.task,
    };
  };

  return {
    orgId,
    initiatorId,
    reviewer1Id,
    reviewer2Id,
    groupId,
    outsiderId,
    documents,
    auditEvents,
    taskService,
    decideService,
    seedDocumentAndWorkflow,
  };
}

describe("Concurrent task decision, idempotent retry, and cancelation domain rules", () => {
  it("advances sequential steps on approval, pins approval to exact version, and supports idempotent retries without duplicating decisions", async () => {
    const h = createDecisionHarness();
    const { instance, step1Task } = await h.seedDocumentAndWorkflow(true);

    // Outsider cannot decide group task
    await expect(
      h.decideService.decideTask({
        organizationId: h.orgId,
        actorUserId: h.outsiderId,
        actorGroupIds: [],
        requestId: "req-outsider",
        taskId: step1Task.id,
        action: "APPROVE",
      }),
    ).rejects.toThrowError(DomainError);

    // Group member approves step 1 -> advances instance to step 2 while doc remains IN_REVIEW
    const step1Decision = await h.decideService.decideTask({
      organizationId: h.orgId,
      actorUserId: h.reviewer1Id,
      actorGroupIds: [h.groupId],
      requestId: "req-step1-ok",
      taskId: step1Task.id,
      action: "APPROVE",
      comment: "Jurídico ok",
      idempotencyKey: "idem-step1-1",
    });

    expect(step1Decision.idempotentReplay).toBe(false);
    expect(step1Decision.task.status).toBe("APPROVED");
    expect(step1Decision.instance.status).toBe("ACTIVE");
    expect(step1Decision.instance.currentStepOrder).toBe(2);
    expect(step1Decision.document.status).toBe("IN_REVIEW");
    expect(step1Decision.nextStep?.stepOrder).toBe(2);

    // Exact same retry is idempotent
    const replayStep1 = await h.decideService.decideTask({
      organizationId: h.orgId,
      actorUserId: h.reviewer1Id,
      actorGroupIds: [h.groupId],
      requestId: "req-step1-retry",
      taskId: step1Task.id,
      action: "APPROVE",
      comment: "Jurídico ok",
      idempotencyKey: "idem-step1-1",
    });
    expect(replayStep1.idempotentReplay).toBe(true);
    expect(replayStep1.decision?.id).toBe(step1Decision.decision?.id);

    // Conflicting decision by another group member on already-decided task fails cleanly (TASK_ALREADY_DECIDED)
    await expect(
      h.decideService.decideTask({
        organizationId: h.orgId,
        actorUserId: h.reviewer2Id,
        actorGroupIds: [h.groupId],
        requestId: "req-step1-conflict",
        taskId: step1Task.id,
        action: "REJECT",
        comment: "Tentativa conflitante",
      }),
    ).rejects.toThrowError("já recebeu uma decisão final");

    // Step 2 requires mandatory approve comment -> missing comment fails; valid comment completes workflow & approves doc
    const step2Task = await h.taskService.generateTaskForStep({
      organizationId: h.orgId,
      requestId: "req-t2",
      workflowInstanceId: instance.id,
      stepOrder: 2,
    });

    await expect(
      h.decideService.decideTask({
        organizationId: h.orgId,
        actorUserId: h.reviewer2Id,
        requestId: "req-step2-nocomment",
        taskId: step2Task.task.id,
        action: "APPROVE",
      }),
    ).rejects.toThrowError("comentário obrigatório");

    const finalApproval = await h.decideService.decideTask({
      organizationId: h.orgId,
      actorUserId: h.reviewer2Id,
      requestId: "req-step2-ok",
      taskId: step2Task.task.id,
      action: "APPROVE",
      comment: "Aprovado pela diretoria",
    });

    expect(finalApproval.instance.status).toBe("COMPLETED");
    expect(finalApproval.document.status).toBe("APPROVED");
    expect(finalApproval.nextStep).toBeNull();
  });

  it("handles REJECT, REQUEST_CHANGES, CANCEL, and silent document version drift protection", async () => {
    const h = createDecisionHarness();

    // 1. REJECT marks task, instance, and document as REJECTED and requires comment
    const flowReject = await h.seedDocumentAndWorkflow(false);
    await expect(
      h.decideService.decideTask({
        organizationId: h.orgId,
        actorUserId: h.reviewer1Id,
        requestId: "req-rej-empty",
        taskId: flowReject.step1Task.id,
        action: "REJECT",
        comment: "  ",
      }),
    ).rejects.toThrowError("Comentário é obrigatório");

    const rejected = await h.decideService.decideTask({
      organizationId: h.orgId,
      actorUserId: h.reviewer1Id,
      requestId: "req-rej",
      taskId: flowReject.step1Task.id,
      action: "REJECT",
      comment: "Cláusula inválida.",
    });
    expect(rejected.task.status).toBe("REJECTED");
    expect(rejected.instance.status).toBe("REJECTED");
    expect(rejected.document.status).toBe("REJECTED");

    // 2. REQUEST_CHANGES returns document to DRAFT and closes instance as CHANGES_REQUESTED
    const flowChanges = await h.seedDocumentAndWorkflow(false);
    const changes = await h.decideService.decideTask({
      organizationId: h.orgId,
      actorUserId: h.reviewer1Id,
      requestId: "req-changes",
      taskId: flowChanges.step1Task.id,
      action: "REQUEST_CHANGES",
      comment: "Anexar certidão atualizada.",
    });
    expect(changes.task.status).toBe("CHANGES_REQUESTED");
    expect(changes.instance.status).toBe("CHANGES_REQUESTED");
    expect(changes.document.status).toBe("DRAFT");

    // 3. CANCEL by initiator cancels task/instance and reverts document to DRAFT, with idempotent replay
    const flowCancel = await h.seedDocumentAndWorkflow(false);
    const cancelled = await h.decideService.decideTask({
      organizationId: h.orgId,
      actorUserId: h.initiatorId,
      requestId: "req-cancel",
      taskId: flowCancel.step1Task.id,
      action: "CANCEL",
    });
    expect(cancelled.task.status).toBe("CANCELLED");
    expect(cancelled.instance.status).toBe("CANCELLED");
    expect(cancelled.document.status).toBe("DRAFT");
    expect(cancelled.idempotentReplay).toBe(false);

    const replayCancel = await h.decideService.decideTask({
      organizationId: h.orgId,
      actorUserId: h.initiatorId,
      requestId: "req-cancel-retry",
      taskId: flowCancel.step1Task.id,
      action: "CANCEL",
    });
    expect(replayCancel.idempotentReplay).toBe(true);

    // 4. Silent document version change blocks approval on outdated instance
    const flowDrift = await h.seedDocumentAndWorkflow(false);
    const existingDoc = h.documents.get(flowDrift.docId);
    if (existingDoc) {
      h.documents.set(flowDrift.docId, { ...existingDoc, currentVersionId: "newer-v2" });
    }
    await expect(
      h.decideService.decideTask({
        organizationId: h.orgId,
        actorUserId: h.reviewer1Id,
        requestId: "req-drift",
        taskId: flowDrift.step1Task.id,
        action: "APPROVE",
      }),
    ).rejects.toThrowError("exatamente a versão vinculada");
  });
});
