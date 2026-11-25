import { randomUUID } from "node:crypto";
import type {
  InAppNotificationDispatchSummary,
  InAppNotificationRecord,
  InAppNotificationRepositoryPort,
  InAppNotificationService,
  ListInAppNotificationsQuery,
  ListInAppNotificationsResult,
  MarkInAppNotificationReadOutcome,
  NotificationDecisionKind,
  NotifyCommentMentionInput,
  NotifyDocumentExpirationInput,
  NotifyTaskAssignedInput,
  NotifyTaskDecisionInput,
} from "./types.js";

export interface InAppNotificationServiceDependencies {
  readonly repository: InAppNotificationRepositoryPort;
  readonly generateId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
}

const MAX_TITLE_LENGTH = 200;

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function dedupeRecipientIds(recipientUserIds: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const id of recipientUserIds) {
    const trimmed = id.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }
  return Array.from(unique);
}

function formatIsoDatePtBr(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) {
    return isoDate;
  }
  const [year, month, day] = parts;
  if (!year || !month || !day) {
    return isoDate;
  }
  return `${day}/${month}/${year}`;
}

function formatDatePtBr(date: Date): string {
  return date.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

function formatDecisionVerb(decision: NotificationDecisionKind): {
  readonly titlePrefix: string;
  readonly actionText: string;
} {
  switch (decision) {
    case "APPROVE":
      return { titlePrefix: "Documento aprovado em etapa", actionText: "aprovou" };
    case "REJECT":
      return { titlePrefix: "Documento rejeitado em revisão", actionText: "rejeitou" };
    case "REQUEST_CHANGES":
      return {
        titlePrefix: "Ajustes solicitados em documento",
        actionText: "solicitou ajustes na etapa de revisão de",
      };
    case "CANCEL":
      return { titlePrefix: "Tarefa de revisão cancelada", actionText: "cancelou a tarefa de" };
  }
}

/**
 * Builds the internal in-app notification service covering task assignments,
 * workflow decisions, document expirations, per-user read state, and idempotency.
 */
export function createInAppNotificationService(
  deps: InAppNotificationServiceDependencies,
): InAppNotificationService {
  const generateId = deps.generateId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());

  return {
    async notifyTaskAssigned(
      input: NotifyTaskAssignedInput,
    ): Promise<InAppNotificationDispatchSummary> {
      const recipients = dedupeRecipientIds(input.recipientUserIds);
      const notifications: InAppNotificationRecord[] = [];
      let createdCount = 0;
      let deduplicatedCount = 0;

      const title = truncateText(
        `Nova tarefa: ${input.stepName} — ${input.documentTitle}`,
        MAX_TITLE_LENGTH,
      );
      const dueSuffix = input.dueAt ? ` Prazo até ${formatDatePtBr(input.dueAt)}.` : "";
      const body = `A etapa ${input.stepOrder} (${input.stepName}) do fluxo "${input.workflowName}" foi atribuída para você no documento "${input.documentTitle}".${dueSuffix}`;

      for (const recipientUserId of recipients) {
        const result = await deps.repository.insertIdempotent(
          {
            id: generateId(),
            organizationId: input.organizationId,
            recipientUserId,
            kind: "TASK_ASSIGNED",
            idempotencyKey: `task-assigned:${input.taskId}:${recipientUserId}`,
            title,
            body,
            resourceType: "WORKFLOW_TASK",
            resourceId: input.taskId,
            sentAt: now(),
          },
          input.tx,
        );

        notifications.push(result.notification);
        if (result.created) {
          createdCount += 1;
        } else {
          deduplicatedCount += 1;
        }
      }

      return { createdCount, deduplicatedCount, notifications };
    },

    async notifyTaskDecision(
      input: NotifyTaskDecisionInput,
    ): Promise<InAppNotificationDispatchSummary> {
      const recipients = dedupeRecipientIds(input.recipientUserIds);
      const notifications: InAppNotificationRecord[] = [];
      let createdCount = 0;
      let deduplicatedCount = 0;

      const descriptor = formatDecisionVerb(input.decision);
      const title = truncateText(
        `${descriptor.titlePrefix}: ${input.documentTitle}`,
        MAX_TITLE_LENGTH,
      );
      const body = `${input.actorDisplayName} ${descriptor.actionText} "${input.documentTitle}" na etapa "${input.stepName}".`;
      const keyPrefix = input.decisionId
        ? `workflow-decision:${input.decisionId}`
        : `workflow-decision:${input.decision.toLowerCase()}:${input.taskId}`;

      for (const recipientUserId of recipients) {
        const result = await deps.repository.insertIdempotent(
          {
            id: generateId(),
            organizationId: input.organizationId,
            recipientUserId,
            kind: "WORKFLOW_DECISION",
            idempotencyKey: `${keyPrefix}:${recipientUserId}`,
            title,
            body,
            resourceType: "DOCUMENT",
            resourceId: input.documentId,
            sentAt: now(),
          },
          input.tx,
        );

        notifications.push(result.notification);
        if (result.created) {
          createdCount += 1;
        } else {
          deduplicatedCount += 1;
        }
      }

      return { createdCount, deduplicatedCount, notifications };
    },

    async notifyDocumentExpiration(
      input: NotifyDocumentExpirationInput,
    ): Promise<InAppNotificationDispatchSummary> {
      const recipients = dedupeRecipientIds(input.recipientUserIds);
      const notifications: InAppNotificationRecord[] = [];
      let createdCount = 0;
      let deduplicatedCount = 0;

      const formattedDate = formatIsoDatePtBr(input.expirationDate);
      const title = truncateText(
        input.isExpired
          ? `Documento vencido: ${input.documentTitle}`
          : `Vencimento próximo: ${input.documentTitle}`,
        MAX_TITLE_LENGTH,
      );
      const body = input.isExpired
        ? `O documento "${input.documentTitle}" atingiu o vencimento em ${formattedDate}.`
        : `O documento "${input.documentTitle}" vencerá em ${formattedDate}.`;

      for (const recipientUserId of recipients) {
        const result = await deps.repository.insertIdempotent(
          {
            id: generateId(),
            organizationId: input.organizationId,
            recipientUserId,
            kind: "DOCUMENT_EXPIRATION",
            idempotencyKey: `document-expiration:${input.documentId}:${input.expirationDate}:${input.alertWindowKey}:${recipientUserId}`,
            title,
            body,
            resourceType: "DOCUMENT",
            resourceId: input.documentId,
            sentAt: now(),
          },
          input.tx,
        );

        notifications.push(result.notification);
        if (result.created) {
          createdCount += 1;
        } else {
          deduplicatedCount += 1;
        }
      }

      return { createdCount, deduplicatedCount, notifications };
    },

    async notifyCommentMention(
      input: NotifyCommentMentionInput,
    ): Promise<InAppNotificationDispatchSummary> {
      const recipients = dedupeRecipientIds(input.recipientUserIds).filter(
        (id) => id !== input.authorUserId,
      );
      const notifications: InAppNotificationRecord[] = [];
      let createdCount = 0;
      let deduplicatedCount = 0;

      const title = truncateText(
        `${input.authorDisplayName} mencionou você em "${input.documentTitle}"`,
        MAX_TITLE_LENGTH,
      );
      const excerpt = truncateText(input.commentExcerpt, 180);
      const body =
        excerpt.length > 0
          ? `${input.authorDisplayName} comentou em "${input.documentTitle}": "${excerpt}"`
          : `${input.authorDisplayName} mencionou você em um comentário do documento "${input.documentTitle}".`;

      for (const recipientUserId of recipients) {
        const result = await deps.repository.insertIdempotent(
          {
            id: generateId(),
            organizationId: input.organizationId,
            recipientUserId,
            kind: "COMMENT_MENTION",
            idempotencyKey: `comment-mention:${input.commentId}:${recipientUserId}`,
            title,
            body,
            resourceType: "DOCUMENT",
            resourceId: input.documentId,
            sentAt: now(),
          },
          input.tx,
        );

        notifications.push(result.notification);
        if (result.created) {
          createdCount += 1;
        } else {
          deduplicatedCount += 1;
        }
      }

      return { createdCount, deduplicatedCount, notifications };
    },

    async listForUser(query: ListInAppNotificationsQuery): Promise<ListInAppNotificationsResult> {
      return deps.repository.listForRecipient(query);
    },

    async markAsRead(input: {
      readonly organizationId: string;
      readonly notificationId: string;
      readonly recipientUserId: string;
    }): Promise<MarkInAppNotificationReadOutcome> {
      return deps.repository.markReadById({
        organizationId: input.organizationId,
        notificationId: input.notificationId,
        recipientUserId: input.recipientUserId,
        readAt: now(),
      });
    },
  };
}
