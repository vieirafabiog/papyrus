import { uuidSchema } from "@papyrus/contracts";
import {
  DOCUMENT_TEXT_INDEXING_EVENT_TYPE,
  type OutboxJobRecord,
  type OutboxRepository,
} from "@papyrus/database";
import type {
  AuditRepositoryPort,
  CategoryRepositoryPort,
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
  StorageConnectionRepositoryPort,
  TransactionManagerPort,
  UploadSessionRepositoryPort,
} from "@papyrus/domain";
import {
  type ExtractedTextIndexRepository,
  type TextExtractionPolicy,
  type TextOcrEnginePort,
  extractAndIndexDocumentVersionText,
} from "@papyrus/file-processing";
import { StorageError, type StorageProviderRegistry } from "@papyrus/storage-core";
import { z } from "zod";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 20_000;

const documentTextIndexingPayloadSchema = z.object({
  documentId: uuidSchema,
  documentVersionId: uuidSchema,
  fileObjectId: uuidSchema,
  storageConnectionId: uuidSchema,
});

export type IndexDocumentTextOutcome =
  | { readonly outcome: "NO_JOB" }
  | {
      readonly outcome: "INDEXED";
      readonly jobId: string;
      readonly documentVersionId: string;
      readonly charCount: number;
    }
  | {
      readonly outcome: "SKIPPED";
      readonly jobId: string;
      readonly documentVersionId: string | null;
      readonly reason: string;
    }
  | {
      readonly outcome: "DEFERRED";
      readonly jobId: string;
      readonly documentVersionId: string;
      readonly failedPermanently: boolean;
      readonly diagnosticCode: string;
    };

export interface IndexDocumentTextJobDependencies {
  readonly outbox: OutboxRepository;
  readonly uploads: UploadSessionRepositoryPort;
  readonly connections: StorageConnectionRepositoryPort;
  readonly documents: DocumentRepositoryPort;
  readonly documentVersions: DocumentVersionRepositoryPort;
  readonly categories: CategoryRepositoryPort;
  readonly audit: AuditRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly policy: TextExtractionPolicy;
  readonly indexRepository: ExtractedTextIndexRepository;
  readonly ocrEngine?: TextOcrEnginePort | undefined;
  readonly maxAttempts?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface IndexDocumentTextJobHandler {
  processNextJob(): Promise<IndexDocumentTextOutcome>;
  processClaimedJob(job: OutboxJobRecord): Promise<IndexDocumentTextOutcome>;
}

/**
 * Consumes `DOCUMENT_TEXT_INDEXING_REQUESTED` outbox jobs for verified `AVAILABLE`
 * document versions, extracts text (including Tesseract OCR fallback for scanned PDFs
 * and images), and stores searchable PostgreSQL full-text vectors cleanly separated from files.
 */
export function createIndexDocumentTextJobHandler(
  deps: IndexDocumentTextJobDependencies,
): IndexDocumentTextJobHandler {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const visibilityTimeoutMs = deps.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const nowFn = deps.now ?? (() => new Date());

  const skipAndMarkPublished = async (params: {
    readonly job: OutboxJobRecord;
    readonly documentId: string | null;
    readonly documentVersionId: string | null;
    readonly fileObjectId: string | null;
    readonly reason: string;
    readonly recordAudit?: boolean | undefined;
  }): Promise<IndexDocumentTextOutcome> => {
    await deps.transactions.runInTransaction(async (tx) => {
      await deps.outbox.markPublished(params.job.id, tx);
      if (params.recordAudit && params.fileObjectId) {
        await deps.audit.append(
          {
            organizationId: params.job.organizationId,
            actorUserId: null,
            action: "DOCUMENT_TEXT_INDEXING_SKIPPED",
            resourceType: "FILE_OBJECT",
            resourceId: params.fileObjectId,
            result: "SUCCESS",
            requestId: params.job.id,
            metadata: {
              outboxJobId: params.job.id,
              documentId: params.documentId,
              documentVersionId: params.documentVersionId,
              reason: params.reason,
            },
          },
          tx,
        );
      }
    });

    return {
      outcome: "SKIPPED",
      jobId: params.job.id,
      documentVersionId: params.documentVersionId,
      reason: params.reason,
    };
  };

  const deferOrFail = async (params: {
    readonly job: OutboxJobRecord;
    readonly documentVersionId: string;
    readonly diagnosticCode: string;
  }): Promise<IndexDocumentTextOutcome> => {
    const updated = await deps.outbox.scheduleRetryOrFail({
      jobId: params.job.id,
      attempts: params.job.attempts,
      maxAttempts,
      retryDelayMs,
      safeErrorSummary: params.diagnosticCode,
      now: nowFn(),
    });

    return {
      outcome: "DEFERRED",
      jobId: params.job.id,
      documentVersionId: params.documentVersionId,
      failedPermanently: updated?.status === "FAILED",
      diagnosticCode: params.diagnosticCode,
    };
  };

  const processClaimedJob = async (job: OutboxJobRecord): Promise<IndexDocumentTextOutcome> => {
    const parsedPayload = documentTextIndexingPayloadSchema.safeParse(job.payload);
    if (!parsedPayload.success) {
      return skipAndMarkPublished({
        job,
        documentId: null,
        documentVersionId: null,
        fileObjectId: null,
        reason: "INVALID_INDEXING_PAYLOAD",
      });
    }

    const payload = parsedPayload.data;

    if (!deps.policy.enabled) {
      return skipAndMarkPublished({
        job,
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        fileObjectId: payload.fileObjectId,
        reason: "EXTRACTION_DISABLED",
      });
    }

    const [doc, version, fileObject, connection] = await Promise.all([
      deps.documents.findById(payload.documentId),
      deps.documentVersions.findById(payload.documentVersionId),
      deps.uploads.findFileObjectById(payload.fileObjectId),
      deps.connections.findById(payload.storageConnectionId),
    ]);

    if (
      !doc ||
      doc.organizationId !== job.organizationId ||
      doc.status === "DELETED" ||
      !version ||
      version.documentId !== doc.id ||
      version.fileObjectId !== payload.fileObjectId ||
      !fileObject ||
      fileObject.status !== "AVAILABLE"
    ) {
      return skipAndMarkPublished({
        job,
        documentId: payload.documentId,
        documentVersionId: payload.documentVersionId,
        fileObjectId: payload.fileObjectId,
        reason: "DOCUMENT_OR_FILE_NOT_AVAILABLE",
      });
    }

    const category = await deps.categories.findById(doc.categoryId);
    if (
      !category ||
      category.organizationId !== job.organizationId ||
      category.textIndexingMode === "NEVER"
    ) {
      return skipAndMarkPublished({
        job,
        documentId: doc.id,
        documentVersionId: version.id,
        fileObjectId: fileObject.id,
        reason: "CATEGORY_POLICY_NEVER",
        recordAudit: true,
      });
    }

    if (
      !connection ||
      connection.organizationId !== job.organizationId ||
      connection.status !== "ACTIVE"
    ) {
      return deferOrFail({
        job,
        documentVersionId: version.id,
        diagnosticCode: "STORAGE_CONNECTION_UNAVAILABLE",
      });
    }

    try {
      const provider = await deps.storageRegistry.resolveProvider(connection);
      const download = await provider.getObject({ value: fileObject.objectKey });

      const result = await extractAndIndexDocumentVersionText({
        source: {
          kind: "stream",
          stream: download.body,
          mimeType: fileObject.detectedContentType,
          declaredSizeBytes: fileObject.sizeBytes,
        },
        organizationId: job.organizationId,
        documentId: doc.id,
        documentVersionId: version.id,
        fileObjectId: fileObject.id,
        policy: deps.policy,
        indexRepository: deps.indexRepository,
        ocrEngine: deps.ocrEngine,
      });

      if (result.extraction.status === "TIMED_OUT") {
        return deferOrFail({
          job,
          documentVersionId: version.id,
          diagnosticCode: "TEXT_EXTRACTION_TIMED_OUT",
        });
      }

      if (result.extraction.status !== "EXTRACTED" || !result.indexing.indexed) {
        return skipAndMarkPublished({
          job,
          documentId: doc.id,
          documentVersionId: version.id,
          fileObjectId: fileObject.id,
          reason: result.extraction.status,
          recordAudit: true,
        });
      }

      const extractionOutcome = result.extraction;
      const charCount = result.indexing.charCount;

      await deps.transactions.runInTransaction(async (tx) => {
        await deps.outbox.markPublished(job.id, tx);
        await deps.audit.append(
          {
            organizationId: job.organizationId,
            actorUserId: null,
            action: "DOCUMENT_TEXT_INDEXED",
            resourceType: "DOCUMENT",
            resourceId: doc.id,
            result: "SUCCESS",
            requestId: job.id,
            metadata: {
              outboxJobId: job.id,
              documentVersionId: version.id,
              fileObjectId: fileObject.id,
              extractorKind: extractionOutcome.extractorKind,
              charCount,
              truncated: extractionOutcome.truncated,
            },
          },
          tx,
        );
      });

      return {
        outcome: "INDEXED",
        jobId: job.id,
        documentVersionId: version.id,
        charCount,
      };
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        return skipAndMarkPublished({
          job,
          documentId: doc.id,
          documentVersionId: version.id,
          fileObjectId: fileObject.id,
          reason: "STORAGE_OBJECT_MISSING",
        });
      }

      const diagnosticCode =
        error instanceof StorageError
          ? `STORAGE_${error.code}`
          : error instanceof Error
            ? error.message.slice(0, 120)
            : "TEXT_INDEXING_ERROR";

      return deferOrFail({
        job,
        documentVersionId: version.id,
        diagnosticCode,
      });
    }
  };

  return {
    processClaimedJob,

    async processNextJob(): Promise<IndexDocumentTextOutcome> {
      const claimed = await deps.outbox.claimNextPending({
        eventType: DOCUMENT_TEXT_INDEXING_EVENT_TYPE,
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
