import type {
  CreateUploadSessionWithFileObjectInput,
  CreatedUploadSessionRecords,
  FileObjectEntity,
  FinalizeUploadToQuarantineInput,
  MarkFileObjectProcessedInput,
  MarkUploadReceivedInput,
  TransactionContext,
  UploadSessionEntity,
  UploadSessionRepositoryPort,
  UploadSessionStatus,
} from "@docuflow/domain";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { fileObjects, uploadSessions } from "../schema/storage.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toUploadSessionEntity(row: typeof uploadSessions.$inferSelect): UploadSessionEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    storageConnectionId: row.storageConnectionId,
    fileObjectId: row.fileObjectId,
    declaredSizeBytes: row.declaredSizeBytes,
    declaredContentType: row.declaredContentType,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toFileObjectEntity(row: typeof fileObjects.$inferSelect): FileObjectEntity {
  return {
    id: row.id,
    storageConnectionId: row.storageConnectionId,
    objectKey: row.objectKey,
    originalFileName: row.originalFileName,
    detectedContentType: row.detectedContentType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createUploadSessionRepository(db: NodePgDatabase): UploadSessionRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<UploadSessionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, id))
        .limit(1);
      return row ? toUploadSessionEntity(row) : null;
    },

    async findByIdempotencyKey(
      organizationId: string,
      userId: string,
      idempotencyKey: string,
      tx?: TransactionContext,
    ): Promise<UploadSessionEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.organizationId, organizationId),
            eq(uploadSessions.userId, userId),
            eq(uploadSessions.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      return row ? toUploadSessionEntity(row) : null;
    },

    async findFileObjectById(
      fileObjectId: string,
      tx?: TransactionContext,
    ): Promise<FileObjectEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(fileObjects)
        .where(eq(fileObjects.id, fileObjectId))
        .limit(1);
      return row ? toFileObjectEntity(row) : null;
    },

    async createSessionWithFileObject(
      input: CreateUploadSessionWithFileObjectInput,
      tx?: TransactionContext,
    ): Promise<CreatedUploadSessionRecords> {
      const executor = resolveDbExecutor(db, tx);

      const [fileObjectRow] = await executor
        .insert(fileObjects)
        .values({
          id: input.fileObjectId,
          organizationId: input.organizationId,
          storageConnectionId: input.storageConnectionId,
          objectKey: input.objectKey,
          originalFileName: input.originalFileName,
          detectedContentType: input.declaredContentType,
          sizeBytes: input.declaredSizeBytes,
          checksumSha256: input.checksumSha256,
          status: "UPLOADING",
        })
        .returning();

      if (!fileObjectRow) {
        throw new Error("Failed to insert initial file object record.");
      }

      const [sessionRow] = await executor
        .insert(uploadSessions)
        .values({
          id: input.sessionId,
          organizationId: input.organizationId,
          userId: input.userId,
          storageConnectionId: input.storageConnectionId,
          fileObjectId: fileObjectRow.id,
          declaredSizeBytes: input.declaredSizeBytes,
          declaredContentType: input.declaredContentType,
          idempotencyKey: input.idempotencyKey,
          status: "PENDING",
          expiresAt: input.expiresAt,
        })
        .returning();

      if (!sessionRow) {
        throw new Error("Failed to insert upload session record.");
      }

      return {
        session: toUploadSessionEntity(sessionRow),
        fileObject: toFileObjectEntity(fileObjectRow),
      };
    },

    async markUploadReceived(
      input: MarkUploadReceivedInput,
      tx?: TransactionContext,
    ): Promise<CreatedUploadSessionRecords | null> {
      return transitionSessionAndFileObject(resolveDbExecutor(db, tx), {
        sessionId: input.sessionId,
        allowedStatuses: ["PENDING"],
        nextSessionStatus: "UPLOADED",
        fileObjectId: input.fileObjectId,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
      });
    },

    async finalizeToQuarantine(
      input: FinalizeUploadToQuarantineInput,
      tx?: TransactionContext,
    ): Promise<CreatedUploadSessionRecords | null> {
      return transitionSessionAndFileObject(resolveDbExecutor(db, tx), {
        sessionId: input.sessionId,
        allowedStatuses: ["PENDING", "UPLOADED"],
        nextSessionStatus: "FINALIZED",
        finalizedAt: input.finalizedAt,
        fileObjectId: input.fileObjectId,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        nextFileObjectStatus: "QUARANTINED",
      });
    },

    async markSessionExpired(sessionId: string, tx?: TransactionContext): Promise<void> {
      const executor = resolveDbExecutor(db, tx);
      await executor
        .update(uploadSessions)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.status, "PENDING")));
    },

    async markFileObjectProcessed(
      input: MarkFileObjectProcessedInput,
      tx?: TransactionContext,
    ): Promise<FileObjectEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const now = new Date();
      const [updated] = await executor
        .update(fileObjects)
        .set({
          status: input.status,
          ...(input.detectedContentType !== undefined
            ? { detectedContentType: input.detectedContentType }
            : {}),
          ...(input.rejectionReason !== undefined
            ? { rejectionReason: input.rejectionReason }
            : {}),
          updatedAt: now,
        })
        .where(and(eq(fileObjects.id, input.fileObjectId), eq(fileObjects.status, "QUARANTINED")))
        .returning();

      return updated ? toFileObjectEntity(updated) : null;
    },
  };
}

async function transitionSessionAndFileObject(
  executor: ReturnType<typeof resolveDbExecutor>,
  params: {
    readonly sessionId: string;
    readonly allowedStatuses: readonly UploadSessionStatus[];
    readonly nextSessionStatus: UploadSessionStatus;
    readonly finalizedAt?: Date | undefined;
    readonly fileObjectId: string;
    readonly sizeBytes: number;
    readonly checksumSha256: string;
    readonly nextFileObjectStatus?: "QUARANTINED" | undefined;
  },
): Promise<CreatedUploadSessionRecords | null> {
  const now = new Date();
  const [updatedSession] = await executor
    .update(uploadSessions)
    .set({
      status: params.nextSessionStatus,
      ...(params.finalizedAt ? { finalizedAt: params.finalizedAt } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(uploadSessions.id, params.sessionId),
        inArray(uploadSessions.status, [...params.allowedStatuses]),
      ),
    )
    .returning();

  if (!updatedSession) {
    return null;
  }

  const [updatedFileObject] = await executor
    .update(fileObjects)
    .set({
      sizeBytes: params.sizeBytes,
      checksumSha256: params.checksumSha256,
      ...(params.nextFileObjectStatus ? { status: params.nextFileObjectStatus } : {}),
      updatedAt: now,
    })
    .where(eq(fileObjects.id, params.fileObjectId))
    .returning();

  if (!updatedFileObject) {
    throw new Error("Failed to update file object record during upload state transition.");
  }

  return {
    session: toUploadSessionEntity(updatedSession),
    fileObject: toFileObjectEntity(updatedFileObject),
  };
}
