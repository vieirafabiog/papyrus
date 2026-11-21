import { createHash, timingSafeEqual } from "node:crypto";
import { type Readable, Transform } from "node:stream";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
export const PLACEHOLDER_SHA256_HEX = "0".repeat(64);

export type ChecksumErrorCode =
  | "INVALID_EXPECTED_CHECKSUM"
  | "SIZE_LIMIT_EXCEEDED"
  | "SIZE_MISMATCH"
  | "EMPTY_STREAM"
  | "CHECKSUM_MISMATCH"
  | "ABORTED";

export class ChecksumValidationError extends Error {
  public readonly code: ChecksumErrorCode;

  public constructor(code: ChecksumErrorCode, message: string) {
    super(message);
    this.name = "ChecksumValidationError";
    this.code = code;
  }
}

export interface StreamChecksumOptions {
  readonly maxBytes?: number | undefined;
  readonly allowEmpty?: boolean | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface StreamChecksumResult {
  readonly checksumSha256: string;
  readonly bytesProcessed: number;
}

export interface VerifyStreamSha256Options extends StreamChecksumOptions {
  readonly expectedChecksumSha256: string;
  readonly expectedSizeBytes?: number | undefined;
  readonly throwOnMismatch?: boolean | undefined;
}

export interface StreamChecksumVerificationResult {
  readonly valid: boolean;
  readonly actualChecksumSha256: string;
  readonly expectedChecksumSha256: string;
  readonly bytesProcessed: number;
  readonly sizeMatched: boolean;
  readonly checksumMatched: boolean;
}

export interface Sha256HashingTransformOptions {
  readonly maxBytes?: number | undefined;
  readonly expectedChecksumSha256?: string | undefined;
  readonly expectedSizeBytes?: number | undefined;
  readonly onDigest?: ((result: StreamChecksumResult) => void) | undefined;
}

/**
 * Validates and normalizes a hexadecimal SHA-256 checksum string, rejecting malformed
 * formats and all-zero placeholders unless explicitly permitted.
 */
export function normalizeSha256Hex(
  rawChecksum: string,
  options: { readonly allowPlaceholder?: boolean | undefined } = {},
): string {
  const normalized = rawChecksum.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new ChecksumValidationError(
      "INVALID_EXPECTED_CHECKSUM",
      "Checksum SHA-256 esperado possui formato inválido.",
    );
  }
  if (!options.allowPlaceholder && normalized === PLACEHOLDER_SHA256_HEX) {
    throw new ChecksumValidationError(
      "INVALID_EXPECTED_CHECKSUM",
      "Checksum SHA-256 esperado não pode ser o marcador provisório zerado.",
    );
  }
  return normalized;
}

/**
 * Performs constant-time equality comparison between two valid 64-character hex SHA-256 digests.
 */
export function isChecksumEqualConstantTime(actualHex: string, expectedHex: string): boolean {
  const normalizedActual = actualHex.trim().toLowerCase();
  const normalizedExpected = expectedHex.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalizedActual) || !SHA256_HEX_PATTERN.test(normalizedExpected)) {
    return false;
  }
  const actualBuf = Buffer.from(normalizedActual, "hex");
  const expectedBuf = Buffer.from(normalizedExpected, "hex");
  if (actualBuf.length !== 32 || expectedBuf.length !== 32) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Streams a Node `Readable` through incremental SHA-256 hashing with O(1) memory overhead,
 * optional size bounds, and cancellation support.
 */
export async function calculateStreamSha256(
  stream: Readable,
  options: StreamChecksumOptions = {},
): Promise<StreamChecksumResult> {
  if (options.abortSignal?.aborted) {
    stream.destroy();
    throw new ChecksumValidationError("ABORTED", "Cálculo de checksum cancelado antes de iniciar.");
  }

  const hasher = createHash("sha256");
  let bytesProcessed = 0;

  const onAbort = (): void => {
    stream.destroy(new ChecksumValidationError("ABORTED", "Cálculo de checksum cancelado."));
  };

  options.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const rawChunk of stream) {
      if (options.abortSignal?.aborted) {
        throw new ChecksumValidationError("ABORTED", "Cálculo de checksum cancelado.");
      }

      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      bytesProcessed += chunk.length;

      if (options.maxBytes !== undefined && bytesProcessed > options.maxBytes) {
        stream.destroy();
        throw new ChecksumValidationError(
          "SIZE_LIMIT_EXCEEDED",
          "O fluxo excedeu o limite máximo de bytes permitido para verificação SHA-256.",
        );
      }

      hasher.update(chunk);
    }
  } catch (error) {
    if (error instanceof ChecksumValidationError) {
      throw error;
    }
    if (options.abortSignal?.aborted) {
      throw new ChecksumValidationError("ABORTED", "Cálculo de checksum cancelado.");
    }
    throw error;
  } finally {
    options.abortSignal?.removeEventListener("abort", onAbort);
    if (!stream.destroyed) {
      stream.destroy();
    }
  }

  if (options.allowEmpty === false && bytesProcessed === 0) {
    throw new ChecksumValidationError(
      "EMPTY_STREAM",
      "Stream vazio não é permitido nesta verificação de integridade.",
    );
  }

  return {
    checksumSha256: hasher.digest("hex"),
    bytesProcessed,
  };
}

/**
 * Computes a stream's SHA-256 digest without buffering the payload and validates it in constant
 * time against the expected digest (and optional expected byte length).
 */
export async function verifyStreamSha256(
  stream: Readable,
  options: VerifyStreamSha256Options,
): Promise<StreamChecksumVerificationResult> {
  const expectedChecksumSha256 = normalizeSha256Hex(options.expectedChecksumSha256);

  if (
    options.expectedSizeBytes !== undefined &&
    (!Number.isInteger(options.expectedSizeBytes) || options.expectedSizeBytes < 0)
  ) {
    throw new ChecksumValidationError("SIZE_MISMATCH", "Tamanho esperado inválido para validação.");
  }

  const calculated = await calculateStreamSha256(stream, {
    maxBytes: options.maxBytes,
    allowEmpty: options.allowEmpty,
    abortSignal: options.abortSignal,
  });

  const checksumMatched = isChecksumEqualConstantTime(
    calculated.checksumSha256,
    expectedChecksumSha256,
  );
  const sizeMatched =
    options.expectedSizeBytes === undefined ||
    calculated.bytesProcessed === options.expectedSizeBytes;
  const valid = checksumMatched && sizeMatched;

  if (!valid && options.throwOnMismatch) {
    if (!sizeMatched) {
      throw new ChecksumValidationError(
        "SIZE_MISMATCH",
        "O tamanho do fluxo diverge do tamanho esperado na verificação.",
      );
    }
    throw new ChecksumValidationError(
      "CHECKSUM_MISMATCH",
      "O checksum SHA-256 calculado diverge do valor esperado.",
    );
  }

  return {
    valid,
    actualChecksumSha256: calculated.checksumSha256,
    expectedChecksumSha256,
    bytesProcessed: calculated.bytesProcessed,
    sizeMatched,
    checksumMatched,
  };
}

/**
 * Creates a pass-through `Transform` stream that incrementally computes SHA-256 and byte
 * counts while preserving Node stream backpressure.
 */
export function createSha256HashingTransform(
  options: Sha256HashingTransformOptions = {},
): Transform {
  const normalizedExpected =
    options.expectedChecksumSha256 !== undefined
      ? normalizeSha256Hex(options.expectedChecksumSha256)
      : null;

  const hasher = createHash("sha256");
  let bytesProcessed = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesProcessed += chunk.length;
      if (options.maxBytes !== undefined && bytesProcessed > options.maxBytes) {
        callback(
          new ChecksumValidationError(
            "SIZE_LIMIT_EXCEEDED",
            "O fluxo excedeu o limite máximo de bytes permitido.",
          ),
        );
        return;
      }
      hasher.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const checksumSha256 = hasher.digest("hex");
      if (options.expectedSizeBytes !== undefined && bytesProcessed !== options.expectedSizeBytes) {
        callback(
          new ChecksumValidationError(
            "SIZE_MISMATCH",
            "O tamanho do fluxo diverge do tamanho esperado.",
          ),
        );
        return;
      }
      if (
        normalizedExpected !== null &&
        !isChecksumEqualConstantTime(checksumSha256, normalizedExpected)
      ) {
        callback(
          new ChecksumValidationError(
            "CHECKSUM_MISMATCH",
            "O checksum SHA-256 calculado diverge do valor esperado.",
          ),
        );
        return;
      }
      options.onDigest?.({ checksumSha256, bytesProcessed });
      callback();
    },
  });
}
