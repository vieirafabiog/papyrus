import { z } from "zod";
import { categoryFieldDefinitionSchema, categoryHexColorSchema } from "./category.schema.js";
import {
  createApiResponseSchema,
  createPaginatedResponseSchema,
  createSortSchema,
  isoDateSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema.js";
import { tagRecordSchema } from "./tag.schema.js";

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

export const documentListItemSchema = z.object({
  id: uuidSchema,
  title: z.string().trim().min(1).max(255),
  categoryId: uuidSchema,
  folderId: uuidSchema.nullable(),
  status: documentStatusSchema,
  currentVersionId: uuidSchema.nullable(),
  ownerUserId: uuidSchema,
  issueDate: isoDateSchema.nullable(),
  expirationDate: isoDateSchema.nullable(),
  version: z.number().int().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DocumentListItem = z.infer<typeof documentListItemSchema>;

export const documentListQuerySchema = paginationQuerySchema
  .merge(documentListSortSchema)
  .extend({
    search: z.string().trim().max(200).optional(),
    categoryId: uuidSchema.optional(),
    folderId: uuidSchema.optional(),
    ownerUserId: uuidSchema.optional(),
    tagId: uuidSchema.optional(),
    expirationFrom: isoDateSchema.optional(),
    expirationTo: isoDateSchema.optional(),
    status: documentStatusSchema.optional(),
  })
  .refine(
    (query) =>
      query.expirationFrom === undefined ||
      query.expirationTo === undefined ||
      query.expirationTo >= query.expirationFrom,
    {
      path: ["expirationTo"],
      message: "A data final de vencimento deve ser maior ou igual à data inicial.",
    },
  );
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const documentListResponseSchema = createPaginatedResponseSchema(documentListItemSchema);
export type DocumentListResponse = z.infer<typeof documentListResponseSchema>;

export const documentDetailFileObjectSchema = z.object({
  id: uuidSchema,
  originalFileName: z.string().min(1).max(255),
  detectedContentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  checksumSha256: sha256ChecksumSchema,
  status: fileObjectStatusSchema,
});
export type DocumentDetailFileObject = z.infer<typeof documentDetailFileObjectSchema>;

export const documentDetailVersionSchema = z.object({
  id: uuidSchema,
  versionNumber: z.number().int().min(1),
  fileObjectId: uuidSchema,
  uploadedByUserId: uuidSchema,
  changeNote: z.string().trim().max(1000).nullable(),
  createdAt: isoDateTimeSchema,
  fileObject: documentDetailFileObjectSchema.nullable(),
});
export type DocumentDetailVersion = z.infer<typeof documentDetailVersionSchema>;

export const documentDetailSchema = documentRecordSchema.extend({
  category: z.object({
    id: uuidSchema,
    name: z.string().trim().min(1).max(120),
    color: categoryHexColorSchema.nullable(),
    icon: z.string().trim().min(1).max(64).nullable(),
    fields: z.array(categoryFieldDefinitionSchema),
  }),
  folder: z
    .object({
      id: uuidSchema,
      name: z.string().trim().min(1).max(120),
      materializedPath: z.string().min(1),
    })
    .nullable(),
  owner: z.object({
    id: uuidSchema,
    fullName: z.string().trim().min(1).max(150),
    email: z.string().email(),
  }),
  currentVersion: documentDetailVersionSchema.nullable(),
  tags: z.array(tagRecordSchema),
  permissions: z.object({
    canUpdate: z.boolean(),
    canDelete: z.boolean(),
    canUpload: z.boolean(),
    canDownload: z.boolean(),
  }),
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;

export const documentDetailResponseSchema = createApiResponseSchema(documentDetailSchema);
export type DocumentDetailResponse = z.infer<typeof documentDetailResponseSchema>;

export const createDocumentVersionRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    fileObjectId: uuidSchema.optional(),
    uploadSessionId: uuidSchema.optional(),
    changeNote: z
      .string()
      .trim()
      .max(1000, "A observação da versão deve ter no máximo 1000 caracteres.")
      .nullable()
      .optional(),
  })
  .refine(
    (payload) => payload.fileObjectId !== undefined || payload.uploadSessionId !== undefined,
    {
      message: "Informe o identificador do arquivo disponível ou sessão de upload finalizada.",
    },
  );
export type CreateDocumentVersionRequest = z.infer<typeof createDocumentVersionRequestSchema>;

export const createDocumentVersionResponseSchema = z.object({
  data: documentVersionRecordSchema,
  document: documentRecordSchema,
});
export type CreateDocumentVersionResponse = z.infer<typeof createDocumentVersionResponseSchema>;

export const createDocumentRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Título do documento é obrigatório.")
      .max(255, "Título deve ter no máximo 255 caracteres."),
    categoryId: uuidSchema,
    folderId: uuidSchema.nullable().default(null),
    ownerUserId: uuidSchema.optional(),
    issueDate: isoDateSchema.nullable().default(null),
    expirationDate: isoDateSchema.nullable().default(null),
    metadata: documentMetadataRecordSchema.default({}),
    uploadSessionId: uuidSchema,
    changeNote: z.string().trim().max(1000).nullable().optional(),
    initialStatus: documentStatusSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    if (
      payload.issueDate !== null &&
      payload.expirationDate !== null &&
      payload.expirationDate < payload.issueDate
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expirationDate"],
        message: "A data de vencimento não pode ser anterior à data de emissão.",
      });
    }
    if (payload.initialStatus === "APPROVED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initialStatus"],
        message: "Não é permitido definir status aprovado no envio inicial do documento.",
      });
    }
  });
export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;

export const updateDocumentRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    title: z
      .string()
      .trim()
      .min(1, "Título do documento é obrigatório.")
      .max(255, "Título deve ter no máximo 255 caracteres.")
      .optional(),
    categoryId: uuidSchema.optional(),
    folderId: uuidSchema.nullable().optional(),
    issueDate: isoDateSchema.nullable().optional(),
    expirationDate: isoDateSchema.nullable().optional(),
    metadata: documentMetadataRecordSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    if (
      payload.issueDate !== undefined &&
      payload.issueDate !== null &&
      payload.expirationDate !== undefined &&
      payload.expirationDate !== null &&
      payload.expirationDate < payload.issueDate
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expirationDate"],
        message: "A data de vencimento não pode ser anterior à data de emissão.",
      });
    }
  });
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequestSchema>;
