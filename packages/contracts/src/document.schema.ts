import { z } from "zod";
import {
  createSortSchema,
  isoDateSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema.js";

export const documentStatusSchema = z.enum([
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "ARCHIVED",
  "EXPIRED",
  "DELETED",
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const fileObjectStatusSchema = z.enum([
  "UPLOADING",
  "QUARANTINED",
  "AVAILABLE",
  "REJECTED",
  "MISSING",
  "DELETE_PENDING",
]);
export type FileObjectStatus = z.infer<typeof fileObjectStatusSchema>;

export const documentMetadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);
export type DocumentMetadataValue = z.infer<typeof documentMetadataValueSchema>;

export const documentMetadataRecordSchema = z.record(documentMetadataValueSchema);
export type DocumentMetadataRecord = z.infer<typeof documentMetadataRecordSchema>;

export const sha256ChecksumSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "Checksum SHA-256 inválido.");

export const documentRecordSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  title: z.string().trim().min(1).max(255),
  categoryId: uuidSchema,
  folderId: uuidSchema.nullable(),
  status: documentStatusSchema,
  currentVersionId: uuidSchema.nullable(),
  ownerUserId: uuidSchema,
  issueDate: isoDateSchema.nullable(),
  expirationDate: isoDateSchema.nullable(),
  metadata: documentMetadataRecordSchema,
  version: z.number().int().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DocumentRecord = z.infer<typeof documentRecordSchema>;

export const documentVersionRecordSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
  versionNumber: z.number().int().min(1),
  fileObjectId: uuidSchema,
  uploadedByUserId: uuidSchema,
  changeNote: z.string().trim().max(1000).nullable(),
  createdAt: isoDateTimeSchema,
});
export type DocumentVersionRecord = z.infer<typeof documentVersionRecordSchema>;

export const fileObjectRecordSchema = z.object({
  id: uuidSchema,
  storageConnectionId: uuidSchema,
  objectKey: z.string().min(1).max(512),
  originalFileName: z.string().min(1).max(255),
  detectedContentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  checksumSha256: sha256ChecksumSchema,
  status: fileObjectStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type FileObjectRecord = z.infer<typeof fileObjectRecordSchema>;

export const documentListSortSchema = createSortSchema([
  "title",
  "status",
  "issueDate",
  "expirationDate",
  "createdAt",
  "updatedAt",
  "id",
]);

export const documentListQuerySchema = paginationQuerySchema
  .merge(documentListSortSchema)
  .extend({
    search: z.string().trim().max(200).optional(),
    categoryId: uuidSchema.optional(),
    folderId: uuidSchema.optional(),
    status: documentStatusSchema.optional(),
  });
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
