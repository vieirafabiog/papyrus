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

/**
 * Redacts credentials, tokens, signed query strings, and URL userinfo from raw messages.
 */
export function sanitizeStorageErrorMessage(rawMessage: string): string {
  return rawMessage
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, "$1[REDACTED]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(x-amz-security-token|x-amz-credential|x-amz-signature|awsaccesskeyid|authorization|secretaccesskey|accesskeyid|sessiontoken|password|secret|token|signature)\s*[:=]\s*["']?[^\s"',;&}]+["']?/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /"(secretAccessKey|accessKeyId|sessionToken|password|secret|token|signature)"\s*:\s*"[^"]*"/gi,
      '"$1":"[REDACTED]"',
    )
    .slice(0, 500);
}

export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  public readonly providerKind: StorageProviderKind | undefined;
  public readonly retryable: boolean;

  public constructor(code: StorageErrorCode, message: string, providerKind?: StorageProviderKind) {
    super(sanitizeStorageErrorMessage(message));
    this.name = "StorageError";
    this.code = code;
    this.providerKind = providerKind;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}

export function isRetryableStorageError(error: unknown): boolean {
  return error instanceof StorageError && error.retryable;
}

interface ExtractedErrorSignals {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly statusCode: number | undefined;
  readonly cause: unknown;
}

function readStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStatusCode(record: Record<string, unknown>): number | undefined {
  const metadata = record.$metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const httpStatus = (metadata as Record<string, unknown>).httpStatusCode;
    if (typeof httpStatus === "number" && Number.isFinite(httpStatus)) {
      return httpStatus;
    }
  }

  for (const key of ["statusCode", "status"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function extractErrorSignals(error: unknown): ExtractedErrorSignals {
  if (typeof error !== "object" || error === null) {
    return {
      name: "",
      code: "",
      message: typeof error === "string" ? error : "",
      statusCode: undefined,
      cause: undefined,
    };
  }

  const record = error as Record<string, unknown>;
  const name = (readStringProperty(record, "name") ?? "").toLowerCase();
  const code = (
    readStringProperty(record, "code") ??
    readStringProperty(record, "Code") ??
    ""
  ).toLowerCase();
  const message = (
    error instanceof Error ? error.message : (readStringProperty(record, "message") ?? "")
  ).toLowerCase();
  const statusCode = readStatusCode(record);
  const cause = "cause" in record ? record.cause : undefined;

  return { name, code, message, statusCode, cause };
}

function includesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function classifyError(
  signals: ExtractedErrorSignals,
  providerKind?: StorageProviderKind,
): StorageError | null {
  const { name, code, message, statusCode } = signals;

  if (
    includesAny(code, ["checksum", "baddigest", "invaliddigest", "err_checksum"]) ||
    includesAny(name, ["baddigest", "invaliddigest"]) ||
    includesAny(message, ["checksum", "baddigest", "invaliddigest", "digest mismatch"])
  ) {
    return new StorageError(
      "CHECKSUM_MISMATCH",
      "Divergência de integridade (checksum) detectada no objeto.",
      providerKind,
    );
  }

  if (
    includesAny(code, ["invalidkey", "invalid_key"]) ||
    includesAny(message, ["path traversal", "chave de objeto inválida"])
  ) {
    return new StorageError(
      "INVALID_KEY",
      "Chave ou caminho de objeto inválido para armazenamento.",
      providerKind,
    );
  }

  if (
    statusCode === 404 ||
    includesAny(code, ["enoent", "nosuchkey", "nosuchbucket", "notfound", "not_found"]) ||
    includesAny(name, ["nosuchkey", "nosuchbucket", "notfound"]) ||
    includesAny(message, ["enoent", "nosuchkey", "nosuchbucket", "not found", "no such file"])
  ) {
    return new StorageError("NOT_FOUND", "Objeto não encontrado no armazenamento.", providerKind);
  }

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    includesAny(code, [
      "eacces",
      "eperm",
      "accessdenied",
      "unauthorized",
      "forbidden",
      "invalidaccesskeyid",
      "signaturedoesnotmatch",
      "expiredtoken",
      "invalidtoken",
    ]) ||
    includesAny(name, ["accessdenied", "unauthorized"]) ||
    includesAny(message, [
      "eacces",
      "eperm",
      "unauthorized",
      "accessdenied",
      "access denied",
      "forbidden",
      "invalidaccesskeyid",
      "signaturedoesnotmatch",
    ])
  ) {
    return new StorageError(
      "UNAUTHORIZED",
      "Acesso negado ou credenciais inválidas no provedor de armazenamento.",
      providerKind,
    );
  }

  if (
    statusCode === 409 ||
    statusCode === 412 ||
    includesAny(code, [
      "eexist",
      "conflict",
      "preconditionfailed",
      "conditionalcheckfailedexception",
      "bucketalreadyexists",
      "bucketalreadyownedbyyou",
    ]) ||
    includesAny(name, ["preconditionfailed", "conditionalcheckfailedexception"]) ||
    includesAny(message, [
      "eexist",
      "preconditionfailed",
      "conditional check",
      "already exists",
      "conflict",
    ])
  ) {
    return new StorageError(
      "CONFLICT",
      "Conflito de estado ou pré-condição na operação de armazenamento.",
      providerKind,
    );
  }

  if (
    statusCode === 429 ||
    includesAny(code, [
      "slowdown",
      "throttl",
      "toomanyrequestsexception",
      "requestlimitexceeded",
    ]) ||
    includesAny(name, ["slowdown", "throttling", "toomanyrequests"]) ||
    includesAny(message, ["throttl", "slowdown", "slow down", "too many requests", "429"])
  ) {
    return new StorageError(
      "THROTTLED",
      "Provedor de armazenamento limitou a taxa de requisições.",
      providerKind,
    );
  }

  if (
    statusCode === 408 ||
    statusCode === 504 ||
    includesAny(code, ["etimedout", "esockettimedout", "requesttimeout", "err_abort"]) ||
    includesAny(name, ["timeouterror", "aborterror", "requesttimeout"]) ||
    includesAny(message, ["timeout", "timed out", "etimedout", "aborted"])
  ) {
    return new StorageError(
      "TIMEOUT",
      "Tempo limite excedido na operação de armazenamento.",
      providerKind,
    );
  }

  if (
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    includesAny(code, [
      "econnrefused",
      "econnreset",
      "ehostunreach",
      "enetunreach",
      "enotfound",
      "eai_again",
      "epipe",
      "enospc",
      "ebusy",
      "serviceunavailable",
      "internalerror",
      "unavailable",
    ]) ||
    includesAny(name, ["serviceunavailable", "internalerror"]) ||
    includesAny(message, [
      "service unavailable",
      "econnrefused",
      "econnreset",
      "enotfound",
      "eai_again",
      "enospc",
      "temporarily unavailable",
      "unavailable",
    ])
  ) {
    return new StorageError(
      "UNAVAILABLE",
      "Provedor de armazenamento temporariamente indisponível.",
      providerKind,
    );
  }

  return null;
}

export function normalizeStorageError(
  error: unknown,
  providerKind?: StorageProviderKind,
): StorageError {
  if (error instanceof StorageError) {
    if (providerKind !== undefined && error.providerKind === undefined) {
      return new StorageError(error.code, error.message, providerKind);
    }
    return error;
  }

  const signals = extractErrorSignals(error);
  const direct = classifyError(signals, providerKind);
  if (direct) {
    return direct;
  }

  if (signals.cause !== undefined && signals.cause !== error) {
    const fromCause = normalizeStorageError(signals.cause, providerKind);
    if (fromCause.code !== "UNKNOWN") {
      return fromCause;
    }
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return new StorageError("UNKNOWN", error.message, providerKind);
  }

  return new StorageError(
    "UNKNOWN",
    "Erro desconhecido no provedor de armazenamento.",
    providerKind,
  );
}
