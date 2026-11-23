import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  CategoryEntity,
  DocumentEntity,
  DocumentRetentionHoldEntity,
  DocumentRetentionHoldRepositoryPort,
  RetentionPolicyEntity,
  RetentionPolicyRepositoryPort,
  TransactionContext,
  TransactionManagerPort,
} from "../index.js";
import {
  DomainError,
  createRetentionGovernanceService,
  evaluateDocumentPurgeEligibility,
  selectApplicableRetentionPolicy,
} from "../index.js";

function createRetentionHarness(initialNowIso = "2026-11-21T12:00:00.000Z") {
  let seq = 1;
  const nowDate = new Date(initialNowIso);
  const policies = new Map<string, RetentionPolicyEntity>();
  const holds = new Map<string, DocumentRetentionHoldEntity>();
  const documents = new Map<string, DocumentEntity>();
  const deletedAtMap = new Map<string, Date | null>();
  const categories = new Map<string, CategoryEntity>();
  const auditEvents: AuditEventInput[] = [];

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const audit: AuditRepositoryPort = {
    async append(event) {
      auditEvents.push(event);
      return {
        ...event,
        id: `audit-${seq++}`,
        occurredAt: nowDate.toISOString(),
      };
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const policyRepo: RetentionPolicyRepositoryPort = {
    async listByOrganization(orgId) {
      return Array.from(policies.values()).filter((p) => p.organizationId === orgId);
    },
    async findById(policyId) {
      return policies.get(policyId) ?? null;
    },
    async findByName(orgId, name) {
      return (
        Array.from(policies.values()).find((p) => p.organizationId === orgId && p.name === name) ??
        null
      );
    },
    async findApplicablePolicy(orgId, categoryId) {
      const orgPolicies = Array.from(policies.values()).filter((p) => p.organizationId === orgId);
      return selectApplicableRetentionPolicy(orgPolicies, categoryId);
    },
    async create(input) {
      const created: RetentionPolicyEntity = {
        id: input.id,
        organizationId: input.organizationId,
        categoryId: input.categoryId,
        name: input.name,
        retentionDays: input.retentionDays,
        trashGraceDays: input.trashGraceDays,
        actionOnExpiry: input.actionOnExpiry,
        isActive: input.isActive,
        createdBy: input.createdBy,
        updatedBy: input.createdBy,
        createdAt: nowDate.toISOString(),
        updatedAt: nowDate.toISOString(),
      };
      policies.set(created.id, created);
      return created;
    },
    async update(policyId, input) {
      const existing = policies.get(policyId);
      if (!existing) {
        return null;
      }
      const updated: RetentionPolicyEntity = {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
        ...(input.trashGraceDays !== undefined ? { trashGraceDays: input.trashGraceDays } : {}),
        ...(input.actionOnExpiry !== undefined ? { actionOnExpiry: input.actionOnExpiry } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedBy: input.updatedBy,
        updatedAt: nowDate.toISOString(),
      };
      policies.set(updated.id, updated);
      return updated;
    },
  };

  const holdRepo: DocumentRetentionHoldRepositoryPort = {
    async listForDocument(orgId, documentId) {
      return Array.from(holds.values()).filter(
        (h) => h.organizationId === orgId && h.documentId === documentId,
      );
    },
    async listActiveForDocument(orgId, documentId) {
      return Array.from(holds.values()).filter(
        (h) => h.organizationId === orgId && h.documentId === documentId && h.releasedAt === null,
      );
    },
    async findById(holdId) {
      return holds.get(holdId) ?? null;
    },
    async hasActiveHold(orgId, documentId) {
      return Array.from(holds.values()).some(
        (h) => h.organizationId === orgId && h.documentId === documentId && h.releasedAt === null,
      );
    },
    async findDocumentDeletedAt(_orgId, documentId) {
      return deletedAtMap.get(documentId) ?? null;
    },
    async createHold(input) {
      const hold: DocumentRetentionHoldEntity = {
        id: input.id,
        organizationId: input.organizationId,
        documentId: input.documentId,
        reason: input.reason,
        placedByUserId: input.placedByUserId,
        placedAt: input.placedAt.toISOString(),
        releasedByUserId: null,
        releasedAt: null,
        releaseReason: null,
      };
      holds.set(hold.id, hold);
      return hold;
    },
    async releaseHold(input) {
      const existing = holds.get(input.holdId);
      if (
        !existing ||
        existing.organizationId !== input.organizationId ||
        existing.documentId !== input.documentId ||
        existing.releasedAt !== null
      ) {
        return null;
      }
      const released: DocumentRetentionHoldEntity = {
        ...existing,
        releasedByUserId: input.releasedByUserId,
        releasedAt: input.releasedAt.toISOString(),
        releaseReason: input.releaseReason,
      };
      holds.set(released.id, released);
      return released;
    },
  };

  const docRepo = {
    async findById(id: string) {
      return documents.get(id) ?? null;
    },
  };

  const catRepo = {
    async findById(id: string) {
      return categories.get(id) ?? null;
    },
  };

  const service = createRetentionGovernanceService({
    policies: policyRepo,
    holds: holdRepo,
    documents: docRepo,
    categories: catRepo,
    transactions,
    audit,
    generateId: () => `ret-${seq++}`,
    now: () => nowDate,
  });

  return { service, policies, holds, documents, deletedAtMap, categories, auditEvents };
}

describe("Retention policies and legal hold governance", () => {
  it("starts with zero pre-seeded legal timeframes and supports configurable org and category rules", async () => {
    const harness = createRetentionHarness();
    const orgId = "org-1";
    const catId = "cat-contratos";
    harness.categories.set(catId, {
      id: catId,
      organizationId: orgId,
      name: "Contratos",
      description: null,
      color: null,
      icon: null,
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    // No hardcoded universal legal retention presets exist by default
    expect(await harness.service.listPolicies(orgId)).toEqual([]);

    const globalPolicy = await harness.service.createPolicy({
      organizationId: orgId,
      actorUserId: "admin-1",
      requestId: "req-1",
      name: "Política Geral Definida pela Empresa",
      categoryId: null,
      retentionDays: 365,
      trashGraceDays: 15,
      actionOnExpiry: "ARCHIVE",
    });

    const categoryPolicy = await harness.service.createPolicy({
      organizationId: orgId,
      actorUserId: "admin-1",
      requestId: "req-2",
      name: "Contratos Comerciais (Interno)",
      categoryId: catId,
      retentionDays: 180,
      trashGraceDays: 30,
      actionOnExpiry: "PURGE",
    });

    expect(selectApplicableRetentionPolicy([globalPolicy, categoryPolicy], catId)?.id).toBe(
      categoryPolicy.id,
    );
    expect(selectApplicableRetentionPolicy([globalPolicy, categoryPolicy], "cat-outros")?.id).toBe(
      globalPolicy.id,
    );

    // Updating to inactive falls back cleanly to global rule
    const deactivated = await harness.service.updatePolicy({
      organizationId: orgId,
      actorUserId: "admin-1",
      requestId: "req-3",
      policyId: categoryPolicy.id,
      isActive: false,
    });
    expect(deactivated.isActive).toBe(false);
    expect(selectApplicableRetentionPolicy([globalPolicy, deactivated], catId)?.id).toBe(
      globalPolicy.id,
    );

    await expect(
      harness.service.createPolicy({
        organizationId: orgId,
        actorUserId: "admin-1",
        requestId: "req-4",
        name: "Regra Inválida",
        retentionDays: 0,
      }),
    ).rejects.toThrow(DomainError);

    expect(harness.auditEvents.map((e) => e.action)).toEqual([
      "RETENTION_POLICY_CREATED",
      "RETENTION_POLICY_CREATED",
      "RETENTION_POLICY_UPDATED",
    ]);
  });

  it("blocks purge whenever any legal hold is active and permits purge only after hold release and retention/grace windows elapse", async () => {
    const harness = createRetentionHarness("2026-11-21T12:00:00.000Z");
    const orgId = "org-1";
    const catId = "cat-1";
    const docId = "doc-1";

    harness.categories.set(catId, {
      id: catId,
      organizationId: orgId,
      name: "Operacional",
      description: null,
      color: null,
      icon: null,
      isActive: true,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });

    await harness.service.createPolicy({
      organizationId: orgId,
      actorUserId: "admin-1",
      requestId: "req-pol",
      name: "Regra Operacional",
      categoryId: catId,
      retentionDays: 90,
      trashGraceDays: 30,
      actionOnExpiry: "PURGE",
    });

    const deletedDoc: DocumentEntity = {
      id: docId,
      organizationId: orgId,
      title: "Documento Descartado",
      categoryId: catId,
      folderId: null,
      status: "DELETED",
      currentVersionId: null,
      ownerUserId: "owner-1",
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 2,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    harness.documents.set(docId, deletedDoc);
    // Deleted 51 days ago (trashGraceDays=30 and retentionDays=90 have already elapsed)
    harness.deletedAtMap.set(docId, new Date("2026-10-01T00:00:00.000Z"));

    // Place two independent legal holds
    const hold1 = await harness.service.placeHold({
      organizationId: orgId,
      actorUserId: "legal-1",
      requestId: "req-h1",
      documentId: docId,
      reason: "Auditoria interna em andamento",
    });
    const hold2 = await harness.service.placeHold({
      organizationId: orgId,
      actorUserId: "legal-2",
      requestId: "req-h2",
      documentId: docId,
      reason: "Conferência contratual pendente",
    });

    await expect(
      harness.service.assertPurgeAllowed({
        organizationId: orgId,
        documentId: docId,
        referenceNow: new Date("2026-11-21T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "RETENTION_HOLD_ACTIVE" });

    // Releasing only the first hold MUST still block purge
    await harness.service.releaseHold({
      organizationId: orgId,
      actorUserId: "legal-1",
      requestId: "req-r1",
      documentId: docId,
      holdId: hold1.id,
      releaseReason: "Auditoria concluída",
    });

    const stillBlocked = await harness.service.evaluatePurgeForDocument({
      organizationId: orgId,
      documentId: docId,
      referenceNow: new Date("2026-11-21T12:00:00.000Z"),
    });
    expect(stillBlocked.eligible).toBe(false);
    expect(stillBlocked.activeHoldCount).toBe(1);
    expect(stillBlocked.blockReasons).toEqual(["ACTIVE_HOLD"]);

    // Releasing the second hold lifts all hold blocks
    await harness.service.releaseHold({
      organizationId: orgId,
      actorUserId: "legal-2",
      requestId: "req-r2",
      documentId: docId,
      holdId: hold2.id,
      releaseReason: "Conferência encerrada",
    });

    const eligibleNow = await harness.service.assertPurgeAllowed({
      organizationId: orgId,
      documentId: docId,
      referenceNow: new Date("2026-11-21T12:00:00.000Z"),
    });
    expect(eligibleNow.eligible).toBe(true);
    expect(eligibleNow.activeHoldCount).toBe(0);
    expect(eligibleNow.blockReasons).toEqual([]);

    // Grace window not elapsed blocks purge cleanly even without holds
    const graceBlocked = evaluateDocumentPurgeEligibility({
      document: deletedDoc,
      deletedAt: new Date("2026-11-10T00:00:00.000Z"),
      activeHolds: [],
      policy: null,
      referenceNow: new Date("2026-11-21T00:00:00.000Z"),
      fallbackTrashGraceDays: 30,
    });
    expect(graceBlocked.eligible).toBe(false);
    expect(graceBlocked.blockReasons).toEqual(["TRASH_GRACE_WINDOW_NOT_ELAPSED"]);
  });

  it("enforces hold block years past policy expiry, isolates cross-org hold calls, and preserves append-only retention audits", async () => {
    const harness = createRetentionHarness("2030-01-15T12:00:00.000Z");
    const orgId = "org-1";
    const otherOrgId = "org-2";
    const catId = "cat-legal";
    const docId = "doc-aged";

    harness.categories.set(catId, {
      id: catId,
      organizationId: orgId,
      name: "Jurídico",
      description: null,
      color: null,
      icon: null,
      isActive: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    await harness.service.createPolicy({
      organizationId: orgId,
      actorUserId: "admin-1",
      requestId: "req-aged-pol",
      name: "Curta Temporalidade",
      categoryId: catId,
      retentionDays: 1,
      trashGraceDays: 1,
      actionOnExpiry: "PURGE",
    });

    const agedDeletedDoc: DocumentEntity = {
      id: docId,
      organizationId: orgId,
      title: "Contrato Antigo Sob Bloqueio",
      categoryId: catId,
      folderId: null,
      status: "DELETED",
      currentVersionId: "ver-aged-1",
      ownerUserId: "owner-1",
      issueDate: null,
      expirationDate: null,
      metadata: {},
      version: 4,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    harness.documents.set(docId, agedDeletedDoc);
    harness.deletedAtMap.set(docId, new Date("2025-01-01T00:00:00.000Z"));

    const hold = await harness.service.placeHold({
      organizationId: orgId,
      actorUserId: "legal-counsel",
      requestId: "req-hold-aged",
      documentId: docId,
      reason: "Preservação probatória indefinida",
    });

    // Five years past retention & grace expiry, active hold STILL blocks purge
    const evaluation = await harness.service.evaluatePurgeForDocument({
      organizationId: orgId,
      documentId: docId,
      referenceNow: new Date("2030-01-15T12:00:00.000Z"),
    });
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockReasons).toEqual(["ACTIVE_HOLD"]);
    expect(evaluation.activeHoldCount).toBe(1);

    // Cross-tenant attempts cannot inspect, place, or release holds on org-1 documents
    await expect(
      harness.service.placeHold({
        organizationId: otherOrgId,
        actorUserId: "attacker",
        requestId: "req-cross-1",
        documentId: docId,
        reason: "Tentativa indevida",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });

    await expect(
      harness.service.releaseHold({
        organizationId: otherOrgId,
        actorUserId: "attacker",
        requestId: "req-cross-2",
        documentId: docId,
        holdId: hold.id,
        releaseReason: "Tentativa de remoção indevida",
      }),
    ).rejects.toMatchObject({ code: "HOLD_NOT_FOUND" });

    // Only non-deleted documents are blocked even after hold release if restored before purge
    await harness.service.releaseHold({
      organizationId: orgId,
      actorUserId: "legal-counsel",
      requestId: "req-rel-aged",
      documentId: docId,
      holdId: hold.id,
      releaseReason: "Trânsito em julgado",
    });

    const restoredDoc: DocumentEntity = { ...agedDeletedDoc, status: "APPROVED", version: 5 };
    const restoredEval = evaluateDocumentPurgeEligibility({
      document: restoredDoc,
      deletedAt: new Date("2025-01-01T00:00:00.000Z"),
      activeHolds: [],
      policy: null,
      referenceNow: new Date("2030-01-15T12:00:00.000Z"),
      fallbackTrashGraceDays: 1,
    });
    expect(restoredEval.eligible).toBe(false);
    expect(restoredEval.blockReasons).toEqual(["NOT_IN_TRASH"]);

    // Audit trail preserves every step append-only
    expect(harness.auditEvents.map((event) => event.action)).toEqual([
      "RETENTION_POLICY_CREATED",
      "RETENTION_HOLD_PLACED",
      "RETENTION_HOLD_RELEASED",
    ]);
    expect(harness.auditEvents.every((event) => event.resourceId !== null)).toBe(true);
  });
});
