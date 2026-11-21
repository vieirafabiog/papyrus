import net from "node:net";
import type { Readable } from "node:stream";
import type {
  AntivirusHealthResult,
  AntivirusScannerPort,
  ClamAvScannerConfig,
  MalwareScanInput,
  MalwareScanResult,
} from "./scanner.types.js";

const DEFAULT_CLAMAV_TIMEOUT_MS = 30_000;
const DEFAULT_CLAMAV_CHUNK_SIZE_BYTES = 64 * 1024;
const DEFAULT_CLAMAV_MAX_STREAM_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4096;

const SAFE_CLEAN_MESSAGE = "Arquivo verificado sem ameaças detectadas.";
const SAFE_INFECTED_MESSAGE = "O arquivo foi bloqueado pela verificação de segurança antimalware.";
const SAFE_UNAVAILABLE_MESSAGE =
  "Serviço de verificação antimalware indisponível no momento; arquivo mantido em quarentena.";
const SAFE_TIMEOUT_MESSAGE =
  "Tempo limite excedido durante a verificação antimalware; arquivo mantido em quarentena.";
const SAFE_ERROR_MESSAGE =
  "Não foi possível concluir a verificação antimalware com segurança; arquivo bloqueado.";

export interface ParsedClamdResponse {
  readonly status: "CLEAN" | "INFECTED" | "ERROR";
  readonly detectedSignature: string | null;
  readonly rawErrorCode: string;
}

/**
 * Parses a raw clamd response line (`stream: OK`, `stream: <name> FOUND`, or `... ERROR`).
 * Unrecognized responses fail closed as `ERROR`.
 */
export function parseClamdInstreamResponse(rawResponse: string): ParsedClamdResponse {
  const cleaned = rawResponse.replace(/\0/g, "").trim();
  if (cleaned === "stream: OK") {
    return {
      status: "CLEAN",
      detectedSignature: null,
      rawErrorCode: "CLAMD_OK",
    };
  }

  if (cleaned.endsWith(" FOUND")) {
    const withoutFound = cleaned.slice(0, -" FOUND".length);
    const colonIdx = withoutFound.indexOf(":");
    const rawSig = colonIdx >= 0 ? withoutFound.slice(colonIdx + 1).trim() : withoutFound.trim();
    return {
      status: "INFECTED",
      detectedSignature: rawSig.length > 0 ? rawSig.slice(0, 128) : "UNKNOWN_SIGNATURE",
      rawErrorCode: "CLAMD_THREAT_FOUND",
    };
  }

  if (cleaned.includes("ERROR")) {
    return {
      status: "ERROR",
      detectedSignature: null,
      rawErrorCode: "CLAMD_PROTOCOL_ERROR",
    };
  }

  return {
    status: "ERROR",
    detectedSignature: null,
    rawErrorCode: "CLAMD_UNEXPECTED_RESPONSE",
  };
}

function validateClamAvConfig(config: ClamAvScannerConfig): {
  readonly timeoutMs: number;
  readonly chunkSizeBytes: number;
  readonly maxStreamBytes: number;
} {
  if (config.transport === "tcp") {
    if (config.host.trim().length === 0) {
      throw new Error("Configuração ClamAV TCP inválida: host obrigatório.");
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error("Configuração ClamAV TCP inválida: porta deve estar entre 1 e 65535.");
    }
  } else if (config.socketPath.trim().length === 0) {
    throw new Error("Configuração ClamAV Unix inválida: socketPath obrigatório.");
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_CLAMAV_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 600_000) {
    throw new Error("Configuração ClamAV inválida: timeoutMs fora dos limites permitidos.");
  }

  const chunkSizeBytes = config.chunkSizeBytes ?? DEFAULT_CLAMAV_CHUNK_SIZE_BYTES;
  if (
    !Number.isInteger(chunkSizeBytes) ||
    chunkSizeBytes < 256 ||
    chunkSizeBytes > 4 * 1024 * 1024
  ) {
    throw new Error("Configuração ClamAV inválida: chunkSizeBytes fora dos limites permitidos.");
  }

  const maxStreamBytes = config.maxStreamBytes ?? DEFAULT_CLAMAV_MAX_STREAM_BYTES;
  if (!Number.isInteger(maxStreamBytes) || maxStreamBytes < 1) {
    throw new Error("Configuração ClamAV inválida: maxStreamBytes deve ser inteiro positivo.");
  }

  return { timeoutMs, chunkSizeBytes, maxStreamBytes };
}

function connectClamdSocket(config: ClamAvScannerConfig): net.Socket {
  if (config.transport === "tcp") {
    return net.createConnection({
      host: config.host.trim(),
      port: config.port,
    });
  }
  return net.createConnection({
    path: config.socketPath.trim(),
  });
}

async function writeSocketWithBackpressure(socket: net.Socket, payload: Buffer): Promise<void> {
  if (socket.destroyed || !socket.writable) {
    throw new Error("Socket ClamAV indisponível para escrita.");
  }
  const flushedImmediately = socket.write(payload);
  if (flushedImmediately) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Conexão com ClamAV encerrada durante escrita."));
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function streamFramedChunksToSocket(
  stream: Readable,
  socket: net.Socket,
  chunkSizeBytes: number,
  maxStreamBytes: number,
  abortSignal: AbortSignal,
): Promise<number> {
  let bytesScanned = 0;

  await writeSocketWithBackpressure(socket, Buffer.from("zINSTREAM\0", "ascii"));

  for await (const rawChunk of stream) {
    if (abortSignal.aborted) {
      throw new Error("SCAN_ABORTED");
    }

    const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    let offset = 0;

    while (offset < buf.length) {
      if (abortSignal.aborted) {
        throw new Error("SCAN_ABORTED");
      }

      const sliceEnd = Math.min(buf.length, offset + chunkSizeBytes);
      const slice = buf.subarray(offset, sliceEnd);
      offset = sliceEnd;

      bytesScanned += slice.length;
      if (bytesScanned > maxStreamBytes) {
        throw new Error("SCAN_MAX_BYTES_EXCEEDED");
      }

      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(slice.length, 0);
      await writeSocketWithBackpressure(socket, Buffer.concat([header, slice]));
    }
  }

  const terminator = Buffer.alloc(4, 0);
  await writeSocketWithBackpressure(socket, terminator);
  return bytesScanned;
}

/**
 * Creates a fail-closed ClamAV `clamd` adapter supporting TCP and Unix sockets via `zPING`
 * and `zINSTREAM` framing with bounded chunks, backpressure, timeouts, and explicit
 * `UNAVAILABLE` / `TIMEOUT` states that never falsely approve unscanned files.
 */
export function createClamAvScanner(config: ClamAvScannerConfig): AntivirusScannerPort {
  const settings = validateClamAvConfig(config);

  return {
    providerName: "clamav",

    async checkHealth(abortSignal?: AbortSignal): Promise<AntivirusHealthResult> {
      if (abortSignal?.aborted) {
        return {
          healthy: false,
          status: "UNAVAILABLE",
          message: "Verificação de saúde do ClamAV cancelada.",
          checkedAt: new Date(),
        };
      }

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), settings.timeoutMs);
      const socket = connectClamdSocket(config);

      try {
        const pong = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          let settled = false;

          const finishError = (err: Error): void => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          };

          const onAbort = (): void => {
            socket.destroy();
            finishError(new Error("HEALTH_TIMEOUT"));
          };

          timeoutController.signal.addEventListener("abort", onAbort, { once: true });
          abortSignal?.addEventListener("abort", onAbort, { once: true });

          socket.once("connect", () => {
            socket.write(Buffer.from("zPING\0", "ascii"));
          });
          socket.on("data", (data: Buffer) => {
            totalBytes += data.length;
            if (totalBytes <= MAX_RESPONSE_BYTES) {
              chunks.push(data);
            }
            if (data.includes(0) || data.includes(0x0a)) {
              settled = true;
              resolve(Buffer.concat(chunks).toString("utf8"));
            }
          });
          socket.once("end", () => {
            if (!settled) {
              settled = true;
              resolve(Buffer.concat(chunks).toString("utf8"));
            }
          });
          socket.once("error", finishError);
          socket.once("close", () => {
            finishError(new Error("CLAMD_CONNECTION_CLOSED"));
          });
        });

        const normalized = pong.replace(/\0/g, "").trim();
        if (normalized === "PONG") {
          return {
            healthy: true,
            status: "AVAILABLE",
            message: "Serviço ClamAV operacional e respondendo ao PING.",
            checkedAt: new Date(),
          };
        }

        return {
          healthy: false,
          status: "UNAVAILABLE",
          message: "Serviço ClamAV retornou resposta inesperada ao PING.",
          checkedAt: new Date(),
        };
      } catch (error) {
        const isTimeout = timeoutController.signal.aborted && !abortSignal?.aborted;
        const msg = isTimeout
          ? "Timeout ao verificar disponibilidade do serviço ClamAV."
          : error instanceof Error && error.message === "HEALTH_TIMEOUT"
            ? "Verificação de saúde do ClamAV interrompida."
            : "Serviço ClamAV indisponível ou recusando conexões.";
        return {
          healthy: false,
          status: isTimeout ? "TIMEOUT" : "UNAVAILABLE",
          message: msg,
          checkedAt: new Date(),
        };
      } finally {
        clearTimeout(timer);
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
    },

    async scanStream(input: MalwareScanInput): Promise<MalwareScanResult> {
      const startedAt = Date.now();
      const timeoutController = new AbortController();
      const combinedSignal = input.abortSignal
        ? AbortSignal.any([timeoutController.signal, input.abortSignal])
        : timeoutController.signal;

      const failResult = (params: {
        readonly status: MalwareScanResult["status"];
        readonly disposition: MalwareScanResult["disposition"];
        readonly retryable: boolean;
        readonly safeMessage: string;
        readonly diagnosticCode: string;
        readonly detectedSignature?: string | null | undefined;
        readonly bytesScanned?: number | undefined;
      }): MalwareScanResult => ({
        status: params.status,
        approved: false,
        disposition: params.disposition,
        retryable: params.retryable,
        safeMessage: params.safeMessage,
        diagnosticCode: params.diagnosticCode,
        detectedSignature: params.detectedSignature ?? null,
        bytesScanned: params.bytesScanned ?? 0,
        durationMs: Math.max(0, Date.now() - startedAt),
      });

      if (input.abortSignal?.aborted) {
        input.stream.destroy();
        return failResult({
          status: "UNAVAILABLE",
          disposition: "DEFER_RETRY",
          retryable: true,
          safeMessage: SAFE_UNAVAILABLE_MESSAGE,
          diagnosticCode: "CLAMD_SCAN_ABORTED",
        });
      }

      if (
        input.declaredSizeBytes !== undefined &&
        input.declaredSizeBytes > settings.maxStreamBytes
      ) {
        input.stream.destroy();
        return failResult({
          status: "ERROR",
          disposition: "REJECT",
          retryable: false,
          safeMessage: SAFE_ERROR_MESSAGE,
          diagnosticCode: "CLAMD_DECLARED_SIZE_EXCEEDS_LIMIT",
        });
      }

      const timer = setTimeout(() => {
        timeoutController.abort();
      }, settings.timeoutMs);

      const socket = connectClamdSocket(config);
      let bytesScanned = 0;
      let rejectOnAbort: ((err: Error) => void) | null = null;

      const onSignalAbort = (): void => {
        socket.destroy();
        input.stream.destroy();
        rejectOnAbort?.(
          new Error(timeoutController.signal.aborted ? "CLAMD_TIMEOUT" : "CLAMD_SCAN_ABORTED"),
        );
      };
      combinedSignal.addEventListener("abort", onSignalAbort, { once: true });

      try {
        const rawResponse = await new Promise<string>((resolve, reject) => {
          const responseChunks: Buffer[] = [];
          let responseBytes = 0;
          let settled = false;

          const fail = (err: Error): void => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          };
          rejectOnAbort = fail;

          socket.once("error", (err) => {
            fail(err);
          });

          socket.on("data", (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              fail(new Error("CLAMD_RESPONSE_TOO_LARGE"));
              return;
            }
            responseChunks.push(chunk);
            if (chunk.includes(0) || chunk.includes(0x0a)) {
              if (!settled) {
                settled = true;
                resolve(Buffer.concat(responseChunks).toString("utf8"));
              }
            }
          });

          socket.once("end", () => {
            if (!settled) {
              settled = true;
              if (responseChunks.length === 0) {
                reject(new Error("CLAMD_EMPTY_RESPONSE"));
                return;
              }
              resolve(Buffer.concat(responseChunks).toString("utf8"));
            }
          });

          socket.once("connect", () => {
            void streamFramedChunksToSocket(
              input.stream,
              socket,
              settings.chunkSizeBytes,
              settings.maxStreamBytes,
              combinedSignal,
            )
              .then((count) => {
                bytesScanned = count;
              })
              .catch((err: unknown) => {
                fail(err instanceof Error ? err : new Error("CLAMD_STREAM_WRITE_FAILED"));
              });
          });

          socket.once("close", () => {
            if (!settled) {
              fail(
                new Error(
                  timeoutController.signal.aborted ? "CLAMD_TIMEOUT" : "CLAMD_CONNECTION_CLOSED",
                ),
              );
            }
          });
        });

        const parsed = parseClamdInstreamResponse(rawResponse);
        if (parsed.status === "CLEAN") {
          return {
            status: "CLEAN",
            approved: true,
            disposition: "APPROVE",
            retryable: false,
            safeMessage: SAFE_CLEAN_MESSAGE,
            diagnosticCode: parsed.rawErrorCode,
            detectedSignature: null,
            bytesScanned,
            durationMs: Math.max(0, Date.now() - startedAt),
          };
        }

        if (parsed.status === "INFECTED") {
          return failResult({
            status: "INFECTED",
            disposition: "REJECT",
            retryable: false,
            safeMessage: SAFE_INFECTED_MESSAGE,
            diagnosticCode: parsed.rawErrorCode,
            detectedSignature: parsed.detectedSignature,
            bytesScanned,
          });
        }

        return failResult({
          status: "ERROR",
          disposition: "REJECT",
          retryable: false,
          safeMessage: SAFE_ERROR_MESSAGE,
          diagnosticCode: parsed.rawErrorCode,
          bytesScanned,
        });
      } catch (error) {
        if (timeoutController.signal.aborted) {
          return failResult({
            status: "TIMEOUT",
            disposition: "DEFER_RETRY",
            retryable: true,
            safeMessage: SAFE_TIMEOUT_MESSAGE,
            diagnosticCode: "CLAMD_TIMEOUT",
            bytesScanned,
          });
        }

        const errMessage = error instanceof Error ? error.message : "";
        if (errMessage === "SCAN_MAX_BYTES_EXCEEDED") {
          return failResult({
            status: "ERROR",
            disposition: "REJECT",
            retryable: false,
            safeMessage: SAFE_ERROR_MESSAGE,
            diagnosticCode: "CLAMD_MAX_STREAM_BYTES_EXCEEDED",
            bytesScanned,
          });
        }

        if (errMessage === "CLAMD_RESPONSE_TOO_LARGE" || errMessage === "CLAMD_EMPTY_RESPONSE") {
          return failResult({
            status: "UNAVAILABLE",
            disposition: "DEFER_RETRY",
            retryable: true,
            safeMessage: SAFE_UNAVAILABLE_MESSAGE,
            diagnosticCode: errMessage,
            bytesScanned,
          });
        }

        return failResult({
          status: "UNAVAILABLE",
          disposition: "DEFER_RETRY",
          retryable: true,
          safeMessage: SAFE_UNAVAILABLE_MESSAGE,
          diagnosticCode: "CLAMD_UNAVAILABLE",
          bytesScanned,
        });
      } finally {
        clearTimeout(timer);
        combinedSignal.removeEventListener("abort", onSignalAbort);
        if (!socket.destroyed) {
          socket.destroy();
        }
        if (!input.stream.destroyed) {
          input.stream.destroy();
        }
      }
    },
  };
}
