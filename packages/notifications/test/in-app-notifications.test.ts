import { describe, expect, it } from "vitest";
import {
  type CreateInAppNotificationRecordInput,
  type InAppNotificationRecord,
  type InAppNotificationRepositoryPort,
  createInAppNotificationService,
} from "../src/index.js";

function createMemoryNotificationRepo(): InAppNotificationRepositoryPort & {
  readonly records: InAppNotificationRecord[];
} {
  const records: InAppNotificationRecord[] = [];
  let seq = 0;

  return {
    records,
    async insertIdempotent(input: CreateInAppNotificationRecordInput) {
      const existing = records.find(
        (item) =>
          item.organizationId === input.organizationId &&
          item.channel === "INTERNAL" &&
          item.recipientUserId === input.recipientUserId &&
          item.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        return { notification: existing, created: false };
      }

      seq += 1;
      const createdRecord: InAppNotificationRecord = {
        id: input.id,
        organizationId: input.organizationId,
        recipientUserId: input.recipientUserId,
        channel: "INTERNAL",
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        title: input.title,
        body: input.body,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        readAt: null,
        sentAt: input.sentAt,
        createdAt: new Date(input.sentAt.getTime() + seq),
      };
      records.push(createdRecord);
      return { notification: createdRecord, created: true };
    },

    async listForRecipient(query) {
      const own = records.filter(
        (item) =>
          item.organizationId === query.organizationId &&
          item.recipientUserId === query.recipientUserId,
      );
      const unreadCount = own.filter((item) => item.readAt === null).length;
      const filtered = own.filter((item) => {
        if (query.unreadOnly && item.readAt !== null) {
          return false;
        }
        if (query.kind && item.kind !== query.kind) {
          return false;
        }
        return true;
      });
      const start = (query.page - 1) * query.pageSize;
      const items = filtered.slice(start, start + query.pageSize);
      return {
        items,
        unreadCount,
        totalItems: filtered.length,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(filtered.length / query.pageSize)),
      };
    },

    async markReadById(input) {
      const idx = records.findIndex(
        (item) => item.id === input.notificationId && item.organizationId === input.organizationId,
      );
      if (idx === -1) {
        return { status: "NOT_FOUND" };
      }
      const target = records[idx];
      if (!target) {
        return { status: "NOT_FOUND" };
      }
      if (target.recipientUserId !== input.recipientUserId) {
        return { status: "FORBIDDEN" };
      }
      if (target.readAt !== null) {
        return { status: "UPDATED", notification: target, alreadyRead: true };
      }
      const updated: InAppNotificationRecord = {
        ...target,
        readAt: input.readAt,
      };
      records[idx] = updated;
      return { status: "UPDATED", notification: updated, alreadyRead: false };
    },
  };
}

describe("In-app notification service", () => {
  it("creates idempotent notifications for task assignments, decisions, and expirations", async () => {
    const repo = createMemoryNotificationRepo();
    let clock = Date.parse("2026-11-21T12:00:00.000Z");
    let idSeq = 0;

    const service = createInAppNotificationService({
      repository: repo,
      generateId: () => `00000000-0000-4000-8000-00000000000${++idSeq}`,
      now: () => new Date(clock),
    });

    const orgId = "11111111-1111-4111-8111-111111111111";
    const aliceId = "22222222-2222-4222-8222-222222222222";
    const bobId = "33333333-3333-4333-8333-333333333333";
    const taskId = "44444444-4444-4444-8444-444444444444";
    const docId = "55555555-5555-4555-8555-555555555555";
    const decisionId = "66666666-6666-4666-8666-666666666666";

    const firstAssign = await service.notifyTaskAssigned({
      organizationId: orgId,
      recipientUserIds: [aliceId, bobId, aliceId],
      taskId,
      documentId: docId,
      documentTitle: "Contrato Fornecedor ACME",
      workflowName: "Aprovação de Contratos",
      stepOrder: 1,
      stepName: "Revisão Jurídica",
      dueAt: new Date("2026-11-25T18:00:00.000Z"),
    });
    expect(firstAssign.createdCount).toBe(2);
    expect(firstAssign.deduplicatedCount).toBe(0);

    // Retry with same idempotency key does not duplicate records
    const retryAssign = await service.notifyTaskAssigned({
      organizationId: orgId,
      recipientUserIds: [aliceId, bobId],
      taskId,
      documentId: docId,
      documentTitle: "Contrato Fornecedor ACME",
      workflowName: "Aprovação de Contratos",
      stepOrder: 1,
      stepName: "Revisão Jurídica",
    });
    expect(retryAssign.createdCount).toBe(0);
    expect(retryAssign.deduplicatedCount).toBe(2);

    const decisionRes = await service.notifyTaskDecision({
      organizationId: orgId,
      recipientUserIds: [bobId],
      decisionId,
      taskId,
      documentId: docId,
      documentTitle: "Contrato Fornecedor ACME",
      decision: "REQUEST_CHANGES",
      actorDisplayName: "Alice Revisora",
      stepName: "Revisão Jurídica",
    });
    expect(decisionRes.createdCount).toBe(1);
    expect(decisionRes.notifications[0]?.resourceType).toBe("DOCUMENT");
    expect(decisionRes.notifications[0]?.resourceId).toBe(docId);

    const expRes = await service.notifyDocumentExpiration({
      organizationId: orgId,
      recipientUserIds: [bobId],
      documentId: docId,
      documentTitle: "Contrato Fornecedor ACME",
      expirationDate: "2026-11-30",
      alertWindowKey: "days-15",
      isExpired: false,
    });
    expect(expRes.createdCount).toBe(1);
    expect(expRes.notifications[0]?.title).toContain("Vencimento próximo");

    // Same expiration alert retried -> idempotent
    const retryExp = await service.notifyDocumentExpiration({
      organizationId: orgId,
      recipientUserIds: [bobId],
      documentId: docId,
      documentTitle: "Contrato Fornecedor ACME",
      expirationDate: "2026-11-30",
      alertWindowKey: "days-15",
      isExpired: false,
    });
    expect(retryExp.createdCount).toBe(0);
    expect(retryExp.deduplicatedCount).toBe(1);

    // Individual read enforcement and idempotent repeat
    const bobList = await service.listForUser({
      organizationId: orgId,
      recipientUserId: bobId,
      page: 1,
      pageSize: 20,
    });
    expect(bobList.totalItems).toBe(3);
    expect(bobList.unreadCount).toBe(3);

    const targetId = bobList.items[0]?.id ?? "";
    const aliceAttempt = await service.markAsRead({
      organizationId: orgId,
      notificationId: targetId,
      recipientUserId: aliceId,
    });
    expect(aliceAttempt.status).toBe("FORBIDDEN");

    const firstRead = await service.markAsRead({
      organizationId: orgId,
      notificationId: targetId,
      recipientUserId: bobId,
    });
    expect(firstRead.status).toBe("UPDATED");
    if (firstRead.status === "UPDATED") {
      expect(firstRead.alreadyRead).toBe(false);
    }

    clock += 60_000;
    const secondRead = await service.markAsRead({
      organizationId: orgId,
      notificationId: targetId,
      recipientUserId: bobId,
    });
    expect(secondRead.status).toBe("UPDATED");
    if (secondRead.status === "UPDATED" && firstRead.status === "UPDATED") {
      expect(secondRead.alreadyRead).toBe(true);
      expect(secondRead.notification.readAt).toEqual(firstRead.notification.readAt);
    }

    // Only one item marked read (not all)
    const bobAfter = await service.listForUser({
      organizationId: orgId,
      recipientUserId: bobId,
      page: 1,
      pageSize: 20,
    });
    expect(bobAfter.unreadCount).toBe(2);
  });
});
