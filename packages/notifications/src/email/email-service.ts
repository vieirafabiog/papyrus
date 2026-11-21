import { randomUUID } from "node:crypto";
import { createNodeSmtpTransport } from "./smtp-transport.js";
import { type SmtpSecretVault, sanitizeSmtpErrorMessage } from "./smtp-vault.js";
import type {
  EmailDeliveryLogPort,
  EmailMessageInput,
  EmailOutboxPort,
  EnqueueEmailOutcome,
  OptionalSmtpEmailService,
  ProcessQueuedEmailOutcome,
  SafeSmtpConfigView,
  SaveSmtpConfigCommand,
  SmtpAdminConfigRecord,
  SmtpConfigRepositoryPort,
  SmtpTransportPort,
  TestSmtpConnectionOutcome,
} from "./types.js";

const CRLF_PATTERN = /[\r\n\0]/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OptionalSmtpEmailServiceDependencies {
  readonly configs: SmtpConfigRepositoryPort;
  readonly outbox: EmailOutboxPort;
  readonly deliveryLog: EmailDeliveryLogPort;
  readonly vault: SmtpSecretVault;
  readonly transport?: SmtpTransportPort | undefined;
  readonly generateId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
}

export class SmtpConfigValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SmtpConfigValidationError";
  }
}

function assertCleanNonEmpty(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength || CRLF_PATTERN.test(trimmed)) {
    throw new SmtpConfigValidationError(`Campo '${label}' inválido para envio SMTP.`);
  }
  return trimmed;
}

function assertValidEmail(email: string, label: string): string {
  const clean = assertCleanNonEmpty(email, label, 320);
  if (!EMAIL_PATTERN.test(clean)) {
    throw new SmtpConfigValidationError(`Endereço de e-mail '${label}' inválido.`);
  }
  return clean;
}

function toSafeSmtpConfigView(record: SmtpAdminConfigRecord): SafeSmtpConfigView {
  return {
    organizationId: record.organizationId,
    enabled: record.enabled,
    host: record.host,
    port: record.port,
    securityMode: record.securityMode,
    fromAddress: record.fromAddress,
    fromName: record.fromName,
    authConfigured: record.encryptedCredentialsRef !== null,
    timeoutMs: record.timeoutMs,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Creates the optional administrator-configured SMTP email service.
 * Credentials stay encrypted at rest via `SmtpSecretVault`, never enter logs or
 * API views, and emails are queued asynchronously via the outbox port.
 */
export function createOptionalSmtpEmailService(
  deps: OptionalSmtpEmailServiceDependencies,
): OptionalSmtpEmailService {
  const transport = deps.transport ?? createNodeSmtpTransport();
  const generateId = deps.generateId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());

  return {
    async getOrganizationSmtpConfig(organizationId: string): Promise<SafeSmtpConfigView | null> {
      const record = await deps.configs.findByOrganizationId(organizationId);
      return record ? toSafeSmtpConfigView(record) : null;
    },

    async saveOrganizationSmtpConfig(command: SaveSmtpConfigCommand): Promise<SafeSmtpConfigView> {
      const host = assertCleanNonEmpty(command.host, "host", 255);
      if (!Number.isInteger(command.port) || command.port < 1 || command.port > 65535) {
        throw new SmtpConfigValidationError("Porta SMTP deve estar entre 1 e 65535.");
      }

      const fromAddress = assertValidEmail(command.fromAddress, "fromAddress");
      const fromName =
        command.fromName && command.fromName.trim().length > 0
          ? assertCleanNonEmpty(command.fromName, "fromName", 120)
          : null;

      const timeoutMs = command.timeoutMs ?? 10_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) {
        throw new SmtpConfigValidationError("Timeout SMTP deve estar entre 500 ms e 60000 ms.");
      }

      const existing = await deps.configs.findByOrganizationId(command.organizationId);
      let encryptedCredentialsRef: string | null = existing?.encryptedCredentialsRef ?? null;

      if (command.clearCredentials) {
        encryptedCredentialsRef = null;
      } else if (command.credentials) {
        encryptedCredentialsRef = deps.vault.encryptCredentials(command.credentials);
      }

      const saved = await deps.configs.upsert({
        organizationId: command.organizationId,
        enabled: command.enabled,
        host,
        port: command.port,
        securityMode: command.securityMode,
        fromAddress,
        fromName,
        encryptedCredentialsRef,
        timeoutMs,
        updatedByUserId: command.actorUserId,
        updatedAt: now(),
      });

      return toSafeSmtpConfigView(saved);
    },

    async testOrganizationSmtpConnection(
      organizationId: string,
    ): Promise<TestSmtpConnectionOutcome> {
      const config = await deps.configs.findByOrganizationId(organizationId);
      if (!config) {
        return {
          configured: false,
          enabled: false,
          healthy: false,
          message: "SMTP não configurado para esta organização.",
        };
      }

      let credentials = null;
      if (config.encryptedCredentialsRef) {
        credentials = deps.vault.decryptCredentials(config.encryptedCredentialsRef);
      }

      const verification = await transport.verifyConnection({
        host: config.host,
        port: config.port,
        securityMode: config.securityMode,
        timeoutMs: config.timeoutMs,
        credentials,
      });

      return {
        configured: true,
        enabled: config.enabled,
        healthy: verification.ok,
        message: verification.message,
      };
    },

    async enqueueNotificationEmail(message: EmailMessageInput): Promise<EnqueueEmailOutcome> {
      const config = await deps.configs.findByOrganizationId(message.organizationId);
      if (!config || !config.enabled) {
        return { status: "SKIPPED_DISABLED", enqueued: false };
      }

      const recipientEmail = assertValidEmail(message.recipientEmail, "recipientEmail");
      const subject = assertCleanNonEmpty(message.subject, "subject", 200);
      const idempotencyKey = assertCleanNonEmpty(message.idempotencyKey, "idempotencyKey", 255);
      const jobId = generateId();

      // Outbox payload intentionally omits any SMTP password or vault reference.
      await deps.outbox.enqueue({
        id: jobId,
        organizationId: message.organizationId,
        eventType: "EMAIL_NOTIFICATION_DISPATCH",
        aggregateType: "NOTIFICATION",
        aggregateId: message.notificationId ?? jobId,
        payload: {
          organizationId: message.organizationId,
          recipientEmail,
          subject,
          textBody: message.textBody,
          htmlBody: message.htmlBody ?? null,
          notificationId: message.notificationId ?? null,
          idempotencyKey,
          enqueuedAt: now().toISOString(),
        },
      });

      return { status: "QUEUED", enqueued: true, jobId };
    },

    async processQueuedEmailJob(payload): Promise<ProcessQueuedEmailOutcome> {
      const alreadySent = await deps.deliveryLog.hasDelivered(
        payload.organizationId,
        payload.idempotencyKey,
      );
      if (alreadySent) {
        return { status: "DEDUPLICATED" };
      }

      const config = await deps.configs.findByOrganizationId(payload.organizationId);
      if (!config || !config.enabled) {
        return { status: "SKIPPED_DISABLED" };
      }

      const credentials = config.encryptedCredentialsRef
        ? deps.vault.decryptCredentials(config.encryptedCredentialsRef)
        : null;

      try {
        const sendResult = await transport.sendMail({
          host: config.host,
          port: config.port,
          securityMode: config.securityMode,
          timeoutMs: config.timeoutMs,
          credentials,
          fromAddress: config.fromAddress,
          fromName: config.fromName,
          toAddress: payload.recipientEmail,
          subject: payload.subject,
          textBody: payload.textBody,
          htmlBody: payload.htmlBody,
        });

        await deps.deliveryLog.markDelivered({
          organizationId: payload.organizationId,
          idempotencyKey: payload.idempotencyKey,
          messageId: sendResult.messageId,
          deliveredAt: now(),
        });

        return { status: "SENT", messageId: sendResult.messageId };
      } catch (error) {
        const sanitized = sanitizeSmtpErrorMessage(
          error instanceof Error ? error.message : String(error),
          [credentials?.password, config.encryptedCredentialsRef ?? undefined],
        );
        throw new Error(sanitized);
      }
    },
  };
}
