export type NotificationChannel = "internal" | "email";

export {
  type CreateInAppNotificationRecordInput,
  createInAppNotificationService,
  type InAppNotificationDispatchSummary,
  type InAppNotificationEventKind,
  type InAppNotificationRecord,
  type InAppNotificationRepositoryPort,
  type InAppNotificationResourceType,
  type InAppNotificationService,
  type InAppNotificationServiceDependencies,
  type InsertIdempotentInAppNotificationResult,
  type ListInAppNotificationsQuery,
  type ListInAppNotificationsResult,
  type MarkInAppNotificationReadOutcome,
  type NotificationDecisionKind,
  type NotifyDocumentExpirationInput,
  type NotifyTaskAssignedInput,
  type NotifyTaskDecisionInput,
} from "./in-app/index.js";
