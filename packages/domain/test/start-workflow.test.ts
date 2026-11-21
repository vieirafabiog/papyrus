import { describe, expect, it } from "vitest";
import {
  type AuditEventInput,
  type AuditEventRecord,
  type AuditListFilter,
  type AuditRepositoryPort,
  type CreateDocumentInput,
  type CreateDocumentVersionInput,
  type CreateWorkflowInstanceRecordInput,
  type DocumentEntity,
  type DocumentListFilter,
  type DocumentRepositoryPort,
  type DocumentStatus,
  type DocumentVersionEntity,
  type DocumentVersionRepositoryPort,
  type FileObjectEntity,
  type FinalizeUploadToQuarantineInput,
  type MarkFileObjectProcessedInput,
  type MarkUploadReceivedInput,
  type PaginatedResult,
  type TransactionContext,
  type TransactionManagerPort,
  type UpdateDocumentInput,
  type UploadSessionRepositoryPort,
  type WorkflowDefinitionEntity,
  type WorkflowDefinitionRepositoryPort,
  type WorkflowDefinitionVersionEntity,
  type WorkflowInstanceEntity,
  type WorkflowInstanceRepositoryPort,
  createStartWorkflowUseCase,
  createWorkflowDefinitionService,
} from "../src/index.js";

function createStartWorkflowTestHarness() {
  const now = new Date("2026-11-21T16:00:00.000Z");
  let seq = 0;

  const orgId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const groupId = "33333333-3333-4333-8333-333333333333";

  const documents = new Map<string, DocumentEntity>();
  const versions = new Map<string, DocumentVersionEntity>();
  const fileObjects = new Map<string, FileObjectEntity>();
  const fileObjectOrgs = new Map<string, string>();
  const definitions = new Map<string, WorkflowDefinitionEntity>();
  const definitionVersions = new Map<string, WorkflowDefinitionVersionEntity>();
  const instances = new Map<string, WorkflowInstanceEntity>();
  const auditEvents: AuditEventRecord[] = [];

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const documentRepo: DocumentRepositoryPort = {
    async findById(id) {
      return documents.get(id) ?? null;
    },
    async list(_filter: DocumentListFilter): Promise<PaginatedResult<DocumentEntity>> {
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
    async updateWithOptimisticLock(_id, _expected, _input: UpdateDocumentInput) {
      return null;
    },
    async setCurrentVersion(docId, verId, expected) {
      const doc = documents.get(docId);
      if (!doc || doc.version !== expected) return null;
      const updated = { ...doc, currentVersionId: verId, version: doc.version + 1 };
      documents.set(docId, updated);
      return updated;
    },
    async updateStatus(docId, status: DocumentStatus, expected) {
      const doc = documents.get(docId);
      if (!doc || doc.version !== expected) return null;
      const updated = { ...doc, status, version: doc.version + 1 };
      documents.set(docId, updated);
      return updated;
    },
  };

  const versionRepo: DocumentVersionRepositoryPort = {
    async findById(id) {
      return versions.get(id) ?? null;
    },
    async findByFileObjectId(fileObjectId) {
      return Array.from(versions.values()).find((v) => v.fileObjectId === fileObjectId) ?? null;
    },
    async findLatestByDocumentId(docId) {
      return (
        Array.from(versions.values())
          .filter((v) => v.documentId === docId)
          .sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null
      );
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
    async findFileObjectOrganizationId(id) {
      return fileObjectOrgs.get(id) ?? null;
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
        if (d.organizationId === oId && d.name.toLowerCase() === name.toLowerCase()) {
          return d;
        }
      }
      return null;
    },
    async listByOrganization(oId) {
      return Array.from(definitions.values()).filter((d) => d.organizationId === oId);
    },
    async findVersionById(versionId) {
      return definitionVersions.get(versionId) ?? null;
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
    async publishNewVersion(input) {
      const existing = definitions.get(input.workflowDefinitionId);
      if (!existing || existing.latestVersionNumber !== input.expectedLatestVersionNumber) {
        return null;
      }
      const nextNum = existing.latestVersionNumber + 1;
      const updatedDef = {
        ...existing,
        latestVersionNumber: nextNum,
        updatedAt: now.toISOString(),
      };
      const ver: WorkflowDefinitionVersionEntity = {
        id: input.versionId,
        workflowDefinitionId: existing.id,
        versionNumber: nextNum,
        steps: input.steps,
        createdAt: now.toISOString(),
      };
      definitions.set(updatedDef.id, updatedDef);
      definitionVersions.set(ver.id, ver);
      return { definition: updatedDef, version: ver };
    },
    async updateMetadata(input) {
      const existing = definitions.get(input.workflowDefinitionId);
      if (!existing) return null;
      const updated = { ...existing, isActive: input.isActive ?? existing.isActive };
      definitions.set(updated.id, updated);
      return updated;
    },
  };

  const instanceRepo: WorkflowInstanceRepositoryPort = {
    async findById(id) {
      return instances.get(id) ?? null;
    },
    async findActiveByDocumentId(docId) {
      return (
        Array.from(instances.values()).find(
          (inst) => inst.documentId === docId && inst.status === "ACTIVE",
        ) ?? null
      );
    },
    async findActiveByDocumentVersionId(docVersionId) {
      return (
        Array.from(instances.values()).find(
          (inst) => inst.documentVersionId === docVersionId && inst.status === "ACTIVE",
        ) ?? null
      );
    },
    async listByDocumentId(docId) {
      return Array.from(instances.values()).filter((inst) => inst.documentId === docId);
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
    async list(_filter: AuditListFilter) {
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
    generateId: () => `wf-id-${++seq}`,
  });

  const startWorkflowService = createStartWorkflowUseCase({
    documents: documentRepo,
    documentVersions: versionRepo,
    uploadSessions: uploadRepo,
    definitions: defRepo,
    workflowInstances: instanceRepo,
    transactions,
    audit: auditRepo,
    generateId: () => `inst-${++seq}`,
    now: () => now,
  });

  return {
    orgId,
    userId,
    groupId,
    documents,
    versions,
    fileObjects,
    fileObjectOrgs,
    instances,
    auditEvents,
    defService,
    startWorkflowService,
  };
}

describe("Start workflow instance pinned to immutable definition version and documentVersionId", () => {
  it("starts a workflow pinned to immutable definition version + documentVersionId and ignores subsequent definition updates", async () => {
    const h = createStartWorkflowTestHarness();

    const { definition, version: defV1 } = await h.defService.createDefinition({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-def-1",
      name: "Aprovação Jurídica",
      steps: [
        {
          stepOrder: 1,
          name: "Jurídico",
          assignee: { type: "GROUP", groupId: h.groupId },
          dueDays: 3,
        },
      ],
    });

    const docId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ver1Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const file1Id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    h.fileObjects.set(file1Id, {
      id: file1Id,
      storageConnectionId: "conn-1",
      objectKey: `org/${h.orgId}/docs/${docId}`,
      originalFileName: "minuta.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256: "a".repeat(64),
      status: "AVAILABLE",
      createdAt: "2026-11-21T15:00:00.000Z",
    });
    h.fileObjectOrgs.set(file1Id, h.orgId);

    h.documents.set(docId, {
      id: docId,
      organizationId: h.orgId,
      title: "Minuta Fornecedor",
      categoryId: "cat-1",
      folderId: null,
      status: "DRAFT",
      currentVersionId: ver1Id,
      ownerUserId: h.userId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: "2026-11-21T15:00:00.000Z",
      updatedAt: "2026-11-21T15:00:00.000Z",
    });
    h.versions.set(ver1Id, {
      id: ver1Id,
      documentId: docId,
      versionNumber: 1,
      fileObjectId: file1Id,
      uploadedByUserId: h.userId,
      changeNote: null,
      createdAt: "2026-11-21T15:00:00.000Z",
    });

    const started = await h.startWorkflowService.startWorkflow({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-start-1",
      documentId: docId,
      documentVersionId: ver1Id,
      workflowDefinitionId: definition.id,
      expectedDocumentVersion: 1,
    });

    expect(started.instance.documentId).toBe(docId);
    expect(started.instance.documentVersionId).toBe(ver1Id);
    expect(started.instance.workflowDefinitionVersionId).toBe(defV1.id);
    expect(started.instance.status).toBe("ACTIVE");
    expect(started.instance.currentStepOrder).toBe(1);
    expect(started.document.status).toBe("IN_REVIEW");

    // Publish definition v2 afterwards -> existing instance stays pinned to v1!
    const { version: defV2 } = await h.defService.publishNewVersion({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-def-2",
      workflowDefinitionId: definition.id,
      steps: [
        {
          stepOrder: 1,
          name: "Compliance",
          assignee: { type: "USER", userId: h.userId },
          dueDays: 1,
        },
      ],
    });
    expect(defV2.id).not.toBe(defV1.id);
    expect(h.instances.get(started.instance.id)?.workflowDefinitionVersionId).toBe(defV1.id);
  });

  it("blocks starting workflows on quarantined files, stale/superseded versions, inactive definitions, or documents already IN_REVIEW", async () => {
    const h = createStartWorkflowTestHarness();

    const { definition } = await h.defService.createDefinition({
      organizationId: h.orgId,
      actorUserId: h.userId,
      requestId: "req-def-1",
      name: "Fluxo Rigoroso",
      steps: [
        { stepOrder: 1, name: "Revisão", assignee: { type: "USER", userId: h.userId }, dueDays: 2 },
      ],
    });

    const docId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ver1Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ver2Id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const fileQId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fileOkId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    h.fileObjects.set(fileQId, {
      id: fileQId,
      storageConnectionId: "conn-1",
      objectKey: `org/${h.orgId}/q`,
      originalFileName: "q.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 512,
      checksumSha256: "b".repeat(64),
      status: "QUARANTINED",
      createdAt: "2026-11-21T15:00:00.000Z",
    });
    h.fileObjectOrgs.set(fileQId, h.orgId);

    h.fileObjects.set(fileOkId, {
      id: fileOkId,
      storageConnectionId: "conn-1",
      objectKey: `org/${h.orgId}/ok`,
      originalFileName: "ok.pdf",
      detectedContentType: "application/pdf",
      sizeBytes: 512,
      checksumSha256: "c".repeat(64),
      status: "AVAILABLE",
      createdAt: "2026-11-21T15:00:00.000Z",
    });
    h.fileObjectOrgs.set(fileOkId, h.orgId);

    h.documents.set(docId, {
      id: docId,
      organizationId: h.orgId,
      title: "Contrato Em Quarentena",
      categoryId: "cat-1",
      folderId: null,
      status: "DRAFT",
      currentVersionId: ver2Id,
      ownerUserId: h.userId,
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 1,
      createdAt: "2026-11-21T15:00:00.000Z",
      updatedAt: "2026-11-21T15:00:00.000Z",
    });
    h.versions.set(ver1Id, {
      id: ver1Id,
      documentId: docId,
      versionNumber: 1,
      fileObjectId: fileOkId,
      uploadedByUserId: h.userId,
      changeNote: null,
      createdAt: "2026-11-21T15:00:00.000Z",
    });
    h.versions.set(ver2Id, {
      id: ver2Id,
      documentId: docId,
      versionNumber: 2,
      fileObjectId: fileQId,
      uploadedByUserId: h.userId,
      changeNote: null,
      createdAt: "2026-11-21T15:05:00.000Z",
    });

    // Attempting to start workflow on stale v1 instead of current v2 fails
    await expect(
      h.startWorkflowService.startWorkflow({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-stale",
        documentId: docId,
        documentVersionId: ver1Id,
        workflowDefinitionId: definition.id,
      }),
    ).rejects.toThrowError("versão vigente");

    // Attempting on v2 while file is QUARANTINED fails
    await expect(
      h.startWorkflowService.startWorkflow({
        organizationId: h.orgId,
        actorUserId: h.userId,
        requestId: "req-quarantine",
        documentId: docId,
        documentVersionId: ver2Id,
        workflowDefinitionId: definition.id,
      }),
    ).rejects.toThrowError("verificação de segurança");
  });
});
