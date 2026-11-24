import { randomUUID } from "node:crypto";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  DocumentStatus,
  TransactionContext,
  TransactionManagerPort,
} from "@papyrus/domain";
import {
  type CreateInAppNotificationRecordInput,
  type EmailMessageInput,
  type InAppNotificationRecord,
  type InAppNotificationRepositoryPort,
  type OptionalSmtpEmailService,
  createInAppNotificationService,
} from "@papyrus/notifications";
import { describe, expect, it, vi } from "vitest";
import {
  type ExpirationAlertRecipient,
  type ExpirationNotificationsStorePort,
  type ExpirationOrganizationTarget,
  type ExpiringDocumentCandidate,
  createExpirationNotificationsHandler,
  resolveExpirationAlertWindow,
} from "../src/jobs/expiration-notifications.js";

function createExpirationJobHarness(initialNowIso = "2026-11-22T01:30:00.000Z") {
  let clockMs = Date.parse(initialNowIso);
  let seq = 1;

  const organizations: ExpirationOrganizationTarget[] = [];
  const documents = new Map<string, ExpiringDocumentCandidate>();
  const recipientsByDoc = new Map<string, ExpirationAlertRecipient[]>();
  const notificationsMap = new Map<string, InAppNotificationRecord>();
  const auditEvents: AuditEventInput[] = [];
  const queuedEmails: EmailMessageInput[] = [];
  let smtpEnabled = true;

  const notificationRepo: InAppNotificationRepositoryPort = {
    async insertIdempotent(input: CreateInAppNotificationRecordInput) {
      const compositeKey = `${input.organizationId}|INTERNAL|${input.recipientUserId}|${input.idempotencyKey}`;
      const existing = notificationsMap.get(compositeKey);
      if (existing) {
        return { notification: existing, created: false };
      }
      const created: InAppNotificationRecord = {
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
        createdAt: new Date(clockMs),
      };
      notificationsMap.set(compositeKey, created);
      return { notification: created, created: true };
    },
    async listForRecipient() {
      return {
        items: [],
        unreadCount: 0,
        totalItems: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
      };
    },
    async markReadById() {
      return { status: "NOT_FOUND" };
    },
  };

  const inAppNotifications = createInAppNotificationService({
    repository: notificationRepo,
    generateId: () => `notif-${seq++}`,
    now: () => new Date(clockMs),
  });

  const emailService: OptionalSmtpEmailService = {
    async getOrganizationSmtpConfig() {
      return null;
    },
    async saveOrganizationSmtpConfig() {
      throw new Error("Not used");
    },
    async testOrganizationSmtpConnection() {
      return { configured: true, enabled: smtpEnabled, healthy: true, message: "ok" };
    },
    async enqueueNotificationEmail(message: EmailMessageInput) {
      if (!smtpEnabled) {
        return { status: "SKIPPED_DISABLED", enqueued: false };
      }
      queuedEmails.push(message);
      return { status: "QUEUED", enqueued: true, jobId: `email-job-${seq++}` };
    },
    async processQueuedEmailJob() {
      return { status: "SKIPPED_DISABLED" };
    },
  };

  const store: ExpirationNotificationsStorePort = {
    async listOrganizations() {
      return [...organizations];
    },
    async listExpiringDocuments({ organizationId, expiresOnOrBeforeDate, limit }) {
      const results: ExpiringDocumentCandidate[] = [];
      for (const doc of documents.values()) {
        if (doc.organizationId !== organizationId) {
          continue;
        }
        if (doc.expirationDate <= expiresOnOrBeforeDate) {
          results.push(doc);
        }
        if (results.length >= limit) {
          break;
        }
      }
      return results;
    },
    async listAuthorizedRecipientsForDocument({ documentId }) {
      return recipientsByDoc.get(documentId) ?? [];
    },
  };

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
        occurredAt: new Date(clockMs).toISOString(),
      };
    },
    async list() {
      return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
    },
  };

  const handler = createExpirationNotificationsHandler({
    store,
    inAppNotifications,
    emailService,
    transactions,
    audit,
    generateId: () => randomUUID(),
    now: () => new Date(clockMs),
  });

  return {
    handler,
    organizations,
    documents,
    recipientsByDoc,
    notificationsMap,
    auditEvents,
    queuedEmails,
    setClock(iso: string) {
      clockMs = Date.parse(iso);
    },
    setSmtpEnabled(enabled: boolean) {
      smtpEnabled = enabled;
    },
  };
}

describe("Expiration notifications job (Step 13.05)", () => {
  it("resolves tightest threshold buckets accurately across days and overdue transitions", () => {
    const thresholds = [0, 7, 30];
    expect(resolveExpirationAlertWindow(-1, thresholds)).toEqual({
      alertWindowKey: "EXPIRED",
      isExpired: true,
    });
    expect(resolveExpirationAlertWindow(0, thresholds)).toEqual({
      alertWindowKey: "DUE_TODAY",
      isExpired: false,
    });
    expect(resolveExpirationAlertWindow(5, thresholds)).toEqual({
      alertWindowKey: "7D",
      isExpired: false,
    });
    expect(resolveExpirationAlertWindow(18, thresholds)).toEqual({
      alertWindowKey: "30D",
      isExpired: false,
    });
    expect(resolveExpirationAlertWindow(31, thresholds)).toBeNull();
  });

  it("deduplicates alerts across retries and consecutive calendar days within the same threshold window", async () => {
    const harness = createExpirationJobHarness("2026-11-21T15:00:00.000Z");
    const orgId = "org-1";
    const owner: ExpirationAlertRecipient = {
      userId: "user-1",
      email: "gestor@papyrus.local",
      fullName: "Gestor",
    };

    harness.organizations.push({
      id: orgId,
      name: "Org Teste",
      timezone: "America/Sao_Paulo",
    });

    // Expires 20 days out -> enters 30D window
    harness.documents.set("doc-1", {
      id: "doc-1",
      organizationId: orgId,
      title: "Contrato Fornecedor",
      status: "APPROVED",
      ownerUserId: owner.userId,
      expirationDate: "2026-12-11",
    });
    // Archived & Deleted docs must be skipped
    harness.documents.set("doc-archived", {
      id: "doc-archived",
      organizationId: orgId,
      title: "Contrato Arquivado",
      status: "ARCHIVED",
      ownerUserId: owner.userId,
      expirationDate: "2026-11-01",
    });
    harness.recipientsByDoc.set("doc-1", [owner]);
    harness.recipientsByDoc.set("doc-archived", [owner]);

    // First run on 2026-11-21 (daysUntil = 20 -> 30D)
    const run1 = await harness.handler.runExpirationNotificationsCycle();
    expect(run1).toMatchObject({
      documentsScanned: 1,
      notificationsCreated: 1,
      notificationsDeduplicated: 0,
      emailsQueued: 1,
      failures: [],
    });

    // Retry immediately -> deduplicated, zero extra emails or audit events
    const retryRun = await harness.handler.runExpirationNotificationsCycle();
    expect(retryRun).toMatchObject({
      notificationsCreated: 0,
      notificationsDeduplicated: 1,
      emailsQueued: 0,
    });

    // Advance calendar day by day inside 30D window (daysUntil = 19, then 18) -> still deduplicated!
    harness.setClock("2026-11-22T15:00:00.000Z");
    const nextDayRun = await harness.handler.runExpirationNotificationsCycle();
    expect(nextDayRun.notificationsCreated).toBe(0);
    expect(nextDayRun.notificationsDeduplicated).toBe(1);

    // Advance into 7D threshold (2026-12-04 -> daysUntil = 7) -> emits exactly ONE 7D alert
    harness.setClock("2026-12-04T15:00:00.000Z");
    const sevenDayRun = await harness.handler.runExpirationNotificationsCycle();
    expect(sevenDayRun.notificationsCreated).toBe(1);
    expect(sevenDayRun.emailsQueued).toBe(1);

    // Advance to due today (2026-12-11 -> daysUntil = 0 -> DUE_TODAY) -> emits DUE_TODAY
    harness.setClock("2026-12-11T15:00:00.000Z");
    const dueTodayRun = await harness.handler.runExpirationNotificationsCycle();
    expect(dueTodayRun.notificationsCreated).toBe(1);

    // Advance past expiration (2026-12-12 -> daysUntil = -1 -> EXPIRED), then retry (2026-12-13)
    harness.setClock("2026-12-12T15:00:00.000Z");
    expect((await harness.handler.runExpirationNotificationsCycle()).notificationsCreated).toBe(1);
    harness.setClock("2026-12-13T15:00:00.000Z");
    expect((await harness.handler.runExpirationNotificationsCycle()).notificationsCreated).toBe(0);

    expect(harness.notificationsMap.size).toBe(4);
    expect(harness.queuedEmails).toHaveLength(4);
    expect(
      harness.auditEvents.filter((e) => e.action === "EXPIRATION_ALERT_SCHEDULED"),
    ).toHaveLength(4);
  });

  it("handles organization timezones and expiration date changes cleanly without duplicate alerts", async () => {
    // 2026-11-22T01:30:00Z = 2026-11-21 22:30 in America/Sao_Paulo, 2026-11-22 10:30 in Asia/Tokyo
    const harness = createExpirationJobHarness("2026-11-22T01:30:00.000Z");
    const recipient: ExpirationAlertRecipient = {
      userId: "user-tz",
      email: "tz@papyrus.local",
      fullName: "TZ User",
    };

    harness.organizations.push(
      { id: "org-sp", name: "SP", timezone: "America/Sao_Paulo" },
      { id: "org-tokyo", name: "Tokyo", timezone: "Asia/Tokyo" },
    );

    harness.documents.set("doc-sp", {
      id: "doc-sp",
      organizationId: "org-sp",
      title: "Certidão SP",
      status: "APPROVED",
      ownerUserId: recipient.userId,
      expirationDate: "2026-11-21",
    });
    harness.documents.set("doc-tokyo", {
      id: "doc-tokyo",
      organizationId: "org-tokyo",
      title: "Certidão Tokyo",
      status: "APPROVED",
      ownerUserId: recipient.userId,
      expirationDate: "2026-11-21",
    });
    harness.recipientsByDoc.set("doc-sp", [recipient]);
    harness.recipientsByDoc.set("doc-tokyo", [recipient]);

    const first = await harness.handler.runExpirationNotificationsCycle();
    expect(first.notificationsCreated).toBe(2);

    const spNotif = Array.from(harness.notificationsMap.values()).find(
      (n) => n.resourceId === "doc-sp",
    );
    const tokyoNotif = Array.from(harness.notificationsMap.values()).find(
      (n) => n.resourceId === "doc-tokyo",
    );
    expect(spNotif?.idempotencyKey).toContain(":DUE_TODAY:");
    expect(tokyoNotif?.idempotencyKey).toContain(":EXPIRED:");

    // Now renew/change expiration date on doc-sp to 2026-12-01 (daysUntil = 10 -> 30D)
    harness.documents.set("doc-sp", {
      id: "doc-sp",
      organizationId: "org-sp",
      title: "Certidão SP",
      status: "APPROVED",
      ownerUserId: recipient.userId,
      expirationDate: "2026-12-01",
    });
    const dateChangedRun = await harness.handler.runExpirationNotificationsCycle();
    expect(dateChangedRun.notificationsCreated).toBe(1);
    expect(dateChangedRun.notificationsDeduplicated).toBe(1);

    // Repeating after date change stays idempotent
    const retryAfterChange = await harness.handler.runExpirationNotificationsCycle();
    expect(retryAfterChange.notificationsCreated).toBe(0);
    expect(retryAfterChange.notificationsDeduplicated).toBe(2);
  });

  it("skips unauthorized/inactive recipients, skips SMTP when disabled, and isolates per-document failures", async () => {
    const harness = createExpirationJobHarness("2026-11-21T12:00:00.000Z");
    harness.setSmtpEnabled(false);
    harness.organizations.push({
      id: "org-fail",
      name: "Org Isolada",
      timezone: "UTC",
    });

    harness.documents.set("doc-no-recip", {
      id: "doc-no-recip",
      organizationId: "org-fail",
      title: "Documento Sem Autorizados",
      status: "APPROVED",
      ownerUserId: "revoked-user",
      expirationDate: "2026-11-25",
    });
    harness.documents.set("doc-ok", {
      id: "doc-ok",
      organizationId: "org-fail",
      title: "Documento Válido",
      status: "DRAFT",
      ownerUserId: "active-user",
      expirationDate: "2026-11-25",
    });
    harness.recipientsByDoc.set("doc-no-recip", []);
    harness.recipientsByDoc.set("doc-ok", [
      { userId: "active-user", email: "active@papyrus.local", fullName: "Ativo" },
    ]);

    const result = await harness.handler.runExpirationNotificationsCycle();
    expect(result).toMatchObject({
      documentsScanned: 2,
      notificationsCreated: 1,
      emailsQueued: 0,
      emailsSkippedDisabled: 1,
      unauthorizedRecipientsSkipped: 1,
      failures: [],
    });

    // Simulate transient error on one document while succeeding on another
    vi.spyOn(harness.auditEvents, "push").mockImplementationOnce(() => {
      throw new Error("Simulated transient error");
    });
    harness.documents.set("doc-err", {
      id: "doc-err",
      organizationId: "org-fail",
      title: "Documento Erro",
      status: "APPROVED",
      ownerUserId: "active-user",
      expirationDate: "2026-11-24",
    });
    harness.recipientsByDoc.set("doc-err", [
      { userId: "active-user", email: "active@papyrus.local", fullName: "Ativo" },
    ]);

    const partialResult = await harness.handler.runExpirationNotificationsCycle();
    expect(partialResult.failures).toHaveLength(1);
    expect(partialResult.failures[0]?.documentId).toBe("doc-err");
  });
});
