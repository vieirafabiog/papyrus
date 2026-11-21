import { describe, expect, it } from "vitest";
import {
  type AuditEventInput,
  type AuditEventRecord,
  type AuditListFilter,
  type AuditRepositoryPort,
  DomainError,
  type PaginatedResult,
  type TransactionContext,
  type TransactionManagerPort,
  type WorkflowDefinitionEntity,
  type WorkflowDefinitionRepositoryPort,
  type WorkflowDefinitionVersionEntity,
  calculateStepDueAt,
  createWorkflowDefinitionService,
  validateDecisionComment,
  validateSequentialWorkflowSteps,
} from "../src/index.js";

function createInMemoryDefinitionHarness() {
  const definitions = new Map<string, WorkflowDefinitionEntity>();
  const versions = new Map<string, WorkflowDefinitionVersionEntity>();
  const auditEvents: AuditEventRecord[] = [];
  let seq = 0;
  const now = new Date("2026-11-21T15:00:00.000Z");

  const repository: WorkflowDefinitionRepositoryPort = {
    async findById(id) {
      return definitions.get(id) ?? null;
    },
    async findByName(organizationId, name) {
      for (const item of definitions.values()) {
        if (
          item.organizationId === organizationId &&
          item.name.toLowerCase() === name.toLowerCase()
        ) {
          return item;
        }
      }
      return null;
    },
    async listByOrganization(organizationId, options) {
      return Array.from(definitions.values()).filter(
        (d) => d.organizationId === organizationId && (options?.activeOnly ? d.isActive : true),
      );
    },
    async findVersionById(versionId) {
      return versions.get(versionId) ?? null;
    },
    async findVersionByNumber(workflowDefinitionId, versionNumber) {
      for (const v of versions.values()) {
        if (v.workflowDefinitionId === workflowDefinitionId && v.versionNumber === versionNumber) {
          return v;
        }
      }
      return null;
    },
    async listVersions(workflowDefinitionId) {
      return Array.from(versions.values())
        .filter((v) => v.workflowDefinitionId === workflowDefinitionId)
        .sort((a, b) => a.versionNumber - b.versionNumber);
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
        steps: input.steps.map((s) => ({
          ...s,
          assignee: { ...s.assignee },
          commentRules: s.commentRules ? { ...s.commentRules } : undefined,
        })),
        createdAt: now.toISOString(),
      };
      definitions.set(def.id, def);
      versions.set(ver.id, ver);
      return { definition: def, version: ver };
    },
    async publishNewVersion(input) {
      const existing = definitions.get(input.workflowDefinitionId);
      if (!existing || existing.latestVersionNumber !== input.expectedLatestVersionNumber) {
        return null;
      }
      const nextNum = existing.latestVersionNumber + 1;
      const updatedDef: WorkflowDefinitionEntity = {
        ...existing,
        latestVersionNumber: nextNum,
        updatedAt: now.toISOString(),
      };
      const nextVer: WorkflowDefinitionVersionEntity = {
        id: input.versionId,
        workflowDefinitionId: existing.id,
        versionNumber: nextNum,
        steps: input.steps.map((s) => ({
          ...s,
          assignee: { ...s.assignee },
          commentRules: s.commentRules ? { ...s.commentRules } : undefined,
        })),
        createdAt: now.toISOString(),
      };
      definitions.set(updatedDef.id, updatedDef);
      versions.set(nextVer.id, nextVer);
      return { definition: updatedDef, version: nextVer };
    },
    async updateMetadata(input) {
      const existing = definitions.get(input.workflowDefinitionId);
      if (!existing) {
        return null;
      }
      const next: WorkflowDefinitionEntity = {
        ...existing,
        isActive: input.isActive ?? existing.isActive,
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        updatedAt: now.toISOString(),
      };
      definitions.set(next.id, next);
      return next;
    },
  };

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const audit: AuditRepositoryPort = {
    async append(input: AuditEventInput): Promise<AuditEventRecord> {
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
    async list(_filter: AuditListFilter): Promise<PaginatedResult<AuditEventRecord>> {
      return {
        items: auditEvents,
        page: 1,
        pageSize: 50,
        totalItems: auditEvents.length,
        totalPages: 1,
      };
    },
  };

  const service = createWorkflowDefinitionService({
    definitions: repository,
    transactions,
    audit,
    generateId: () => `id-${++seq}`,
  });

  return { service, auditEvents, definitions, versions };
}

describe("Versioned workflow definitions", () => {
  const orgId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const groupId = "33333333-3333-4333-8333-333333333333";
  const roleId = "44444444-4444-4444-8444-444444444444";

  it("validates sequential step ordering, approver targets, dueDays, and mandatory comment policies", () => {
    expect(() => validateSequentialWorkflowSteps([])).toThrowError(DomainError);

    // Gap in stepOrder (1 -> 3) rejected
    expect(() =>
      validateSequentialWorkflowSteps([
        { stepOrder: 1, name: "Jurídico", assignee: { type: "GROUP", groupId }, dueDays: 3 },
        { stepOrder: 3, name: "Diretoria", assignee: { type: "ROLE", roleId }, dueDays: 5 },
      ]),
    ).toThrowError(DomainError);

    // Invalid dueDays rejected
    expect(() =>
      validateSequentialWorkflowSteps([
        { stepOrder: 1, name: "Jurídico", assignee: { type: "GROUP", groupId }, dueDays: 0 },
      ]),
    ).toThrowError(DomainError);

    // Disabling mandatory comment on reject/request changes forbidden
    expect(() =>
      validateSequentialWorkflowSteps([
        {
          stepOrder: 1,
          name: "Jurídico",
          assignee: { type: "GROUP", groupId },
          dueDays: 5,
          commentRules: { requireOnReject: false },
        },
      ]),
    ).toThrowError(DomainError);

    const validated = validateSequentialWorkflowSteps([
      {
        stepOrder: 2,
        name: "Aprovação Diretoria",
        assignee: { type: "ROLE", roleId },
        dueDays: 2,
        commentRules: { requireOnApprove: true },
      },
      {
        stepOrder: 1,
        name: "Revisão Jurídica",
        assignee: { type: "GROUP", groupId },
        dueDays: null,
      },
    ]);

    expect(validated.map((s) => s.stepOrder)).toEqual([1, 2]);
    const step1 = validated[0];
    const step2 = validated[1];
    expect(step1).toBeDefined();
    expect(step2).toBeDefined();

    if (step1 && step2) {
      expect(() => validateDecisionComment(step1, "REJECT", "   ")).toThrowError(
        "Comentário é obrigatório",
      );
      expect(() => validateDecisionComment(step1, "REQUEST_CHANGES", null)).toThrowError(
        DomainError,
      );
      expect(validateDecisionComment(step1, "APPROVE", null)).toBeNull();
      expect(() => validateDecisionComment(step2, "APPROVE", "")).toThrowError(
        "exige comentário obrigatório para aprovação",
      );
      expect(validateDecisionComment(step2, "APPROVE", "  Aprovado conforme minuta  ")).toBe(
        "Aprovado conforme minuta",
      );
    }

    expect(calculateStepDueAt(new Date("2026-11-21T10:00:00.000Z"), 5)).toBe(
      "2026-11-26T10:00:00.000Z",
    );
    expect(calculateStepDueAt(new Date("2026-11-21T10:00:00.000Z"), null)).toBeNull();
  });

  it("creates immutable versions, publishes new versions without mutating prior snapshots, and enforces org/name/active invariants", async () => {
    const h = createInMemoryDefinitionHarness();

    const created = await h.service.createDefinition({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-1",
      name: "  Aprovação de Contratos  ",
      description: "Fluxo jurídico seguido por diretoria.",
      steps: [
        {
          stepOrder: 1,
          name: "Parecer Jurídico",
          assignee: { type: "GROUP", groupId },
          dueDays: 3,
        },
      ],
    });

    expect(created.definition.name).toBe("Aprovação de Contratos");
    expect(created.definition.latestVersionNumber).toBe(1);
    expect(created.version.versionNumber).toBe(1);
    expect(created.version.steps[0]?.commentRules).toEqual({
      requireOnApprove: false,
      requireOnReject: true,
      requireOnRequestChanges: true,
    });

    // Duplicate name inside same org rejected
    await expect(
      h.service.createDefinition({
        organizationId: orgId,
        actorUserId: userId,
        requestId: "req-2",
        name: "aprovação de contratos",
        steps: [
          {
            stepOrder: 1,
            name: "Etapa Única",
            assignee: { type: "USER", userId },
            dueDays: 1,
          },
        ],
      }),
    ).rejects.toThrowError("Já existe uma definição de fluxo com este nome");

    // Publish version 2 with different steps and approver roles
    const v2 = await h.service.publishNewVersion({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-3",
      workflowDefinitionId: created.definition.id,
      steps: [
        {
          stepOrder: 1,
          name: "Parecer Jurídico",
          assignee: { type: "GROUP", groupId },
          dueDays: 2,
        },
        {
          stepOrder: 2,
          name: "Aprovação Executiva",
          assignee: { type: "ROLE", roleId },
          dueDays: 5,
          commentRules: { requireOnApprove: true },
        },
      ],
    });

    expect(v2.definition.latestVersionNumber).toBe(2);
    expect(v2.version.versionNumber).toBe(2);

    const history = await h.service.getDefinitionWithVersions(orgId, created.definition.id);
    expect(history.versions).toHaveLength(2);
    // Version 1 snapshot remains completely unchanged!
    expect(history.versions[0]?.steps).toHaveLength(1);
    expect(history.versions[0]?.steps[0]?.dueDays).toBe(3);
    expect(history.versions[1]?.steps).toHaveLength(2);

    // Cross-organization lookup masked cleanly
    await expect(
      h.service.getDefinitionWithVersions(
        "99999999-9999-4999-8999-999999999999",
        created.definition.id,
      ),
    ).rejects.toThrowError("Definição de fluxo não encontrada.");

    // Deactivating blocks publishing new versions while preserving existing versions
    await h.service.setActiveStatus({
      organizationId: orgId,
      actorUserId: userId,
      requestId: "req-4",
      workflowDefinitionId: created.definition.id,
      isActive: false,
    });

    await expect(
      h.service.publishNewVersion({
        organizationId: orgId,
        actorUserId: userId,
        requestId: "req-5",
        workflowDefinitionId: created.definition.id,
        steps: [{ stepOrder: 1, name: "Etapa", assignee: { type: "USER", userId }, dueDays: 1 }],
      }),
    ).rejects.toThrowError("desativada");

    expect(h.auditEvents.map((e) => e.action)).toEqual([
      "WORKFLOW_DEFINITION_CREATED",
      "WORKFLOW_DEFINITION_VERSION_PUBLISHED",
      "WORKFLOW_DEFINITION_STATUS_CHANGED",
    ]);
  });
});
