export {
  SmtpConfigValidationError,
  createOptionalSmtpEmailService,
  type OptionalSmtpEmailServiceDependencies,
} from "./email-service.js";
export { SmtpTransportError, createNodeSmtpTransport } from "./smtp-transport.js";
export {
  type SmtpCredentials,
  type SmtpMasterKeyInput,
  type SmtpSecretVault,
  SmtpSecretVaultError,
  type SmtpSecretVaultOptions,
  createSmtpSecretVault,
  isValidSmtpSecretEnvelope,
  sanitizeSmtpErrorMessage,
} from "./smtp-vault.js";
export type {
  EmailDeliveryLogPort,
  EmailMessageInput,
  EmailOutboxEnqueueInput,
  EmailOutboxPort,
  EnqueueEmailOutcome,
  OptionalSmtpEmailService,
  ProcessQueuedEmailOutcome,
  QueuedEmailPayload,
  SafeSmtpConfigView,
  SaveSmtpConfigCommand,
  SmtpAdminConfigRecord,
  SmtpConfigRepositoryPort,
  SmtpSecurityMode,
  SmtpSendRequest,
  SmtpSendResult,
  SmtpTransportPort,
  TestSmtpConnectionOutcome,
} from "./types.js";
