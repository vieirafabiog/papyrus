import type { TransactionContext } from "./transaction.port.js";

export interface PurgeCandidateRecord {
  readonly documentId: string;
  readonly organizationId: string;
}

export interface PurgeStorageDeletionTarget {
  readonly operationId: string;
  readonly organizationId: string;
  readonly documentId: string | null;
  readonly fileObjectId: string;
  readonly storageConnectionId: string;
  readonly objectKey: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export type ClaimPurgeDocumentOutcome =
  | {
      readonly status: "CLAIMED";
      readonly documentId: string;
      readonly organizationId: string;
      readonly categoryId: string;
      readonly applicablePolicyId: string | null;
      readonly deletionTargets: readonly PurgeStorageDeletionTarget[];
      readonly skippedReferencedFileObjectIds: readonly string[];
    }
  | {
      readonly status: "SKIPPED";
      readonly documentId: string;
      readonly reasons: readonly string[];
    };

export interface DocumentPurgeStorePort {
  listTrashCandidates(
    limit: number,
    tx?: TransactionContext,
  ): Promise<readonly PurgeCandidateRecord[]>;
  claimEligibleDeletedDocument(
    params: {
      readonly documentId: string;
      readonly referenceNow: Date;
      readonly fallbackTrashGraceDays: number;
      readonly maxAttempts: number;
      readonly generateId: () => string;
    },
    tx?: TransactionContext,
  ): Promise<ClaimPurgeDocumentOutcome>;
  claimPendingDeletionsForReconciliation(
    params: {
      readonly now: Date;
      readonly limit: number;
    },
    tx?: TransactionContext,
  ): Promise<readonly PurgeStorageDeletionTarget[]>;
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
