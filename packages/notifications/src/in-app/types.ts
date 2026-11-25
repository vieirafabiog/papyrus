export type InAppNotificationEventKind =
  | "TASK_ASSIGNED"
  | "WORKFLOW_DECISION"
  | "DOCUMENT_EXPIRATION"
  | "COMMENT_MENTION";

export type InAppNotificationResourceType = "WORKFLOW_TASK" | "DOCUMENT" | "WORKFLOW_INSTANCE";

export type NotificationDecisionKind = "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "CANCEL";

export interface InAppNotificationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly recipientUserId: string;
  readonly channel: "INTERNAL";
  readonly kind: InAppNotificationEventKind;
  readonly idempotencyKey: string | null;
  readonly title: string;
  readonly body: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly readAt: Date | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateInAppNotificationRecordInput {
  readonly id: string;
  readonly organizationId: string;
  readonly recipientUserId: string;
  readonly kind: InAppNotificationEventKind;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly body: string;
  readonly resourceType: InAppNotificationResourceType | null;
  readonly resourceId: string | null;
  readonly sentAt: Date;
}

export interface InsertIdempotentInAppNotificationResult {
  readonly notification: InAppNotificationRecord;
  readonly created: boolean;
}

export interface ListInAppNotificationsQuery {
  readonly organizationId: string;
  readonly recipientUserId: string;
  readonly unreadOnly?: boolean | undefined;
  readonly kind?: InAppNotificationEventKind | undefined;
  readonly page: number;
  readonly pageSize: number;
}

export interface ListInAppNotificationsResult {
  readonly items: readonly InAppNotificationRecord[];
  readonly unreadCount: number;
  readonly totalItems: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export type MarkInAppNotificationReadOutcome =
  | {
      readonly status: "UPDATED";
      readonly notification: InAppNotificationRecord;
      readonly alreadyRead: boolean;
    }
  | { readonly status: "FORBIDDEN" }
  | { readonly status: "NOT_FOUND" };

export interface InAppNotificationRepositoryPort {
  insertIdempotent(
    input: CreateInAppNotificationRecordInput,
    tx?: unknown,
  ): Promise<InsertIdempotentInAppNotificationResult>;
  listForRecipient(query: ListInAppNotificationsQuery): Promise<ListInAppNotificationsResult>;
  markReadById(input: {
    readonly organizationId: string;
    readonly notificationId: string;
    readonly recipientUserId: string;
    readonly readAt: Date;
  }): Promise<MarkInAppNotificationReadOutcome>;
}

export interface NotifyTaskAssignedInput {
  readonly organizationId: string;
  readonly recipientUserIds: readonly string[];
  readonly taskId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly workflowName: string;
  readonly stepOrder: number;
  readonly stepName: string;
  readonly dueAt?: Date | null | undefined;
  readonly tx?: unknown;
}

export interface NotifyTaskDecisionInput {
  readonly organizationId: string;
  readonly recipientUserIds: readonly string[];
  readonly decisionId?: string | null | undefined;
  readonly taskId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly decision: NotificationDecisionKind;
  readonly actorDisplayName: string;
  readonly stepName: string;
  readonly tx?: unknown;
}

export interface NotifyDocumentExpirationInput {
  readonly organizationId: string;
  readonly recipientUserIds: readonly string[];
  readonly documentId: string;
  readonly documentTitle: string;
  readonly expirationDate: string;
  readonly alertWindowKey: string;
  readonly isExpired: boolean;
  readonly tx?: unknown;
}

export interface NotifyCommentMentionInput {
  readonly organizationId: string;
  readonly recipientUserIds: readonly string[];
  readonly authorUserId: string;
  readonly authorDisplayName: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly commentId: string;
  readonly commentExcerpt: string;
  readonly tx?: unknown;
}

export interface InAppNotificationDispatchSummary {
  readonly createdCount: number;
  readonly deduplicatedCount: number;
  readonly notifications: readonly InAppNotificationRecord[];
}

export interface InAppNotificationService {
  notifyTaskAssigned(input: NotifyTaskAssignedInput): Promise<InAppNotificationDispatchSummary>;
  notifyTaskDecision(input: NotifyTaskDecisionInput): Promise<InAppNotificationDispatchSummary>;
  notifyDocumentExpiration(
    input: NotifyDocumentExpirationInput,
  ): Promise<InAppNotificationDispatchSummary>;
  notifyCommentMention(input: NotifyCommentMentionInput): Promise<InAppNotificationDispatchSummary>;
  listForUser(query: ListInAppNotificationsQuery): Promise<ListInAppNotificationsResult>;
  markAsRead(input: {
    readonly organizationId: string;
    readonly notificationId: string;
    readonly recipientUserId: string;
  }): Promise<MarkInAppNotificationReadOutcome>;
}
