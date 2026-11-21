import type { SmtpCredentials } from "./smtp-vault.js";

export type SmtpSecurityMode = "NONE" | "STARTTLS" | "TLS";

export interface SmtpAdminConfigRecord {
  readonly organizationId: string;
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly securityMode: SmtpSecurityMode;
  readonly fromAddress: string;
  readonly fromName: string | null;
  readonly encryptedCredentialsRef: string | null;
  readonly timeoutMs: number;
  readonly updatedByUserId: string;
  readonly updatedAt: Date;
}

export interface SafeSmtpConfigView {
  readonly organizationId: string;
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly securityMode: SmtpSecurityMode;
  readonly fromAddress: string;
  readonly fromName: string | null;
  readonly authConfigured: boolean;
  readonly timeoutMs: number;
  readonly updatedAt: string;
}

export interface SaveSmtpConfigCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly securityMode: SmtpSecurityMode;
  readonly fromAddress: string;
  readonly fromName?: string | null | undefined;
  readonly credentials?: SmtpCredentials | null | undefined;
  readonly clearCredentials?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface SmtpConfigRepositoryPort {
  findByOrganizationId(organizationId: string): Promise<SmtpAdminConfigRecord | null>;
  upsert(record: SmtpAdminConfigRecord): Promise<SmtpAdminConfigRecord>;
}

export interface EmailMessageInput {
  readonly organizationId: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string | undefined;
  readonly notificationId?: string | undefined;
  readonly idempotencyKey: string;
}

export interface QueuedEmailPayload {
  readonly organizationId: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string | null;
  readonly notificationId: string | null;
  readonly idempotencyKey: string;
  readonly enqueuedAt: string;
}

export interface EmailOutboxEnqueueInput {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: "EMAIL_NOTIFICATION_DISPATCH";
  readonly aggregateType: "NOTIFICATION";
  readonly aggregateId: string;
  readonly payload: QueuedEmailPayload;
}

export interface EmailOutboxPort {
  enqueue(input: EmailOutboxEnqueueInput): Promise<void>;
}

export interface EmailDeliveryLogPort {
  hasDelivered(organizationId: string, idempotencyKey: string): Promise<boolean>;
  markDelivered(input: {
    readonly organizationId: string;
    readonly idempotencyKey: string;
    readonly messageId: string | null;
    readonly deliveredAt: Date;
  }): Promise<void>;
}

export interface SmtpSendRequest {
  readonly host: string;
  readonly port: number;
  readonly securityMode: SmtpSecurityMode;
  readonly timeoutMs: number;
  readonly credentials: SmtpCredentials | null;
  readonly fromAddress: string;
  readonly fromName: string | null;
  readonly toAddress: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string | null;
}

export interface SmtpSendResult {
  readonly messageId: string | null;
}

export interface SmtpTransportPort {
  sendMail(request: SmtpSendRequest): Promise<SmtpSendResult>;
  verifyConnection(config: {
    readonly host: string;
    readonly port: number;
    readonly securityMode: SmtpSecurityMode;
    readonly timeoutMs: number;
    readonly credentials: SmtpCredentials | null;
  }): Promise<{ readonly ok: boolean; readonly message: string }>;
}

export type EnqueueEmailOutcome =
  | { readonly status: "QUEUED"; readonly enqueued: true; readonly jobId: string }
  | { readonly status: "SKIPPED_DISABLED"; readonly enqueued: false };

export type ProcessQueuedEmailOutcome =
  | { readonly status: "SENT"; readonly messageId: string | null }
  | { readonly status: "DEDUPLICATED" }
  | { readonly status: "SKIPPED_DISABLED" };

export interface TestSmtpConnectionOutcome {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly healthy: boolean;
  readonly message: string;
}

export interface OptionalSmtpEmailService {
  getOrganizationSmtpConfig(organizationId: string): Promise<SafeSmtpConfigView | null>;
  saveOrganizationSmtpConfig(command: SaveSmtpConfigCommand): Promise<SafeSmtpConfigView>;
  testOrganizationSmtpConnection(organizationId: string): Promise<TestSmtpConnectionOutcome>;
  enqueueNotificationEmail(message: EmailMessageInput): Promise<EnqueueEmailOutcome>;
  processQueuedEmailJob(payload: QueuedEmailPayload): Promise<ProcessQueuedEmailOutcome>;
}
