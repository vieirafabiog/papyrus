import {
  type AuditRepositoryPort,
  DEFAULT_TRASH_GRACE_DAYS,
  type DocumentPurgeStorePort,
  type PurgeStorageDeletionTarget,
  type StorageConnectionRepositoryPort,
  type TransactionManagerPort,
  createAuditWriter,
} from "@docuflow/domain";
import { type StorageProviderRegistry, sanitizeStorageErrorMessage } from "@docuflow/storage-core";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_DELETE_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_DELAY_MS = 60_000;

export interface PurgeDeletedDocumentsDependencies {
  readonly store: DocumentPurgeStorePort;
  readonly connections: StorageConnectionRepositoryPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly fallbackTrashGraceDays?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly maxDeleteAttempts?: number | undefined;
  readonly baseRetryDelayMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface SkippedPurgeCandidateSummary {
  readonly documentId: string;
  readonly reasons: readonly string[];
}

export interface PurgeDeletedDocumentsReport {
  readonly purgedDocumentIds: readonly string[];
  readonly skippedDocuments: readonly SkippedPurgeCandidateSummary[];
  readonly skippedReferencedFileObjectIds: readonly string[];
  readonly purgedFileObjectIds: readonly string[];
  readonly reconciledFileObjectIds: readonly string[];
  readonly deferredReconciliationIds: readonly string[];
  readonly failedReconciliationIds: readonly string[];
}

export interface PurgeDeletedDocumentsHandler {
  runPurgeCycle(): Promise<PurgeDeletedDocumentsReport>;
}

/**
 * Safely executes two-phase physical purge of deleted documents past their retention
 * and trash grace windows: verifies holds/state/references, removes logical document records
 * while keeping audit events, marks unreferenced objects as `DELETE_PENDING` in `storage_operations`,
 * deletes binaries from storage providers, and idempotently reconciles transient failures.
 */
export function createPurgeDeletedDocumentsHandler(
  deps: PurgeDeletedDocumentsDependencies,
): PurgeDeletedDocumentsHandler {
  const auditWriter = createAuditWriter({ repository: deps.audit });
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxDeleteAttempts = Math.max(1, deps.maxDeleteAttempts ?? DEFAULT_MAX_DELETE_ATTEMPTS);
  const baseRetryDelayMs = Math.max(100, deps.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS);
  const fallbackTrashGraceDays = deps.fallbackTrashGraceDays ?? DEFAULT_TRASH_GRACE_DAYS;
  const nowFn = deps.now ?? (() => new Date());

  const executeTargetsDeletion = async (
    targets: readonly PurgeStorageDeletionTarget[],
    isReconciliation: boolean,
    tracking: {
      purgedFileObjectIds: string[];
      reconciledFileObjectIds: string[];
      deferredReconciliationIds: string[];
      failedReconciliationIds: string[];
    },
  ): Promise<void> => {
    for (const target of targets) {
      const cycleRequestId = deps.generateId();
      try {
        const connection = await deps.connections.findById(target.storageConnectionId);
        if (!connection || connection.organizationId !== target.organizationId) {
          throw new Error("Conexão de armazenamento indisponível para expurgo físico.");
        }

        const provider = await deps.storageRegistry.resolveProvider(connection, {
          allowInactive: true,
        });
        await provider.deleteObject({ value: target.objectKey });

        await deps.transactions.runInTransaction(async (tx) => {
          await deps.store.markDeletionCompleted(
            {
              operationId: target.operationId,
              fileObjectId: target.fileObjectId,
              completedAt: nowFn(),
            },
            tx,
          );

          await auditWriter.write(
            {
              organizationId: target.organizationId,
              actorUserId: null,
              action: isReconciliation
                ? "DOCUMENT_FILE_PURGE_RECONCILED"
                : "DOCUMENT_FILE_PURGE_COMPLETED",
              resourceType: "FILE_OBJECT",
              resourceId: target.fileObjectId,
              result: "SUCCESS",
              requestId: cycleRequestId,
              metadata: {
                storageOperationId: target.operationId,
                storageConnectionId: target.storageConnectionId,
                attempts: target.attempts,
              },
            },
            tx,
          );
        });

        if (isReconciliation) {
          tracking.reconciledFileObjectIds.push(target.fileObjectId);
        } else {
          tracking.purgedFileObjectIds.push(target.fileObjectId);
        }
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const safeError = sanitizeStorageErrorMessage(rawMessage).slice(0, 500);
        const backoffMs = baseRetryDelayMs * 2 ** Math.max(0, target.attempts - 1);
        const nextAttemptAt = new Date(nowFn().getTime() + backoffMs);

        const outcome = await deps.transactions.runInTransaction(async (tx) => {
          const resultStatus = await deps.store.recordDeletionFailure(
            {
              operationId: target.operationId,
              attempts: target.attempts,
              maxAttempts: target.maxAttempts,
              lastError: safeError,
              nextAttemptAt: target.attempts >= target.maxAttempts ? null : nextAttemptAt,
            },
            tx,
          );

          await auditWriter.write(
            {
              organizationId: target.organizationId,
              actorUserId: null,
              action: "DOCUMENT_FILE_PURGE_FAILED",
              resourceType: "FILE_OBJECT",
              resourceId: target.fileObjectId,
              result: "FAILURE",
              requestId: cycleRequestId,
              metadata: {
                storageOperationId: target.operationId,
                storageConnectionId: target.storageConnectionId,
                attempts: target.attempts,
                maxAttempts: target.maxAttempts,
                reconciliationStatus: resultStatus,
              },
            },
            tx,
          );

          return resultStatus;
        });

        if (outcome === "FAILED") {
          tracking.failedReconciliationIds.push(target.operationId);
        } else {
          tracking.deferredReconciliationIds.push(target.operationId);
        }
      }
    }
  };

  return {
    async runPurgeCycle(): Promise<PurgeDeletedDocumentsReport> {
      const cycleNow = nowFn();
      const candidates = await deps.store.listTrashCandidates(batchSize);

      const purgedDocumentIds: string[] = [];
      const skippedDocuments: SkippedPurgeCandidateSummary[] = [];
      const skippedReferencedFileObjectIds: string[] = [];
      const newDeletionTargets: PurgeStorageDeletionTarget[] = [];

      for (const candidate of candidates) {
        const outcome = await deps.transactions.runInTransaction(async (tx) => {
          const claim = await deps.store.claimEligibleDeletedDocument(
            {
              documentId: candidate.documentId,
              referenceNow: cycleNow,
              fallbackTrashGraceDays,
              maxAttempts: maxDeleteAttempts,
              generateId: deps.generateId,
            },
            tx,
          );

          if (claim.status === "CLAIMED") {
            await auditWriter.write(
              {
                organizationId: claim.organizationId,
                actorUserId: null,
                action: "DOCUMENT_PURGED",
                resourceType: "DOCUMENT",
                resourceId: claim.documentId,
                result: "SUCCESS",
                requestId: deps.generateId(),
                metadata: {
                  categoryId: claim.categoryId,
                  applicablePolicyId: claim.applicablePolicyId,
                  scheduledFileObjectCount: claim.deletionTargets.length,
                  preservedReferencedFileObjectCount: claim.skippedReferencedFileObjectIds.length,
                },
              },
              tx,
            );
          }

          return claim;
        });

        if (outcome.status === "CLAIMED") {
          purgedDocumentIds.push(outcome.documentId);
          newDeletionTargets.push(...outcome.deletionTargets);
          skippedReferencedFileObjectIds.push(...outcome.skippedReferencedFileObjectIds);
        } else {
          skippedDocuments.push({
            documentId: outcome.documentId,
            reasons: outcome.reasons,
          });
        }
      }

      const tracking = {
        purgedFileObjectIds: [] as string[],
        reconciledFileObjectIds: [] as string[],
        deferredReconciliationIds: [] as string[],
        failedReconciliationIds: [] as string[],
      };

      await executeTargetsDeletion(newDeletionTargets, false, tracking);

      const pendingReconciliations = await deps.transactions.runInTransaction(async (tx) => {
        return deps.store.claimPendingDeletionsForReconciliation(
          {
            now: cycleNow,
            limit: batchSize,
          },
          tx,
        );
      });

      await executeTargetsDeletion(pendingReconciliations, true, tracking);

      return {
        purgedDocumentIds,
        skippedDocuments,
        skippedReferencedFileObjectIds,
        purgedFileObjectIds: tracking.purgedFileObjectIds,
        reconciledFileObjectIds: tracking.reconciledFileObjectIds,
        deferredReconciliationIds: tracking.deferredReconciliationIds,
        failedReconciliationIds: tracking.failedReconciliationIds,
      };
    },
  };
}
