import type {
  DocumentTextIndexingEnqueueInput,
  DocumentTextIndexingQueuePort,
  TransactionContext,
  UploadProcessingEnqueueInput,
  UploadProcessingQueuePort,
} from "@papyrus/domain";
import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { outboxEvents } from "../schema/governance.js";
import { resolveDbExecutor } from "./transaction-manager.js";

export const UPLOAD_PROCESSING_EVENT_TYPE = "UPLOAD_PROCESSING_REQUESTED" as const;
export const DOCUMENT_TEXT_INDEXING_EVENT_TYPE = "DOCUMENT_TEXT_INDEXING_REQUESTED" as const;

export interface OutboxJobRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: "PENDING" | "PUBLISHED" | "FAILED";
  readonly attempts: number;
  readonly availableAt: string;
  readonly publishedAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface EnqueueOutboxEventInput {
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly availableAt?: Date | undefined;
}

export interface ClaimOutboxJobOptions {
  readonly eventType: string;
  readonly maxAttempts: number;
  readonly visibilityTimeoutMs: number;
  readonly now?: Date | undefined;
}

export interface RetryOrFailOutboxJobInput {
  readonly jobId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly safeErrorSummary: string;
  readonly now?: Date | undefined;
}

export interface OutboxRepository {
  enqueue(input: EnqueueOutboxEventInput, tx?: TransactionContext): Promise<OutboxJobRecord>;
  claimNextPending(options: ClaimOutboxJobOptions): Promise<OutboxJobRecord | null>;
  markPublished(jobId: string, tx?: TransactionContext): Promise<void>;
  scheduleRetryOrFail(
    input: RetryOrFailOutboxJobInput,
    tx?: TransactionContext,
  ): Promise<OutboxJobRecord | null>;
  asUploadProcessingQueue(): UploadProcessingQueuePort;
  asDocumentTextIndexingQueue(): DocumentTextIndexingQueuePort;
}

function toOutboxJobRecord(row: typeof outboxEvents.$inferSelect): OutboxJobRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    eventType: row.eventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.availableAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Provides persistent transactional outbox enqueueing and PostgreSQL `FOR UPDATE SKIP LOCKED`
 * job claiming with lease timeouts, bounded retries, and explicit terminal failures.
 */
export function createOutboxRepository(db: NodePgDatabase): OutboxRepository {
  const enqueueImpl = async (
    input: EnqueueOutboxEventInput,
    tx?: TransactionContext,
  ): Promise<OutboxJobRecord> => {
    const executor = resolveDbExecutor(db, tx);
    const mutablePayload: Record<string, unknown> = { ...input.payload };
    const [inserted] = await executor
      .insert(outboxEvents)
      .values({
        organizationId: input.organizationId,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: mutablePayload,
        status: "PENDING",
        attempts: 0,
        availableAt: input.availableAt ?? new Date(),
      })
      .returning();

    if (!inserted) {
      throw new Error("Failed to enqueue outbox event record.");
    }
    return toOutboxJobRecord(inserted);
  };

  return {
    enqueue: enqueueImpl,

    async claimNextPending(options: ClaimOutboxJobOptions): Promise<OutboxJobRecord | null> {
      const now = options.now ?? new Date();
      const leaseUntil = new Date(now.getTime() + Math.max(1_000, options.visibilityTimeoutMs));

      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.eventType, options.eventType),
              eq(outboxEvents.status, "PENDING"),
              lte(outboxEvents.availableAt, now),
              lt(outboxEvents.attempts, options.maxAttempts),
            ),
          )
          .orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });

        if (!candidate) {
          return null;
        }

        const [claimed] = await tx
          .update(outboxEvents)
          .set({
            attempts: sql`${outboxEvents.attempts} + 1`,
            availableAt: leaseUntil,
          })
          .where(eq(outboxEvents.id, candidate.id))
          .returning();

        return claimed ? toOutboxJobRecord(claimed) : null;
      });
    },

    async markPublished(jobId: string, tx?: TransactionContext): Promise<void> {
      const executor = resolveDbExecutor(db, tx);
      await executor
        .update(outboxEvents)
        .set({
          status: "PUBLISHED",
          publishedAt: new Date(),
          lastError: null,
        })
        .where(eq(outboxEvents.id, jobId));
    },

    async scheduleRetryOrFail(
      input: RetryOrFailOutboxJobInput,
      tx?: TransactionContext,
    ): Promise<OutboxJobRecord | null> {
      const executor = resolveDbExecutor(db, tx);
      const now = input.now ?? new Date();
      const sanitizedError = input.safeErrorSummary.trim().slice(0, 500);
      const exhausted = input.attempts >= input.maxAttempts;

      const [updated] = await executor
        .update(outboxEvents)
        .set({
          status: exhausted ? "FAILED" : "PENDING",
          availableAt: exhausted
            ? now
            : new Date(now.getTime() + Math.max(100, input.retryDelayMs)),
          lastError: sanitizedError.length > 0 ? sanitizedError : "WORKER_EXECUTION_ERROR",
        })
        .where(eq(outboxEvents.id, input.jobId))
        .returning();

      return updated ? toOutboxJobRecord(updated) : null;
    },

    asUploadProcessingQueue(): UploadProcessingQueuePort {
      return {
        async enqueueProcessing(
          input: UploadProcessingEnqueueInput,
          tx?: TransactionContext,
        ): Promise<void> {
          await enqueueImpl(
            {
              organizationId: input.organizationId,
              eventType: UPLOAD_PROCESSING_EVENT_TYPE,
              aggregateType: "UPLOAD_SESSION",
              aggregateId: input.uploadSessionId,
              payload: {
                uploadSessionId: input.uploadSessionId,
                fileObjectId: input.fileObjectId,
                storageConnectionId: input.storageConnectionId,
                documentId: input.documentId,
                documentVersionId: input.documentVersionId,
                ...(input.indexContent !== undefined ? { indexContent: input.indexContent } : {}),
              },
            },
            tx,
          );
        },
      };
    },

    asDocumentTextIndexingQueue(): DocumentTextIndexingQueuePort {
      return {
        async enqueueIndexing(
          input: DocumentTextIndexingEnqueueInput,
          tx?: TransactionContext,
        ): Promise<void> {
          await enqueueImpl(
            {
              organizationId: input.organizationId,
              eventType: DOCUMENT_TEXT_INDEXING_EVENT_TYPE,
              aggregateType: "DOCUMENT_VERSION",
              aggregateId: input.documentVersionId,
              payload: {
                documentId: input.documentId,
                documentVersionId: input.documentVersionId,
                fileObjectId: input.fileObjectId,
                storageConnectionId: input.storageConnectionId,
              },
            },
            tx,
          );
        },
      };
    },
  };
}
