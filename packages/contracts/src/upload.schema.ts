import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./common.schema.js";
import { fileObjectStatusSchema, sha256ChecksumSchema } from "./document.schema.js";

export const uploadSessionStatusSchema = z.enum([
  "PENDING",
  "UPLOADED",
  "FINALIZED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
]);
export type UploadSessionStatusContract = z.infer<typeof uploadSessionStatusSchema>;

export const createUploadSessionRequestSchema = z.object({
  documentId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  folderId: uuidSchema.nullable().optional(),
  storageConnectionId: uuidSchema.optional(),
  originalFileName: z.string().trim().min(1).max(255),
  declaredSizeBytes: z.number().int().positive(),
  declaredContentType: z.string().trim().min(1).max(255),
  declaredChecksumSha256: sha256ChecksumSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
  expiresInSeconds: z.number().int().min(60).max(3_600).optional(),
});
export type CreateUploadSessionRequestContract = z.infer<typeof createUploadSessionRequestSchema>;

export const uploadSessionRecordSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  userId: uuidSchema,
  storageConnectionId: uuidSchema,
  fileObjectId: uuidSchema,
  objectKey: z.string().min(1).max(512),
  declaredSizeBytes: z.number().int().positive(),
  declaredContentType: z.string().min(1).max(255),
  idempotencyKey: z.string().min(1).max(128),
  status: uploadSessionStatusSchema,
  expiresAt: isoDateTimeSchema,
  finalizedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type UploadSessionRecordContract = z.infer<typeof uploadSessionRecordSchema>;

export const uploadContentResponseSchema = z.object({
  sessionId: uuidSchema,
  fileObjectId: uuidSchema,
  storageConnectionId: uuidSchema,
  status: uploadSessionStatusSchema,
  fileObjectStatus: fileObjectStatusSchema,
  bytesReceived: z.number().int().positive(),
  expectedBytes: z.number().int().positive(),
  progressPercent: z.number().int().min(0).max(100),
  checksumSha256: sha256ChecksumSchema,
});
export type UploadContentResponseContract = z.infer<typeof uploadContentResponseSchema>;

export const createSignedUploadTargetRequestSchema = z
  .object({
    expiresInSeconds: z.number().int().min(10).max(900).optional(),
  })
  .strict();
export type CreateSignedUploadTargetRequestContract = z.infer<
  typeof createSignedUploadTargetRequestSchema
>;

export const signedUploadTargetSchema = z.object({
  url: z.string().url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDateTimeSchema,
});
export type SignedUploadTargetContract = z.infer<typeof signedUploadTargetSchema>;

export const signedUploadTargetResponseSchema = z.object({
  sessionId: uuidSchema,
  fileObjectId: uuidSchema,
  storageConnectionId: uuidSchema,
  uploadMode: z.literal("SIGNED_UPLOAD"),
  finalizationRequired: z.literal(true),
  status: uploadSessionStatusSchema,
  fileObjectStatus: fileObjectStatusSchema,
  target: signedUploadTargetSchema,
});
export type SignedUploadTargetResponseContract = z.infer<typeof signedUploadTargetResponseSchema>;
