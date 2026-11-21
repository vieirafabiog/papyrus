import { DomainError } from "../index.js";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditMetadataValue,
  AuditRepositoryPort,
  AuditResult,
} from "../ports/audit-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";

export const MAX_AUDIT_ACTION_LENGTH = 120;
export const MAX_AUDIT_RESOURCE_TYPE_LENGTH = 64;
export const MAX_AUDIT_IP_LENGTH = 64;
export const MAX_AUDIT_METADATA_KEYS = 20;
export const MAX_AUDIT_METADATA_STRING_LENGTH = 256;

const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "signedurl",
  "presigned",
  "downloadurl",
  "uploadurl",
  "authorization",
  "cookie",
  "csrf",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "masterkey",
  "credentials",
  "encrypted",
  "binary",
  "filecontent",
  "rawpayload",
  "fullpayload",
  "documentbody",
  "base64",
] as const;

const REDACTED_MARKER = "[REDACTED]";

export interface WriteAuditEventInput {
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly result: AuditResult;
  readonly requestId: string;
  readonly ipAddress?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditWriter {
  write(event: WriteAuditEventInput, tx?: TransactionContext): Promise<AuditEventRecord>;
  writeAtomic(event: WriteAuditEventInput): Promise<AuditEventRecord>;
}

export interface AuditWriterDependencies {
  readonly repository: AuditRepositoryPort;
  readonly transactions?: TransactionManagerPort | undefined;
}

function isSensitiveMetadataKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isBinaryLikeValue(value: unknown): boolean {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return true;
  }
  return ArrayBuffer.isView(value);
}

/**
 * Redacts credentials, tokens, signed URLs, and encrypted vault strings inside text
 * and truncates excessive values to keep audit metadata compact and safe.
 */
export function redactSensitiveAuditString(rawValue: string): string {
  let sanitized = rawValue.trim();

  sanitized = sanitized.replace(/dfvault:v\d+:[^\s"']+/gi, "[REDACTED_VAULT]");
  sanitized = sanitized.replace(/dfsmtp:v\d+:[^\s"']+/gi, "[REDACTED_VAULT]");
  sanitized = sanitized.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");
  sanitized = sanitized.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[REDACTED]@");
  sanitized = sanitized.replace(
    /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|token|signature|sig|auth|key)=)[^&\s]+/gi,
    "$1[REDACTED]",
  );
  sanitized = sanitized.replace(
    /\b(password|pass|secret|token|apiKey|accessKeyId|secretAccessKey)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );

  if (sanitized.length > MAX_AUDIT_METADATA_STRING_LENGTH) {
    return `${sanitized.slice(0, MAX_AUDIT_METADATA_STRING_LENGTH - 1).trimEnd()}…`;
  }
  return sanitized;
}

function coercePrimitiveAuditValue(rawValue: unknown): AuditMetadataValue {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  if (typeof rawValue === "number") {
    return Number.isFinite(rawValue) ? rawValue : null;
  }
  if (typeof rawValue === "string") {
    return redactSensitiveAuditString(rawValue);
  }
  if (rawValue instanceof Date) {
    return Number.isNaN(rawValue.getTime()) ? null : rawValue.toISOString();
  }
  if (isBinaryLikeValue(rawValue)) {
    return "[REDACTED_BINARY]";
  }
  if (Array.isArray(rawValue)) {
    const joined = rawValue
      .slice(0, 10)
      .map((item) =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
          ? redactSensitiveAuditString(String(item))
          : REDACTED_MARKER,
      )
      .join(", ");
    return redactSensitiveAuditString(
      rawValue.length > 10 ? `${joined} (+${rawValue.length - 10})` : joined,
    );
  }
  return "[REDACTED_OBJECT]";
}

/**
 * Produces a minimal, redacted metadata dictionary bounded in key count and value size.
 */
export function sanitizeAuditMetadata(
  rawMetadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, AuditMetadataValue>> {
  if (!rawMetadata) {
    return {};
  }

  const sanitized: Record<string, AuditMetadataValue> = {};
  let acceptedCount = 0;
  let truncated = false;

  for (const [rawKey, rawValue] of Object.entries(rawMetadata)) {
    const cleanKey = rawKey.trim().slice(0, 64);
    if (cleanKey.length === 0 || rawValue === undefined) {
      continue;
    }

    if (acceptedCount >= MAX_AUDIT_METADATA_KEYS) {
      truncated = true;
      break;
    }

    if (isSensitiveMetadataKey(cleanKey)) {
      sanitized[cleanKey] = REDACTED_MARKER;
      acceptedCount += 1;
      continue;
    }

    sanitized[cleanKey] = coercePrimitiveAuditValue(rawValue);
    acceptedCount += 1;
  }

  if (truncated) {
    sanitized._metadataTruncated = true;
  }

  return sanitized;
}

function assertNonEmptyField(value: string, fieldName: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DomainError(
      "AUDIT_INVALID_EVENT",
      `Campo obrigatório de auditoria '${fieldName}' não pode estar vazio.`,
    );
  }
  return trimmed.slice(0, maxLength);
}

/**
 * Validates and minimizes an audit event input before append-only persistence.
 */
export function buildMinimalAuditEvent(input: WriteAuditEventInput): AuditEventInput {
  const organizationId = assertNonEmptyField(input.organizationId, "organizationId", 64);
  const action = assertNonEmptyField(input.action, "action", MAX_AUDIT_ACTION_LENGTH);
  const resourceType = assertNonEmptyField(
    input.resourceType,
    "resourceType",
    MAX_AUDIT_RESOURCE_TYPE_LENGTH,
  );
  const requestId = assertNonEmptyField(input.requestId, "requestId", 64);

  const actorUserId =
    input.actorUserId && input.actorUserId.trim().length > 0 ? input.actorUserId.trim() : null;
  const resourceId =
    input.resourceId && input.resourceId.trim().length > 0 ? input.resourceId.trim() : null;

  const cleanIp =
    input.ipAddress !== undefined && input.ipAddress !== null && input.ipAddress.trim().length > 0
      ? input.ipAddress.trim().slice(0, MAX_AUDIT_IP_LENGTH)
      : input.ipAddress === null
        ? null
        : undefined;

  return {
    organizationId,
    actorUserId,
    action,
    resourceType,
    resourceId,
    result: input.result,
    requestId,
    ...(cleanIp !== undefined ? { ipAddress: cleanIp } : {}),
    metadata: sanitizeAuditMetadata(input.metadata),
  };
}

/**
 * Central append-only audit writer enforcing minimal event fields, secret/excess-data
 * redaction, and transactional execution inside business operations.
 */
export function createAuditWriter(deps: AuditWriterDependencies): AuditWriter {
  return {
    async write(event: WriteAuditEventInput, tx?: TransactionContext): Promise<AuditEventRecord> {
      const minimalEvent = buildMinimalAuditEvent(event);
      return deps.repository.append(minimalEvent, tx);
    },

    async writeAtomic(event: WriteAuditEventInput): Promise<AuditEventRecord> {
      const minimalEvent = buildMinimalAuditEvent(event);
      if (!deps.transactions) {
        return deps.repository.append(minimalEvent);
      }
      return deps.transactions.runInTransaction(async (tx) =>
        deps.repository.append(minimalEvent, tx),
      );
    },
  };
}
