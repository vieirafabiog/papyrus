export const RETENTION_ACTIONS = ["ARCHIVE", "TRASH", "PURGE"] as const;

export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

export interface RetentionPolicyEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly retentionDays: number;
  readonly trashGraceDays: number;
  readonly actionOnExpiry: RetentionAction;
  readonly isActive: boolean;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentRetentionHoldEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly reason: string;
  readonly placedByUserId: string;
  readonly placedAt: string;
  readonly releasedByUserId: string | null;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
}

export const PURGE_BLOCK_REASONS = [
  "DOCUMENT_NOT_FOUND",
  "NOT_IN_TRASH",
  "ACTIVE_HOLD",
  "TRASH_GRACE_WINDOW_NOT_ELAPSED",
  "RETENTION_WINDOW_NOT_ELAPSED",
] as const;

export type PurgeBlockReason = (typeof PURGE_BLOCK_REASONS)[number];

export interface PurgeEligibilityEvaluation {
  readonly eligible: boolean;
  readonly blockReasons: readonly PurgeBlockReason[];
  readonly activeHoldCount: number;
  readonly applicablePolicyId: string | null;
  readonly trashGraceEndsAt: string | null;
  readonly retentionEndsAt: string | null;
}
