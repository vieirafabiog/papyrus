import { createHash } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { uuidSchema } from "@docuflow/contracts";
import type { OutboxJobRecord, OutboxRepository } from "@docuflow/database";
import { UPLOAD_PROCESSING_EVENT_TYPE } from "@docuflow/database";
import type {
  AuditRepositoryPort,
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
  StorageConnectionRepositoryPort,
  TransactionManagerPort,
  UploadSessionRepositoryPort,
} from "@docuflow/domain";
import {
  type AntivirusScannerPort,
  type ContentDetectionPolicy,
  DEFAULT_HEADER_SAMPLE_BYTES,
  inspectFileContent,
  isChecksumEqualConstantTime,
} from "@docuflow/file-processing";
import { StorageError, type StorageProviderRegistry } from "@docuflow/storage-core";
import { z } from "zod";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 15_000;
const SAFE_INTEGRITY_REJECTION =
  "O arquivo falhou na verificação de integridade (tamanho ou checksum SHA-256).";
const SAFE_MISSING_OBJECT_REJECTION =
  "Arquivo não encontrado no armazenamento configurado durante a verificação.";
const SAFE_UNEXPECTED_PROCESSING_ERROR =
  "Falha técnica temporária durante a verificação do arquivo; mantido em quarentena.";

const uploadProcessingPayloadSchema = z.object({
  uploadSessionId: uuidSchema,
  fileObjectId: uuidSchema,
  storageConnectionId: uuidSchema,
  documentId: uuidSchema.nullable(),
  documentVersionId: uuidSchema.nullable(),
});

export type ProcessUploadOutcome =
  | { readonly outcome: "NO_JOB" }
  | { readonly outcome: "ALREADY_PROCESSED"; readonly jobId: string; readonly fileObjectId: string }
  | { readonly outcome: "APPROVED"; readonly jobId: string; readonly fileObjectId: string }
  | {
      readonly outcome: "REJECTED";
      readonly jobId: string;
      readonly fileObjectId: string;
      readonly reason: string;
    }
  | {
      readonly outcome: "MISSING";
      readonly jobId: string;
      readonly fileObjectId: string;
    }
  | {
      readonly outcome: "DEFERRED";
      readonly jobId: string;
      readonly fileObjectId: string;
      readonly failedPermanently: boolean;
      readonly diagnosticCode: string;
    };

export interface ProcessUploadJobDependencies {
  readonly outbox: OutboxRepository;
  readonly uploads: UploadSessionRepositoryPort;
  readonly connections: StorageConnectionRepositoryPort;
  readonly documents: DocumentRepositoryPort;
  readonly documentVersions: DocumentVersionRepositoryPort;
  readonly audit: AuditRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly scanner: AntivirusScannerPort;
  readonly contentPolicy?: ContentDetectionPolicy | undefined;
  readonly maxAttempts?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ProcessUploadJobHandler {
  processNextJob(): Promise<ProcessUploadOutcome>;
  processClaimedJob(job: OutboxJobRecord): Promise<ProcessUploadOutcome>;
}

async function writeChunkWithBackpressure(stream: PassThrough, chunk: Buffer): Promise<void> {
  if (stream.destroyed || !stream.writable) {
    return;
  }
  const canContinue = stream.write(chunk);
  if (canContinue) {
    return;
  }
  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      stream.off("drain", finish);
      stream.off("close", finish);
      stream.off("error", finish);
    };
    const finish = (): void => {
      cleanup();
      resolve();
    };
    stream.once("drain", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
}

async function inspectChecksumMimeAndScan(params: {
  readonly body: Readable;
  readonly expectedSizeBytes: number;
  readonly maxHeaderSampleBytes: number;
  readonly scanner: AntivirusScannerPort;
}): Promise<{
  readonly bytesRead: number;
  readonly checksumSha256: string;
  readonly headerSample: Buffer;
  readonly scanResult: Awaited<ReturnType<AntivirusScannerPort["scanStream"]>>;
}> {
  const scannerFeed = new PassThrough();
  // Prevent unhandled error event if scanner closes socket early while feed drains
  scannerFeed.on("error", () => {});

  const scanPromise = params.scanner.scanStream({
    stream: scannerFeed,
    declaredSizeBytes: params.expectedSizeBytes,
  });

  const hasher = createHash("sha256");
  const headerChunks: Buffer[] = [];
  let headerBytes = 0;
  let bytesRead = 0;

  try {
    for await (const rawChunk of params.body) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : typeof rawChunk === "string"
          ? Buffer.from(rawChunk)
          : Buffer.from(rawChunk as Uint8Array);
      if (chunk.length === 0) {
        continue;
      }

      bytesRead += chunk.length;
      hasher.update(chunk);

      if (headerBytes < params.maxHeaderSampleBytes) {
        const remaining = params.maxHeaderSampleBytes - headerBytes;
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        headerChunks.push(slice);
        headerBytes += slice.length;
      }

      await writeChunkWithBackpressure(scannerFeed, chunk);
    }
  } finally {
    if (!scannerFeed.destroyed && scannerFeed.writable) {
      scannerFeed.end();
    }
  }

  const scanResult = await scanPromise;
  return {
    bytesRead,
    checksumSha256: hasher.digest("hex"),
    headerSample: Buffer.concat(headerChunks, headerBytes),
    scanResult,
  };
}

/**
 * Consumes persisted `UPLOAD_PROCESSING_REQUESTED` jobs, streams the stored object to verify
 * SHA-256 checksum, MIME signature/allowlist, and fail-closed antivirus scan, and updates
 * object, document version activation, outbox state, and audit trail in a single transaction.
 */
export function createProcessUploadJobHandler(
  deps: ProcessUploadJobDependencies,
): ProcessUploadJobHandler {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const visibilityTimeoutMs = deps.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const nowFn = deps.now ?? (() => new Date());
  const maxHeaderSampleBytes =
    deps.contentPolicy?.maxHeaderSampleBytes ?? DEFAULT_HEADER_SAMPLE_BYTES;

  const deferOrFailJob = async (params: {
    readonly job: OutboxJobRecord;
    readonly fileObjectId: string;
    readonly diagnosticCode: string;
    readonly auditAction: string;
    readonly safeErrorSummary: string;
  }): Promise<ProcessUploadOutcome> => {
    const updatedJob = await deps.transactions.runInTransaction(async (tx) => {
      const nextJob = await deps.outbox.scheduleRetryOrFail(
        {
          jobId: params.job.id,
          attempts: params.job.attempts,
          maxAttempts,
          retryDelayMs,
          safeErrorSummary: params.safeErrorSummary,
          now: nowFn(),
        },
        tx,
      );

      await deps.audit.append(
        {
          organizationId: params.job.organizationId,
          actorUserId: null,
          action: params.auditAction,
          resourceType: "FILE_OBJECT",
          resourceId: params.fileObjectId,
          result: "FAILURE",
          requestId: params.job.id,
          metadata: {
            outboxJobId: params.job.id,
            diagnosticCode: params.diagnosticCode,
            attempt: params.job.attempts,
            maxAttempts,
            terminalFailure: nextJob?.status === "FAILED",
          },
        },
        tx,
      );

      return nextJob;
    });

    return {
      outcome: "DEFERRED",
      jobId: params.job.id,
      fileObjectId: params.fileObjectId,
      failedPermanently: updatedJob?.status === "FAILED",
      diagnosticCode: params.diagnosticCode,
    };
  };

  const rejectFileObject = async (params: {
    readonly job: OutboxJobRecord;
    readonly fileObjectId: string;
    readonly safeReason: string;
    readonly diagnosticCode: string;
    readonly detectedMime: string | null;
    readonly status?: "REJECTED" | "MISSING" | undefined;
  }): Promise<ProcessUploadOutcome> => {
    const targetStatus = params.status ?? "REJECTED";
    const truncatedReason = params.safeReason.slice(0, 255);

    await deps.transactions.runInTransaction(async (tx) => {
      await deps.uploads.markFileObjectProcessed(
        {
          fileObjectId: params.fileObjectId,
          status: targetStatus,
          ...(params.detectedMime ? { detectedContentType: params.detectedMime } : {}),
          rejectionReason: truncatedReason,
        },
        tx,
      );

      await deps.outbox.markPublished(params.job.id, tx);

      await deps.audit.append(
        {
          organizationId: params.job.organizationId,
          actorUserId: null,
          action: targetStatus === "MISSING" ? "UPLOAD_OBJECT_MISSING" : "UPLOAD_FILE_REJECTED",
          resourceType: "FILE_OBJECT",
          resourceId: params.fileObjectId,
          result: "FAILURE",
          requestId: params.job.id,
          metadata: {
            outboxJobId: params.job.id,
            diagnosticCode: params.diagnosticCode,
            detectedMime: params.detectedMime,
            safeReason: truncatedReason,
          },
        },
        tx,
      );
    });

    if (targetStatus === "MISSING") {
      return {
        outcome: "MISSING",
        jobId: params.job.id,
        fileObjectId: params.fileObjectId,
      };
    }

    return {
      outcome: "REJECTED",
      jobId: params.job.id,
      fileObjectId: params.fileObjectId,
      reason: truncatedReason,
    };
  };

  const processClaimedJob = async (job: OutboxJobRecord): Promise<ProcessUploadOutcome> => {
    const parsedPayload = uploadProcessingPayloadSchema.safeParse(job.payload);
    if (!parsedPayload.success) {
      await deps.outbox.scheduleRetryOrFail({
        jobId: job.id,
        attempts: maxAttempts,
        maxAttempts,
        retryDelayMs,
        safeErrorSummary: "INVALID_UPLOAD_JOB_PAYLOAD",
        now: nowFn(),
      });
      return {
        outcome: "DEFERRED",
        jobId: job.id,
        fileObjectId: job.aggregateId,
        failedPermanently: true,
        diagnosticCode: "INVALID_UPLOAD_JOB_PAYLOAD",
      };
    }

    const payload = parsedPayload.data;
    const fileObject = await deps.uploads.findFileObjectById(payload.fileObjectId);
    if (!fileObject) {
      await deps.transactions.runInTransaction(async (tx) => {
        await deps.outbox.markPublished(job.id, tx);
        await deps.audit.append(
          {
            organizationId: job.organizationId,
            actorUserId: null,
            action: "UPLOAD_OBJECT_MISSING",
            resourceType: "FILE_OBJECT",
            resourceId: payload.fileObjectId,
            result: "FAILURE",
            requestId: job.id,
            metadata: { outboxJobId: job.id, diagnosticCode: "FILE_OBJECT_RECORD_NOT_FOUND" },
          },
          tx,
        );
      });
      return {
        outcome: "MISSING",
        jobId: job.id,
        fileObjectId: payload.fileObjectId,
      };
    }

    if (fileObject.status === "AVAILABLE" || fileObject.status === "REJECTED") {
      await deps.outbox.markPublished(job.id);
      return {
        outcome: "ALREADY_PROCESSED",
        jobId: job.id,
        fileObjectId: fileObject.id,
      };
    }

    if (fileObject.status !== "QUARANTINED") {
      await deps.outbox.scheduleRetryOrFail({
        jobId: job.id,
        attempts: maxAttempts,
        maxAttempts,
        retryDelayMs,
        safeErrorSummary: `UNEXPECTED_FILE_STATUS_${fileObject.status}`,
        now: nowFn(),
      });
      return {
        outcome: "DEFERRED",
        jobId: job.id,
        fileObjectId: fileObject.id,
        failedPermanently: true,
        diagnosticCode: `UNEXPECTED_FILE_STATUS_${fileObject.status}`,
      };
    }

    const connection = await deps.connections.findById(fileObject.storageConnectionId);
    if (!connection || connection.organizationId !== job.organizationId) {
      return deferOrFailJob({
        job,
        fileObjectId: fileObject.id,
        diagnosticCode: "STORAGE_CONNECTION_UNAVAILABLE",
        auditAction: "UPLOAD_PROCESSING_DEFERRED",
        safeErrorSummary: "Conexão de armazenamento indisponível para processamento.",
      });
    }

    try {
      const provider = await deps.storageRegistry.resolveProvider(connection, {
        allowInactive: true,
      });
      const download = await provider.getObject({ value: fileObject.objectKey });

      const inspected = await inspectChecksumMimeAndScan({
        body: download.body,
        expectedSizeBytes: fileObject.sizeBytes,
        maxHeaderSampleBytes,
        scanner: deps.scanner,
      });

      const sizeMatches = inspected.bytesRead > 0 && inspected.bytesRead === fileObject.sizeBytes;
      const checksumMatches = isChecksumEqualConstantTime(
        inspected.checksumSha256,
        fileObject.checksumSha256,
      );

      if (!sizeMatches || !checksumMatches) {
        return rejectFileObject({
          job,
          fileObjectId: fileObject.id,
          safeReason: SAFE_INTEGRITY_REJECTION,
          diagnosticCode: !sizeMatches ? "WORKER_SIZE_MISMATCH" : "WORKER_CHECKSUM_MISMATCH",
          detectedMime: null,
        });
      }

      const contentResult = inspectFileContent(
        inspected.headerSample,
        {
          originalFileName: fileObject.originalFileName,
          declaredContentType: fileObject.detectedContentType,
        },
        deps.contentPolicy,
      );

      if (!contentResult.accepted) {
        return rejectFileObject({
          job,
          fileObjectId: fileObject.id,
          safeReason: contentResult.rejection.safeMessage,
          diagnosticCode: contentResult.rejection.code,
          detectedMime: contentResult.detectedMime,
        });
      }

      if (inspected.scanResult.disposition === "REJECT") {
        return rejectFileObject({
          job,
          fileObjectId: fileObject.id,
          safeReason: inspected.scanResult.safeMessage,
          diagnosticCode: inspected.scanResult.diagnosticCode,
          detectedMime: contentResult.detectedMime,
        });
      }

      if (!inspected.scanResult.approved || inspected.scanResult.disposition !== "APPROVE") {
        return deferOrFailJob({
          job,
          fileObjectId: fileObject.id,
          diagnosticCode: inspected.scanResult.diagnosticCode,
          auditAction: "UPLOAD_SCAN_DEFERRED",
          safeErrorSummary: inspected.scanResult.safeMessage,
        });
      }

      // All checks passed (checksum, size, MIME/allowlist, clean antivirus scan):
      // approve file object, activate version on document, publish job, and audit atomically.
      await deps.transactions.runInTransaction(async (tx) => {
        const activatedFile = await deps.uploads.markFileObjectProcessed(
          {
            fileObjectId: fileObject.id,
            status: "AVAILABLE",
            detectedContentType: contentResult.detectedMime,
            rejectionReason: null,
          },
          tx,
        );
        if (!activatedFile) {
          throw new Error("CONCURRENT_FILE_OBJECT_TRANSITION");
        }

        if (payload.documentId && payload.documentVersionId) {
          const doc = await deps.documents.findById(payload.documentId, tx);
          const version = await deps.documentVersions.findById(payload.documentVersionId, tx);
          if (
            doc &&
            doc.organizationId === job.organizationId &&
            doc.status !== "DELETED" &&
            version &&
            version.documentId === doc.id &&
            version.fileObjectId === fileObject.id
          ) {
            const updatedDoc = await deps.documents.setCurrentVersion(
              doc.id,
              version.id,
              doc.version,
              tx,
            );
            if (!updatedDoc) {
              throw new Error("DOCUMENT_OPTIMISTIC_LOCK_CONFLICT");
            }
          }
        }

        await deps.outbox.markPublished(job.id, tx);

        await deps.audit.append(
          {
            organizationId: job.organizationId,
            actorUserId: null,
            action: "UPLOAD_FILE_AVAILABLE",
            resourceType: "FILE_OBJECT",
            resourceId: fileObject.id,
            result: "SUCCESS",
            requestId: job.id,
            metadata: {
              outboxJobId: job.id,
              detectedMime: contentResult.detectedMime,
              bytesScanned: inspected.bytesRead,
              documentId: payload.documentId,
              documentVersionId: payload.documentVersionId,
            },
          },
          tx,
        );
      });

      return {
        outcome: "APPROVED",
        jobId: job.id,
        fileObjectId: fileObject.id,
      };
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        return rejectFileObject({
          job,
          fileObjectId: fileObject.id,
          safeReason: SAFE_MISSING_OBJECT_REJECTION,
          diagnosticCode: "STORAGE_OBJECT_MISSING",
          detectedMime: null,
          status: "MISSING",
        });
      }

      const diagnosticCode =
        error instanceof StorageError
          ? `STORAGE_${error.code}`
          : error instanceof Error
            ? error.message.slice(0, 120)
            : "WORKER_PROCESSING_ERROR";

      return deferOrFailJob({
        job,
        fileObjectId: fileObject.id,
        diagnosticCode,
        auditAction: "UPLOAD_PROCESSING_DEFERRED",
        safeErrorSummary: SAFE_UNEXPECTED_PROCESSING_ERROR,
      });
    }
  };

  return {
    processClaimedJob,

    async processNextJob(): Promise<ProcessUploadOutcome> {
      const claimed = await deps.outbox.claimNextPending({
        eventType: UPLOAD_PROCESSING_EVENT_TYPE,
        maxAttempts,
        visibilityTimeoutMs,
        now: nowFn(),
      });
      if (!claimed) {
        return { outcome: "NO_JOB" };
      }
      return processClaimedJob(claimed);
    },
  };
}
