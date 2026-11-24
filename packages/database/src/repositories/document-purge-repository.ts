import {
  type ClaimPurgeDocumentOutcome,
  type DocumentEntity,
  type DocumentMetadataMap,
  type DocumentPurgeStorePort,
  type DocumentRetentionHoldEntity,
  type PurgeCandidateRecord,
  type PurgeStorageDeletionTarget,
  type RetentionPolicyEntity,
  type TransactionContext,
  evaluateDocumentPurgeEligibility,
  selectApplicableRetentionPolicy,
} from "@papyrus/domain";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  documentExtractedTexts,
  documentMetadata,
  documentTags,
  documentVersions,
  documents,
} from "../schema/documents.js";
import { documentRetentionHolds, retentionPolicies } from "../schema/governance.js";
import { fileObjects, storageOperations, uploadSessions } from "../schema/storage.js";
import { workflowDecisions, workflowInstances, workflowTasks } from "../schema/workflows.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toDocumentEntity(row: typeof documents.$inferSelect): DocumentEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    categoryId: row.categoryId,
    folderId: row.folderId,
    status: row.status,
    currentVersionId: row.currentVersionId,
    ownerUserId: row.ownerUserId,
    issueDate: row.issueDate,
    expirationDate: row.expirationDate,
    metadata: row.metadata as DocumentMetadataMap,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRetentionPolicyEntity(
  row: typeof retentionPolicies.$inferSelect,
): RetentionPolicyEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    categoryId: row.categoryId,
    name: row.name,
    retentionDays: row.retentionDays,
    trashGraceDays: row.trashGraceDays,
    actionOnExpiry: row.actionOnExpiry,
    isActive: row.isActive,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocumentRetentionHoldEntity(
  row: typeof documentRetentionHolds.$inferSelect,
): DocumentRetentionHoldEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    documentId: row.documentId,
    reason: row.reason,
    placedByUserId: row.placedByUserId,
    placedAt: row.placedAt.toISOString(),
    releasedByUserId: row.releasedByUserId,
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    releaseReason: row.releaseReason,
  };
}

/**
 * PostgreSQL store for safe physical purge of deleted documents:
 * locks candidate rows `FOR UPDATE`, verifies state, active holds, retention windows,
 * workflow/object references, cleans document records while preserving audit logs,
 * and transitions unreferenced objects to `DELETE_PENDING` + `storage_operations`.
 */
export function createDocumentPurgeRepository(db: NodePgDatabase): DocumentPurgeStorePort {
  return {
    async listTrashCandidates(
      limit: number,
      tx?: TransactionContext,
    ): Promise<readonly PurgeCandidateRecord[]> {
      const executor = resolveDbExecutor(db, tx);
      const rows = await executor
        .select({
          documentId: documents.id,
          organizationId: documents.organizationId,
        })
        .from(documents)
        .where(and(eq(documents.status, "DELETED"), sql`${documents.deletedAt} IS NOT NULL`))
        .orderBy(asc(documents.deletedAt), asc(documents.id))
        .limit(limit);

      return rows;
    },

    async claimEligibleDeletedDocument(
      params: {
        readonly documentId: string;
        readonly referenceNow: Date;
        readonly fallbackTrashGraceDays: number;
        readonly maxAttempts: number;
        readonly generateId: () => string;
      },
      tx?: TransactionContext,
    ): Promise<ClaimPurgeDocumentOutcome> {
      const executor = resolveDbExecutor(db, tx);

      const [lockedDoc] = await executor
        .select()
        .from(documents)
        .where(eq(documents.id, params.documentId))
        .for("update");

      if (!lockedDoc) {
        return {
          status: "SKIPPED",
          documentId: params.documentId,
          reasons: ["DOCUMENT_NOT_FOUND"],
        };
      }

      if (lockedDoc.status !== "DELETED" || lockedDoc.deletedAt === null) {
        return {
          status: "SKIPPED",
          documentId: lockedDoc.id,
          reasons: ["NOT_IN_TRASH"],
        };
      }

      const activeHoldRows = await executor
        .select()
        .from(documentRetentionHolds)
        .where(
          and(
            eq(documentRetentionHolds.organizationId, lockedDoc.organizationId),
            eq(documentRetentionHolds.documentId, lockedDoc.id),
            isNull(documentRetentionHolds.releasedAt),
          ),
        );

      const orgPolicyRows = await executor
        .select()
        .from(retentionPolicies)
        .where(
          and(
            eq(retentionPolicies.organizationId, lockedDoc.organizationId),
            eq(retentionPolicies.isActive, true),
          ),
        )
        .orderBy(asc(retentionPolicies.createdAt), asc(retentionPolicies.id));

      const activeWorkflowRow = await executor
        .select({ id: workflowInstances.id })
        .from(workflowInstances)
        .where(
          and(
            eq(workflowInstances.documentId, lockedDoc.id),
            eq(workflowInstances.status, "ACTIVE"),
          ),
        )
        .limit(1);

      const pendingTaskRow = await executor
        .select({ id: workflowTasks.id })
        .from(workflowTasks)
        .where(and(eq(workflowTasks.documentId, lockedDoc.id), eq(workflowTasks.status, "PENDING")))
        .limit(1);

      const applicablePolicy = selectApplicableRetentionPolicy(
        orgPolicyRows.map(toRetentionPolicyEntity),
        lockedDoc.categoryId,
      );

      const evaluation = evaluateDocumentPurgeEligibility({
        document: toDocumentEntity(lockedDoc),
        deletedAt: lockedDoc.deletedAt,
        activeHolds: activeHoldRows.map(toDocumentRetentionHoldEntity),
        policy: applicablePolicy,
        referenceNow: params.referenceNow,
        fallbackTrashGraceDays: params.fallbackTrashGraceDays,
      });

      const reasons: string[] = [...evaluation.blockReasons];
      if (activeWorkflowRow.length > 0 || pendingTaskRow.length > 0) {
        reasons.push("ACTIVE_WORKFLOW_REFERENCE");
      }

      if (!evaluation.eligible || activeWorkflowRow.length > 0 || pendingTaskRow.length > 0) {
        return {
          status: "SKIPPED",
          documentId: lockedDoc.id,
          reasons,
        };
      }

      const versionRows = await executor
        .select({
          id: documentVersions.id,
          fileObjectId: documentVersions.fileObjectId,
        })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, lockedDoc.id));

      const distinctFileObjectIds = Array.from(
        new Set(versionRows.map((version) => version.fileObjectId)),
      );

      // Break circular documents.current_version_id FK before cleaning child rows
      if (lockedDoc.currentVersionId !== null) {
        await executor
          .update(documents)
          .set({ currentVersionId: null, updatedAt: params.referenceNow })
          .where(eq(documents.id, lockedDoc.id));
      }

      const taskRows = await executor
        .select({ id: workflowTasks.id })
        .from(workflowTasks)
        .where(eq(workflowTasks.documentId, lockedDoc.id));

      const taskIds = taskRows.map((task) => task.id);
      if (taskIds.length > 0) {
        await executor.delete(workflowDecisions).where(inArray(workflowDecisions.taskId, taskIds));
      }
      await executor.delete(workflowTasks).where(eq(workflowTasks.documentId, lockedDoc.id));
      await executor
        .delete(workflowInstances)
        .where(eq(workflowInstances.documentId, lockedDoc.id));

      await executor
        .delete(documentExtractedTexts)
        .where(eq(documentExtractedTexts.documentId, lockedDoc.id));
      await executor.delete(documentMetadata).where(eq(documentMetadata.documentId, lockedDoc.id));
      await executor.delete(documentTags).where(eq(documentTags.documentId, lockedDoc.id));
      await executor
        .delete(documentRetentionHolds)
        .where(eq(documentRetentionHolds.documentId, lockedDoc.id));
      await executor.delete(documentVersions).where(eq(documentVersions.documentId, lockedDoc.id));
      await executor.delete(documents).where(eq(documents.id, lockedDoc.id));

      const deletionTargets: PurgeStorageDeletionTarget[] = [];
      const skippedReferencedFileObjectIds: string[] = [];

      for (const fileObjectId of distinctFileObjectIds) {
        const [lockedFileObj] = await executor
          .select()
          .from(fileObjects)
          .where(eq(fileObjects.id, fileObjectId))
          .for("update");

        if (!lockedFileObj || lockedFileObj.status === "MISSING") {
          continue;
        }

        const otherVersionRef = await executor
          .select({ id: documentVersions.id })
          .from(documentVersions)
          .where(eq(documentVersions.fileObjectId, fileObjectId))
          .limit(1);

        const extractedTextRef = await executor
          .select({ id: documentExtractedTexts.id })
          .from(documentExtractedTexts)
          .where(eq(documentExtractedTexts.fileObjectId, fileObjectId))
          .limit(1);

        const activeSessionRef = await executor
          .select({ id: uploadSessions.id })
          .from(uploadSessions)
          .where(
            and(
              eq(uploadSessions.fileObjectId, fileObjectId),
              inArray(uploadSessions.status, ["PENDING", "UPLOADED"]),
            ),
          )
          .limit(1);

        const openDeleteOpRef = await executor
          .select({ id: storageOperations.id })
          .from(storageOperations)
          .where(
            and(
              eq(storageOperations.fileObjectId, fileObjectId),
              eq(storageOperations.operationType, "DELETE"),
              inArray(storageOperations.status, ["PENDING", "IN_PROGRESS"]),
            ),
          )
          .limit(1);

        if (
          otherVersionRef.length > 0 ||
          extractedTextRef.length > 0 ||
          activeSessionRef.length > 0 ||
          openDeleteOpRef.length > 0
        ) {
          skippedReferencedFileObjectIds.push(fileObjectId);
          continue;
        }

        await executor
          .update(fileObjects)
          .set({
            status: "DELETE_PENDING",
            updatedAt: params.referenceNow,
          })
          .where(eq(fileObjects.id, fileObjectId));

        const operationId = params.generateId();
        await executor.insert(storageOperations).values({
          id: operationId,
          organizationId: lockedDoc.organizationId,
          fileObjectId,
          storageConnectionId: lockedFileObj.storageConnectionId,
          operationType: "DELETE",
          status: "IN_PROGRESS",
          attempts: 1,
          maxAttempts: params.maxAttempts,
          createdAt: params.referenceNow,
          updatedAt: params.referenceNow,
        });

        deletionTargets.push({
          operationId,
          organizationId: lockedDoc.organizationId,
          documentId: lockedDoc.id,
          fileObjectId,
          storageConnectionId: lockedFileObj.storageConnectionId,
          objectKey: lockedFileObj.objectKey,
          attempts: 1,
          maxAttempts: params.maxAttempts,
        });
      }

      return {
        status: "CLAIMED",
        documentId: lockedDoc.id,
        organizationId: lockedDoc.organizationId,
        categoryId: lockedDoc.categoryId,
        applicablePolicyId: applicablePolicy?.id ?? null,
        deletionTargets,
        skippedReferencedFileObjectIds,
      };
    },

    async claimPendingDeletionsForReconciliation(
      params: {
        readonly now: Date;
        readonly limit: number;
      },
      tx?: TransactionContext,
    ): Promise<readonly PurgeStorageDeletionTarget[]> {
      const executor = resolveDbExecutor(db, tx);

      const candidateOps = await executor
        .select({
          operationId: storageOperations.id,
          organizationId: storageOperations.organizationId,
          fileObjectId: storageOperations.fileObjectId,
          storageConnectionId: storageOperations.storageConnectionId,
          objectKey: fileObjects.objectKey,
          attempts: storageOperations.attempts,
          maxAttempts: storageOperations.maxAttempts,
        })
        .from(storageOperations)
        .innerJoin(fileObjects, eq(fileObjects.id, storageOperations.fileObjectId))
        .where(
          and(
            eq(storageOperations.operationType, "DELETE"),
            eq(storageOperations.status, "PENDING"),
            eq(fileObjects.status, "DELETE_PENDING"),
            sql`${storageOperations.attempts} < ${storageOperations.maxAttempts}`,
            or(
              isNull(storageOperations.nextAttemptAt),
              lte(storageOperations.nextAttemptAt, params.now),
            ),
            sql`NOT EXISTS (
              SELECT 1 FROM ${uploadSessions}
              WHERE ${uploadSessions.fileObjectId} = ${fileObjects.id}
                AND ${uploadSessions.status} IN ('EXPIRED', 'CANCELLED', 'FAILED')
            )`,
          ),
        )
        .orderBy(asc(storageOperations.createdAt), asc(storageOperations.id))
        .limit(params.limit)
        .for("update", { of: storageOperations });

      const claimed: PurgeStorageDeletionTarget[] = [];
      for (const op of candidateOps) {
        const nextAttempts = op.attempts + 1;
        await executor
          .update(storageOperations)
          .set({
            status: "IN_PROGRESS",
            attempts: nextAttempts,
            updatedAt: params.now,
          })
          .where(eq(storageOperations.id, op.operationId));

        claimed.push({
          operationId: op.operationId,
          organizationId: op.organizationId,
          documentId: null,
          fileObjectId: op.fileObjectId,
          storageConnectionId: op.storageConnectionId,
          objectKey: op.objectKey,
          attempts: nextAttempts,
          maxAttempts: op.maxAttempts,
        });
      }

      return claimed;
    },

    async markDeletionCompleted(
      params: {
        readonly operationId: string;
        readonly fileObjectId: string;
        readonly completedAt: Date;
      },
      tx?: TransactionContext,
    ): Promise<void> {
      const executor = resolveDbExecutor(db, tx);

      await executor
        .update(storageOperations)
        .set({
          status: "COMPLETED",
          completedAt: params.completedAt,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: params.completedAt,
        })
        .where(eq(storageOperations.id, params.operationId));

      await executor
        .update(fileObjects)
        .set({
          status: "MISSING",
          updatedAt: params.completedAt,
        })
        .where(eq(fileObjects.id, params.fileObjectId));
    },

    async recordDeletionFailure(
      params: {
        readonly operationId: string;
        readonly attempts: number;
        readonly maxAttempts: number;
        readonly lastError: string;
        readonly nextAttemptAt: Date | null;
      },
      tx?: TransactionContext,
    ): Promise<"PENDING_RETRY" | "FAILED"> {
      const executor = resolveDbExecutor(db, tx);
      const exhausted = params.attempts >= params.maxAttempts;
      const now = new Date();

      await executor
        .update(storageOperations)
        .set({
          status: exhausted ? "FAILED" : "PENDING",
          lastError: params.lastError.slice(0, 500),
          nextAttemptAt: exhausted ? null : params.nextAttemptAt,
          updatedAt: now,
        })
        .where(eq(storageOperations.id, params.operationId));

      return exhausted ? "FAILED" : "PENDING_RETRY";
    },
  };
}
