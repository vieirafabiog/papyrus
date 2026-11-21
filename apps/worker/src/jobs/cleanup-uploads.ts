import type {
  AuditRepositoryPort,
  StorageConnectionRepositoryPort,
  TransactionContext,
  TransactionManagerPort,
} from "@docuflow/domain";
import { type StorageProviderRegistry, sanitizeStorageErrorMessage } from "@docuflow/storage-core";

const DEFAULT_SAFETY_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_DELETE_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_DELAY_MS = 60_000;

export interface ExpiredUploadSessionRecord {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly fileObjectId: string;
  readonly previousStatus: "PENDING" | "UPLOADED";
}

export interface CleanupDeletionTarget {
  readonly operationId: string;
  readonly organizationId: string;
  readonly uploadSessionId: string | null;
  readonly fileObjectId: string;
  readonly storageConnectionId: string;
  readonly objectKey: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface AbandonedUploadCleanupStorePort {
  expireIncompleteSessions(
    cutoffAt: Date,
    limit: number,
    tx?: TransactionContext,
  ): Promise<readonly ExpiredUploadSessionRecord[]>;
  /**
   * Transitions abandoned temporary objects past the safety window (`expiresAt <= abandonedBefore`
   * for `EXPIRED`, `updatedAt <= abandonedBefore` for `CANCELLED`/`FAILED`) to `DELETE_PENDING`
   * and inserts pending/in-progress `DELETE` records in `storage_operations`.
   */
  claimAbandonedTempObjects(
    params: {
      readonly abandonedBefore: Date;
      readonly limit: number;
      readonly maxAttempts: number;
      readonly now: Date;
    },
    tx?: TransactionContext,
  ): Promise<readonly CleanupDeletionTarget[]>;
  claimPendingDeletionsForReconciliation(
    params: {
      readonly now: Date;
      readonly limit: number;
    },
    tx?: TransactionContext,
  ): Promise<readonly CleanupDeletionTarget[]>;
  markDeletionCompleted(
    params: {
      readonly operationId: string;
      readonly fileObjectId: string;
      readonly completedAt: Date;
    },
    tx?: TransactionContext,
  ): Promise<void>;
  recordDeletionFailure(
    params: {
      readonly operationId: string;
      readonly attempts: number;
      readonly maxAttempts: number;
      readonly lastError: string;
      readonly nextAttemptAt: Date | null;
    },
    tx?: TransactionContext,
  ): Promise<"PENDING_RETRY" | "FAILED">;
}

export interface CleanupUploadsDependencies {
  readonly store: AbandonedUploadCleanupStorePort;
  readonly connections: StorageConnectionRepositoryPort;
  readonly storageRegistry: StorageProviderRegistry;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly safetyWindowMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly maxDeleteAttempts?: number | undefined;
  readonly baseRetryDelayMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface CleanupUploadsReport {
  readonly expiredSessionIds: readonly string[];
  readonly purgedFileObjectIds: readonly string[];
  readonly reconciledFileObjectIds: readonly string[];
  readonly deferredReconciliationIds: readonly string[];
  readonly failedReconciliationIds: readonly string[];
}

export interface CleanupAbandonedUploadsHandler {
  runCleanupCycle(): Promise<CleanupUploadsReport>;
}

/**
 * Expires incomplete upload sessions, deletes abandoned temporary objects only after a
 * configurable safety window using `DELETE_PENDING` + persisted `storage_operations`, and
 * reconciles any failed removals idempotently.
 */
export function createCleanupAbandonedUploadsHandler(
  deps: CleanupUploadsDependencies,
): CleanupAbandonedUploadsHandler {
  const safetyWindowMs = Math.max(0, deps.safetyWindowMs ?? DEFAULT_SAFETY_WINDOW_MS);
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxDeleteAttempts = Math.max(1, deps.maxDeleteAttempts ?? DEFAULT_MAX_DELETE_ATTEMPTS);
  const baseRetryDelayMs = Math.max(100, deps.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS);
  const nowFn = deps.now ?? (() => new Date());

  const executeTargetsDeletion = async (
    targets: readonly CleanupDeletionTarget[],
    isReconciliation: boolean,
    report: {
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
          throw new Error("Conexão de armazenamento indisponível para exclusão temporária.");
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

          await deps.audit.append(
            {
              organizationId: target.organizationId,
              actorUserId: null,
              action: isReconciliation
                ? "ABANDONED_UPLOAD_RECONCILED_DELETE"
                : "ABANDONED_UPLOAD_TEMP_PURGED",
              resourceType: "FILE_OBJECT",
              resourceId: target.fileObjectId,
              result: "SUCCESS",
              requestId: cycleRequestId,
              metadata: {
                storageOperationId: target.operationId,
                storageConnectionId: target.storageConnectionId,
                uploadSessionId: target.uploadSessionId,
              },
            },
            tx,
          );
        });

        if (isReconciliation) {
          report.reconciledFileObjectIds.push(target.fileObjectId);
        } else {
          report.purgedFileObjectIds.push(target.fileObjectId);
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

          await deps.audit.append(
            {
              organizationId: target.organizationId,
              actorUserId: null,
              action: "ABANDONED_UPLOAD_DELETE_FAILED",
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
          report.failedReconciliationIds.push(target.operationId);
        } else {
          report.deferredReconciliationIds.push(target.operationId);
        }
      }
    }
  };

  return {
    async runCleanupCycle(): Promise<CleanupUploadsReport> {
      const cycleNow = nowFn();
      const expiredSessionIds: string[] = [];

      // 1. Expire incomplete sessions past their deadline without deleting objects prematurely
      const expiredSessions = await deps.transactions.runInTransaction(async (tx) => {
        const expired = await deps.store.expireIncompleteSessions(cycleNow, batchSize, tx);
        for (const item of expired) {
          await deps.audit.append(
            {
              organizationId: item.organizationId,
              actorUserId: null,
              action: "UPLOAD_SESSION_EXPIRED",
              resourceType: "UPLOAD_SESSION",
              resourceId: item.sessionId,
              result: "SUCCESS",
              requestId: deps.generateId(),
              metadata: {
                previousStatus: item.previousStatus,
                fileObjectId: item.fileObjectId,
              },
            },
            tx,
          );
        }
        return expired;
      });

      for (const item of expiredSessions) {
        expiredSessionIds.push(item.sessionId);
      }

      const tracking = {
        purgedFileObjectIds: [] as string[],
        reconciledFileObjectIds: [] as string[],
        deferredReconciliationIds: [] as string[],
        failedReconciliationIds: [] as string[],
      };

      // 2. Claim abandoned temporary objects older than safetyWindowMs -> DELETE_PENDING
      const abandonedBefore = new Date(cycleNow.getTime() - safetyWindowMs);
      const abandonedTargets = await deps.transactions.runInTransaction(async (tx) => {
        return deps.store.claimAbandonedTempObjects(
          {
            abandonedBefore,
            limit: batchSize,
            maxAttempts: maxDeleteAttempts,
            now: cycleNow,
          },
          tx,
        );
      });

      await executeTargetsDeletion(abandonedTargets, false, tracking);

      // 3. Reconcile failed removals queued for retry
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
        expiredSessionIds,
        purgedFileObjectIds: tracking.purgedFileObjectIds,
        reconciledFileObjectIds: tracking.reconciledFileObjectIds,
        deferredReconciliationIds: tracking.deferredReconciliationIds,
        failedReconciliationIds: tracking.failedReconciliationIds,
      };
    },
  };
}
