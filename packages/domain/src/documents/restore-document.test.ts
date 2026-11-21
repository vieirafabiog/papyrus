import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DomainError } from "../index.js";
import type { AuditEventInput, AuditEventRecord } from "../ports/audit-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type { RetentionPolicyEntity } from "../retention/retention.types.js";
import type { DocumentEntity, DocumentStatus } from "./document.types.js";
import { evaluateTrashRestoreWindow, restoreDocumentUseCase } from "./restore-document.js";

function createTestDocument(overrides: Partial<DocumentEntity> = {}): DocumentEntity {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Contrato de Prestação de Serviços",
    categoryId: "22222222-2222-4222-8222-222222222222",
    folderId: "33333333-3333-4333-8333-333333333333",
    status: "DELETED",
    currentVersionId: "44444444-4444-4444-8444-444444444444",
    ownerUserId: "55555555-5555-4555-8555-555555555555",
    issueDate: "2026-01-01",
    expirationDate: "2027-01-01",
    metadata: { departamento: "Jurídico" },
    version: 3,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-02-01T10:00:00.000Z",
    ...overrides,
  };
}

function createMemoryDeps(options: {
  initialDoc?: DocumentEntity | null;
  deletedAt?: Date | null;
  policy?: RetentionPolicyEntity | null;
  now?: Date;
  simulateVersionConflict?: boolean;
}) {
  let doc = options.initialDoc === undefined ? createTestDocument() : options.initialDoc;
  const auditEvents: AuditEventInput[] = [];

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  return {
    auditEvents,
    getDoc: () => doc,
    deps: {
      documents: {
        async findById(documentId: string) {
          return doc && doc.id === documentId ? doc : null;
        },
        async updateStatus(
          documentId: string,
          status: DocumentStatus,
          expectedVersion: number,
        ): Promise<DocumentEntity | null> {
          if (!doc || doc.id !== documentId || doc.version !== expectedVersion) {
            return null;
          }
          if (options.simulateVersionConflict) {
            return null;
          }
          doc = {
            ...doc,
            status,
            version: doc.version + 1,
            updatedAt: (options.now ?? new Date("2026-02-10T10:00:00.000Z")).toISOString(),
          };
          return doc;
        },
      },
      transactions,
      audit: {
        async append(event: AuditEventInput): Promise<AuditEventRecord> {
          auditEvents.push(event);
          return {
            id: `audit-${auditEvents.length}`,
            organizationId: event.organizationId,
            actorUserId: event.actorUserId ?? null,
            action: event.action,
            resourceType: event.resourceType,
            resourceId: event.resourceId ?? null,
            result: event.result,
            ipAddress: event.ipAddress ?? null,
            requestId: event.requestId ?? null,
            metadata: event.metadata ?? {},
            occurredAt: (options.now ?? new Date("2026-02-10T10:00:00.000Z")).toISOString(),
          };
        },
        async list() {
          return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
        },
      },
      holds: {
        async findDocumentDeletedAt() {
          return options.deletedAt ?? null;
        },
      },
      policies: {
        async findApplicablePolicy() {
          return options.policy ?? null;
        },
      },
      now: () => options.now ?? new Date("2026-02-10T10:00:00.000Z"),
    },
  };
}

describe("restoreDocumentUseCase", () => {
  it("restores a trashed document within the grace window, preserving currentVersionId and recording audit", async () => {
    const harness = createMemoryDeps({
      deletedAt: new Date("2026-02-01T10:00:00.000Z"),
      now: new Date("2026-02-10T10:00:00.000Z"),
    });
    const service = restoreDocumentUseCase(harness.deps);

    const restored = await service.restoreDocument({
      organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorUserId: "99999999-9999-4999-8999-999999999999",
      requestId: "req-restore-1",
      documentId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 3,
      targetStatus: "ARCHIVED",
      reason: "  Documento necessário para auditoria fiscal  ",
    });

    assert.equal(restored.status, "ARCHIVED");
    assert.equal(restored.version, 4);
    assert.equal(restored.currentVersionId, "44444444-4444-4444-8444-444444444444");
    assert.equal(harness.auditEvents.length, 1);
    assert.equal(harness.auditEvents[0]?.action, "DOCUMENT_RESTORED");
    assert.equal(harness.auditEvents[0]?.metadata?.newStatus, "ARCHIVED");
    assert.equal(
      harness.auditEvents[0]?.metadata?.reason,
      "Documento necessário para auditoria fiscal",
    );
  });

  it("rejects restoration once the configured trash grace period has expired", async () => {
    const policy: RetentionPolicyEntity = {
      id: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
      organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      categoryId: "22222222-2222-4222-8222-222222222222",
      name: "Prazo curto lixeira",
      retentionDays: 365,
      trashGraceDays: 7,
      actionOnExpiry: "ARCHIVE",
      isActive: true,
      createdBy: "55555555-5555-4555-8555-555555555555",
      updatedBy: "55555555-5555-4555-8555-555555555555",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    };
    const harness = createMemoryDeps({
      deletedAt: new Date("2026-02-01T10:00:00.000Z"),
      policy,
      now: new Date("2026-02-08T10:00:00.000Z"),
    });
    const service = restoreDocumentUseCase(harness.deps);

    await assert.rejects(
      () =>
        service.restoreDocument({
          organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          actorUserId: "99999999-9999-4999-8999-999999999999",
          requestId: "req-restore-2",
          documentId: "11111111-1111-4111-8111-111111111111",
          expectedVersion: 3,
        }),
      (error: unknown) => error instanceof DomainError && error.code === "RESTORE_WINDOW_EXPIRED",
    );
    assert.equal(harness.auditEvents.length, 0);
  });

  it("rejects restoration of documents that are not in DELETED status", async () => {
    const harness = createMemoryDeps({
      initialDoc: createTestDocument({ status: "DRAFT" }),
    });
    const service = restoreDocumentUseCase(harness.deps);

    await assert.rejects(
      () =>
        service.restoreDocument({
          organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          actorUserId: "99999999-9999-4999-8999-999999999999",
          requestId: "req-restore-3",
          documentId: "11111111-1111-4111-8111-111111111111",
          expectedVersion: 3,
        }),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_DOCUMENT_STATE",
    );
  });

  it("rejects with DOCUMENT_VERSION_CONFLICT on optimistic lock mismatch", async () => {
    const harness = createMemoryDeps({
      deletedAt: new Date("2026-02-01T10:00:00.000Z"),
      now: new Date("2026-02-02T10:00:00.000Z"),
      simulateVersionConflict: true,
    });
    const service = restoreDocumentUseCase(harness.deps);

    await assert.rejects(
      () =>
        service.restoreDocument({
          organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          actorUserId: "99999999-9999-4999-8999-999999999999",
          requestId: "req-restore-4",
          documentId: "11111111-1111-4111-8111-111111111111",
          expectedVersion: 3,
        }),
      (error: unknown) =>
        error instanceof DomainError && error.code === "DOCUMENT_VERSION_CONFLICT",
    );
  });

  it("evaluates trash restore deadline consistently", () => {
    const windowOpen = evaluateTrashRestoreWindow({
      deletedAt: new Date("2026-02-01T00:00:00.000Z"),
      graceDays: 30,
      referenceNow: new Date("2026-03-02T23:59:59.000Z"),
    });
    assert.equal(windowOpen.canRestore, true);
    assert.equal(windowOpen.restoreDeadlineAt?.toISOString(), "2026-03-03T00:00:00.000Z");

    const windowExpired = evaluateTrashRestoreWindow({
      deletedAt: new Date("2026-02-01T00:00:00.000Z"),
      graceDays: 0,
      referenceNow: new Date("2026-02-01T00:00:00.000Z"),
    });
    assert.equal(windowExpired.canRestore, false);
  });
});
