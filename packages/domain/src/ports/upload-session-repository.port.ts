import type { FileObjectEntity } from "../documents/document.types.js";
import type { TransactionContext } from "../ports/transaction.port.js";

export const UPLOAD_SESSION_STATUSES = [
  "PENDING",
  "UPLOADED",
  "FINALIZED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
] as const;

export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

export interface UploadSessionEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly storageConnectionId: string;
  readonly fileObjectId: string;
  readonly declaredSizeBytes: number;
  readonly declaredContentType: string;
  readonly idempotencyKey: string;
  readonly status: UploadSessionStatus;
  readonly expiresAt: string;
  readonly finalizedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateUploadSessionWithFileObjectInput {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly storageConnectionId: string;
  readonly fileObjectId: string;
  readonly objectKey: string;
  readonly originalFileName: string;
  readonly declaredSizeBytes: number;
  readonly declaredContentType: string;
  readonly checksumSha256: string;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
}

export interface CreatedUploadSessionRecords {
  readonly session: UploadSessionEntity;
  readonly fileObject: FileObjectEntity;
}

export interface MarkUploadReceivedInput {
  readonly sessionId: string;
  readonly fileObjectId: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

export interface FinalizeUploadToQuarantineInput {
  readonly sessionId: string;
  readonly fileObjectId: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly finalizedAt: Date;
}

export interface MarkFileObjectProcessedInput {
  readonly fileObjectId: string;
  readonly status: "AVAILABLE" | "REJECTED" | "MISSING";
  readonly detectedContentType?: string | undefined;
  readonly rejectionReason?: string | null | undefined;
}

export interface UploadSessionRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<UploadSessionEntity | null>;
  findByIdempotencyKey(
    organizationId: string,
    userId: string,
    idempotencyKey: string,
    tx?: TransactionContext,
  ): Promise<UploadSessionEntity | null>;
  findFileObjectById(
    fileObjectId: string,
    tx?: TransactionContext,
  ): Promise<FileObjectEntity | null>;
  createSessionWithFileObject(
    input: CreateUploadSessionWithFileObjectInput,
    tx?: TransactionContext,
  ): Promise<CreatedUploadSessionRecords>;
  markUploadReceived(
    input: MarkUploadReceivedInput,
    tx?: TransactionContext,
  ): Promise<CreatedUploadSessionRecords | null>;
  finalizeToQuarantine(
    input: FinalizeUploadToQuarantineInput,
    tx?: TransactionContext,
  ): Promise<CreatedUploadSessionRecords | null>;
  markFileObjectProcessed(
    input: MarkFileObjectProcessedInput,
    tx?: TransactionContext,
  ): Promise<FileObjectEntity | null>;
  markSessionExpired(sessionId: string, tx?: TransactionContext): Promise<void>;
}
