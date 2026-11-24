import {
  type AuditRepositoryPort,
  type DocumentStatus,
  type TransactionContext,
  type TransactionManagerPort,
  addCalendarDays,
  createAuditWriter,
  diffCalendarDays,
  resolveLocalCalendarDate,
} from "@papyrus/domain";
import type { InAppNotificationService, OptionalSmtpEmailService } from "@papyrus/notifications";

export const DEFAULT_EXPIRATION_ALERT_THRESHOLDS_DAYS = [0, 7, 30] as const;
const DEFAULT_BATCH_SIZE = 200;
const ELIGIBLE_EXPIRATION_DOCUMENT_STATUSES: ReadonlySet<DocumentStatus> = new Set([
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "EXPIRED",
]);

export interface ExpirationOrganizationTarget {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
}

export interface ExpiringDocumentCandidate {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly ownerUserId: string;
  readonly expirationDate: string;
}

export interface ExpirationAlertRecipient {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
}

export interface ExpirationNotificationsStorePort {
  listOrganizations(): Promise<readonly ExpirationOrganizationTarget[]>;
  listExpiringDocuments(params: {
    readonly organizationId: string;
    readonly expiresOnOrBeforeDate: string;
    readonly limit: number;
  }): Promise<readonly ExpiringDocumentCandidate[]>;
  listAuthorizedRecipientsForDocument(params: {
    readonly organizationId: string;
    readonly documentId: string;
    readonly ownerUserId: string;
  }): Promise<readonly ExpirationAlertRecipient[]>;
}

export interface ExpirationAlertWindow {
  readonly alertWindowKey: string;
  readonly isExpired: boolean;
}

export interface ExpirationAlertFailureRecord {
  readonly organizationId: string;
  readonly documentId: string;
  readonly reason: string;
}

export interface ExpirationNotificationsReport {
  readonly organizationsEvaluated: number;
  readonly documentsScanned: number;
  readonly notificationsCreated: number;
  readonly notificationsDeduplicated: number;
  readonly emailsQueued: number;
  readonly emailsSkippedDisabled: number;
  readonly unauthorizedRecipientsSkipped: number;
  readonly failures: readonly ExpirationAlertFailureRecord[];
}

export interface ExpirationNotificationsDependencies {
  readonly store: ExpirationNotificationsStorePort;
  readonly inAppNotifications: InAppNotificationService;
  readonly emailService?: OptionalSmtpEmailService | undefined;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly alertThresholdsDays?: readonly number[] | undefined;
  readonly batchSize?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ExpirationNotificationsHandler {
  runExpirationNotificationsCycle(): Promise<ExpirationNotificationsReport>;
}

function normalizeThresholds(rawThresholds: readonly number[] | undefined): readonly number[] {
  const source = rawThresholds ?? DEFAULT_EXPIRATION_ALERT_THRESHOLDS_DAYS;
  const uniqueNonNegative = new Set<number>();
  for (const days of source) {
    if (Number.isInteger(days) && days >= 0 && days <= 365) {
      uniqueNonNegative.add(days);
    }
  }
  if (uniqueNonNegative.size === 0) {
    return [...DEFAULT_EXPIRATION_ALERT_THRESHOLDS_DAYS];
  }
  return Array.from(uniqueNonNegative).sort((a, b) => a - b);
}

/**
 * Maps a signed day delta `(expirationDate - todayLocalDate)` onto the tightest matching
 * threshold window so daily runs within the same window share a stable idempotency key.
 */
export function resolveExpirationAlertWindow(
  daysUntilExpiration: number,
  sortedThresholds: readonly number[],
): ExpirationAlertWindow | null {
  if (daysUntilExpiration < 0) {
    return {
      alertWindowKey: "EXPIRED",
      isExpired: true,
    };
  }

  for (const thresholdDays of sortedThresholds) {
    if (daysUntilExpiration <= thresholdDays) {
      return {
        alertWindowKey: thresholdDays === 0 ? "DUE_TODAY" : `${thresholdDays}D`,
        isExpired: false,
      };
    }
  }

  return null;
}

function formatIsoDatePtBr(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) {
    return isoDate;
  }
  return `${day}/${month}/${year}`;
}

function buildEmailSubjectAndBody(
  doc: ExpiringDocumentCandidate,
  daysUntilExpiration: number,
  isExpired: boolean,
): { readonly subject: string; readonly textBody: string } {
  const formattedDate = formatIsoDatePtBr(doc.expirationDate);
  if (isExpired) {
    const overdueDays = Math.abs(daysUntilExpiration);
    const daysText = overdueDays === 1 ? "1 dia" : `${overdueDays} dias`;
    return {
      subject: `[papyrus] Documento vencido: ${doc.title}`,
      textBody: `O documento "${doc.title}" venceu em ${formattedDate} (há ${daysText}). Acesse o papyrus para verificar a renovação ou tratamento aplicável.`,
    };
  }
  if (daysUntilExpiration === 0) {
    return {
      subject: `[papyrus] Documento vence hoje: ${doc.title}`,
      textBody: `O documento "${doc.title}" vence hoje (${formattedDate}). Acesse o papyrus para acompanhar o vencimento.`,
    };
  }
  const daysText = daysUntilExpiration === 1 ? "1 dia" : `${daysUntilExpiration} dias`;
  return {
    subject: `[papyrus] Vencimento próximo: ${doc.title}`,
    textBody: `O documento "${doc.title}" vencerá em ${formattedDate} (em ${daysText}). Acesse o papyrus para tomar as ações necessárias.`,
  };
}

/**
 * Evaluates upcoming and overdue document expirations per organization timezone,
 * emitting idempotent internal notifications and optional SMTP email dispatches
 * without duplicating alerts across job retries or calendar day progressions.
 */
export function createExpirationNotificationsHandler(
  deps: ExpirationNotificationsDependencies,
): ExpirationNotificationsHandler {
  const thresholds = normalizeThresholds(deps.alertThresholdsDays);
  const maxThresholdDays = thresholds[thresholds.length - 1] ?? 30;
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
  const nowFn = deps.now ?? (() => new Date());
  const auditWriter = createAuditWriter({ repository: deps.audit });

  const dispatchForDocument = async (
    doc: ExpiringDocumentCandidate,
    todayLocalDate: string,
    orgTimezone: string,
  ): Promise<{
    readonly created: number;
    readonly deduplicated: number;
    readonly emailsQueued: number;
    readonly emailsSkippedDisabled: number;
    readonly noEligibleRecipients: boolean;
  }> => {
    const daysUntil = diffCalendarDays(doc.expirationDate, todayLocalDate);
    const window = resolveExpirationAlertWindow(daysUntil, thresholds);
    if (!window) {
      return {
        created: 0,
        deduplicated: 0,
        emailsQueued: 0,
        emailsSkippedDisabled: 0,
        noEligibleRecipients: false,
      };
    }

    const recipients = await deps.store.listAuthorizedRecipientsForDocument({
      organizationId: doc.organizationId,
      documentId: doc.id,
      ownerUserId: doc.ownerUserId,
    });
    if (recipients.length === 0) {
      return {
        created: 0,
        deduplicated: 0,
        emailsQueued: 0,
        emailsSkippedDisabled: 0,
        noEligibleRecipients: true,
      };
    }

    const newlyCreatedRecipients: Array<{
      readonly recipient: ExpirationAlertRecipient;
      readonly notificationId: string;
    }> = [];
    let created = 0;
    let deduplicated = 0;

    await deps.transactions.runInTransaction(async (tx: TransactionContext) => {
      for (const recipient of recipients) {
        const dispatch = await deps.inAppNotifications.notifyDocumentExpiration({
          organizationId: doc.organizationId,
          recipientUserIds: [recipient.userId],
          documentId: doc.id,
          documentTitle: doc.title,
          expirationDate: doc.expirationDate,
          alertWindowKey: window.alertWindowKey,
          isExpired: window.isExpired,
          tx,
        });

        created += dispatch.createdCount;
        deduplicated += dispatch.deduplicatedCount;

        if (dispatch.createdCount > 0 && dispatch.notifications[0]) {
          newlyCreatedRecipients.push({
            recipient,
            notificationId: dispatch.notifications[0].id,
          });
        }
      }

      if (created > 0) {
        await auditWriter.write(
          {
            organizationId: doc.organizationId,
            actorUserId: null,
            action: "EXPIRATION_ALERT_SCHEDULED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: deps.generateId(),
            metadata: {
              expirationDate: doc.expirationDate,
              alertWindowKey: window.alertWindowKey,
              isExpired: window.isExpired,
              timezone: orgTimezone,
              createdCount: created,
            },
          },
          tx,
        );
      }
    });

    let emailsQueued = 0;
    let emailsSkippedDisabled = 0;

    if (deps.emailService && newlyCreatedRecipients.length > 0) {
      const emailContent = buildEmailSubjectAndBody(doc, daysUntil, window.isExpired);
      for (const item of newlyCreatedRecipients) {
        const outcome = await deps.emailService.enqueueNotificationEmail({
          organizationId: doc.organizationId,
          recipientEmail: item.recipient.email,
          subject: emailContent.subject,
          textBody: emailContent.textBody,
          notificationId: item.notificationId,
          idempotencyKey: `email:document-expiration:${doc.id}:${doc.expirationDate}:${window.alertWindowKey}:${item.recipient.userId}`,
        });
        if (outcome.enqueued) {
          emailsQueued += 1;
        } else {
          emailsSkippedDisabled += 1;
        }
      }
    }

    return {
      created,
      deduplicated,
      emailsQueued,
      emailsSkippedDisabled,
      noEligibleRecipients: false,
    };
  };

  return {
    async runExpirationNotificationsCycle(): Promise<ExpirationNotificationsReport> {
      const referenceNow = nowFn();
      const organizations = await deps.store.listOrganizations();

      let documentsScanned = 0;
      let notificationsCreated = 0;
      let notificationsDeduplicated = 0;
      let emailsQueued = 0;
      let emailsSkippedDisabled = 0;
      let unauthorizedRecipientsSkipped = 0;
      const failures: ExpirationAlertFailureRecord[] = [];

      for (const org of organizations) {
        const todayLocalDate = resolveLocalCalendarDate(referenceNow, org.timezone);
        const expiresOnOrBeforeDate = addCalendarDays(todayLocalDate, maxThresholdDays);

        const candidates = await deps.store.listExpiringDocuments({
          organizationId: org.id,
          expiresOnOrBeforeDate,
          limit: batchSize,
        });

        for (const doc of candidates) {
          if (
            doc.organizationId !== org.id ||
            !ELIGIBLE_EXPIRATION_DOCUMENT_STATUSES.has(doc.status)
          ) {
            continue;
          }

          documentsScanned += 1;
          try {
            const outcome = await dispatchForDocument(doc, todayLocalDate, org.timezone);
            notificationsCreated += outcome.created;
            notificationsDeduplicated += outcome.deduplicated;
            emailsQueued += outcome.emailsQueued;
            emailsSkippedDisabled += outcome.emailsSkippedDisabled;
            if (outcome.noEligibleRecipients) {
              unauthorizedRecipientsSkipped += 1;
            }
          } catch (error) {
            failures.push({
              organizationId: org.id,
              documentId: doc.id,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return {
        organizationsEvaluated: organizations.length,
        documentsScanned,
        notificationsCreated,
        notificationsDeduplicated,
        emailsQueued,
        emailsSkippedDisabled,
        unauthorizedRecipientsSkipped,
        failures,
      };
    },
  };
}
