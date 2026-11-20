import type { StorageProviderKind } from "./storage.types.js";

export type StorageErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "TIMEOUT"
  | "THROTTLED"
  | "UNAVAILABLE"
  | "CHECKSUM_MISMATCH"
  | "CONFLICT"
  | "INVALID_KEY"
  | "CAPABILITY_NOT_SUPPORTED"
  | "UNKNOWN";

const RETRYABLE_CODES = new Set<StorageErrorCode>(["TIMEOUT", "THROTTLED", "UNAVAILABLE"]);

export function sanitizeStorageErrorMessage(rawMessage: string): string {
  return rawMessage
    .replace(/([a-z]+:\/\/)([^:@\s]+):([^@\s]+)@/gi, "$1[REDACTED]@")
    .replace(/(authorization|x-amz-security-token|secretaccesskey|accesskeyid)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/(password|secret|token|signature)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  public readonly providerKind: StorageProviderKind | undefined;
  public readonly retryable: boolean;

  public constructor(
    code: StorageErrorCode,
    message: string,
    providerKind?: StorageProviderKind,
  ) {
    super(sanitizeStorageErrorMessage(message));
    this.name = "StorageError";
    this.code = code;
    this.providerKind = providerKind;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

export function normalizeStorageError(
  error: unknown,
  providerKind?: StorageProviderKind,
): StorageError {
  if (error instanceof StorageError) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("enoent") || lower.includes("not found") || lower.includes("nosuchkey")) {
      return new StorageError("NOT_FOUND", "Objeto não encontrado no armazenamento.", providerKind);
    }
    if (lower.includes("eacces") || lower.includes("eperm") || lower.includes("unauthorized") || lower.includes("accessdenied")) {
      return new StorageError("UNAUTHORIZED", "Acesso negado ao provedor de armazenamento.", providerKind);
    }
    if (lower.includes("timeout") || lower.includes("etimedout") || lower.includes("aborted")) {
      return new StorageError("TIMEOUT", "Tempo limite excedido na operação de armazenamento.", providerKind);
    }
    if (lower.includes("throttl") || lower.includes("slowdown") || lower.includes("429")) {
      return new StorageError("THROTTLED", "Provedor de armazenamento limitou a taxa de requisições.", providerKind);
    }
    if (lower.includes("checksum")) {
      return new StorageError("CHECKSUM_MISMATCH", "Divergência de integridade (checksum) detectada.", providerKind);
    }
    return new StorageError("UNKNOWN", error.message, providerKind);
  }

  return new StorageError("UNKNOWN", "Erro desconhecido no provedor de armazenamento.", providerKind);
}
