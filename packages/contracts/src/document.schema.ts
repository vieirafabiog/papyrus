import { z } from "zod";
import {
  categoryFieldDefinitionSchema,
  categoryHexColorSchema,
  categoryTextIndexingModeSchema,
} from "./category.schema.js";
import {
  createApiResponseSchema,
  createPaginatedResponseSchema,
  createSortSchema,
  isoDateSchema,
  isoDateTimeSchema,
  paginationMetaSchema,
  paginationQuerySchema,
  sortDirectionSchema,
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

export const isoDateOrDateTimeSchema = z.union([isoDateSchema, isoDateTimeSchema]);

export const documentMetadataSearchFilterSchema = z
  .discriminatedUnion("type", [
    z.object({
      fieldKey: z.string().trim().min(1).max(64),
      type: z.literal("TEXT"),
      value: z.string().trim().min(1).max(255),
      matchMode: z.enum(["contains", "exact"]).optional(),
    }),
    z.object({
      fieldKey: z.string().trim().min(1).max(64),
      type: z.literal("SINGLE_SELECT"),
      value: z.string().trim().min(1).max(255),
    }),
    z.object({
      fieldKey: z.string().trim().min(1).max(64),
      type: z.literal("NUMBER"),
      equals: z.number().finite().optional(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    }),
    z.object({
      fieldKey: z.string().trim().min(1).max(64),
      type: z.literal("DATE"),
      equals: isoDateSchema.optional(),
      from: isoDateSchema.optional(),
      to: isoDateSchema.optional(),
    }),
    z.object({
      fieldKey: z.string().trim().min(1).max(64),
      type: z.literal("BOOLEAN"),
      value: z.boolean(),
    }),
    z.object({
      fieldKey: z.string().trim().min(1).max(64),
      type: z.literal("MULTI_SELECT"),
      values: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
    }),
  ])
  .superRefine((filter, ctx) => {
    if (filter.type === "NUMBER") {
      if (filter.equals === undefined && filter.min === undefined && filter.max === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Informe ao menos um critério numérico (igual, mínimo ou máximo).",
        });
      }
      if (filter.min !== undefined && filter.max !== undefined && filter.max < filter.min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["max"],
          message: "O valor máximo do filtro numérico deve ser maior ou igual ao mínimo.",
        });
      }
    }
    if (filter.type === "DATE") {
      if (filter.equals === undefined && filter.from === undefined && filter.to === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Informe ao menos uma data ou intervalo para o filtro de metadados.",
        });
      }
      if (filter.from !== undefined && filter.to !== undefined && filter.to < filter.from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["to"],
          message: "A data final do metadado deve ser maior ou igual à data inicial.",
        });
      }
    }
  });
export type DocumentMetadataSearchFilterContract = z.infer<
  typeof documentMetadataSearchFilterSchema
>;

function validateSearchDateRanges(
  q: {
    readonly issueDateFrom?: string | undefined;
    readonly issueDateTo?: string | undefined;
    readonly expirationFrom?: string | undefined;
    readonly expirationTo?: string | undefined;
    readonly createdFrom?: string | undefined;
    readonly createdTo?: string | undefined;
    readonly updatedFrom?: string | undefined;
    readonly updatedTo?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    q.issueDateFrom !== undefined &&
    q.issueDateTo !== undefined &&
    q.issueDateTo < q.issueDateFrom
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issueDateTo"],
      message: "A data final de emissão deve ser maior ou igual à inicial.",
    });
  }
  if (
    q.expirationFrom !== undefined &&
    q.expirationTo !== undefined &&
    q.expirationTo < q.expirationFrom
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expirationTo"],
      message: "A data final de vencimento deve ser maior ou igual à data inicial.",
    });
  }
  if (
    q.createdFrom !== undefined &&
    q.createdTo !== undefined &&
    new Date(q.createdTo).getTime() < new Date(q.createdFrom).getTime()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["createdTo"],
      message: "A data final de criação deve ser maior ou igual à inicial.",
    });
  }
  if (
    q.updatedFrom !== undefined &&
    q.updatedTo !== undefined &&
    new Date(q.updatedTo).getTime() < new Date(q.updatedFrom).getTime()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["updatedTo"],
      message: "A data final de atualização deve ser maior ou igual à inicial.",
    });
  }
}

const searchQueryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return value;
}, z.boolean());

const searchQueryTagIdsSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return value;
}, z.array(uuidSchema).max(20));

const searchQueryMetadataFiltersSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value;
}, z.array(documentMetadataSearchFilterSchema).max(20));

const documentSearchBaseObjectSchema = paginationQuerySchema.merge(documentListSortSchema).extend({
  search: z.string().trim().max(200).optional(),
  categoryId: uuidSchema.optional(),
  folderId: uuidSchema.optional(),
  rootOnly: z.boolean().optional(),
  includeSubfolders: z.boolean().optional(),
  status: documentStatusSchema.optional(),
  authorUserId: uuidSchema.optional(),
  ownerUserId: uuidSchema.optional(),
  issueDateFrom: isoDateSchema.optional(),
  issueDateTo: isoDateSchema.optional(),
  expirationFrom: isoDateSchema.optional(),
  expirationTo: isoDateSchema.optional(),
  createdFrom: isoDateOrDateTimeSchema.optional(),
  createdTo: isoDateOrDateTimeSchema.optional(),
  updatedFrom: isoDateOrDateTimeSchema.optional(),
  updatedTo: isoDateOrDateTimeSchema.optional(),
  tagId: uuidSchema.optional(),
  tagIds: z.array(uuidSchema).max(20).optional(),
  metadataFilters: z.array(documentMetadataSearchFilterSchema).max(20).optional(),
});

export const documentSearchRequestSchema =
  documentSearchBaseObjectSchema.superRefine(validateSearchDateRanges);
export type DocumentSearchRequest = z.infer<typeof documentSearchRequestSchema>;

export const documentSearchQuerySchema = documentSearchBaseObjectSchema
  .extend({
    rootOnly: searchQueryBooleanSchema.optional(),
    includeSubfolders: searchQueryBooleanSchema.optional(),
    tagIds: searchQueryTagIdsSchema.optional(),
    metadataFilters: searchQueryMetadataFiltersSchema.optional(),
  })
  .superRefine(validateSearchDateRanges);
export type DocumentSearchQuery = z.infer<typeof documentSearchQuerySchema>;

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

export const documentVersionAuthorSchema = z.object({
  id: uuidSchema,
  fullName: z.string().trim().min(1).max(150),
  email: z.string().email(),
});
export type DocumentVersionAuthor = z.infer<typeof documentVersionAuthorSchema>;

export const documentVersionPermissionsSchema = z.object({
  canDownload: z.boolean(),
  canRestore: z.boolean(),
});
export type DocumentVersionPermissions = z.infer<typeof documentVersionPermissionsSchema>;

export const documentVersionHistoryItemSchema = documentDetailVersionSchema.extend({
  documentId: uuidSchema,
  isCurrent: z.boolean(),
  uploadedByUser: documentVersionAuthorSchema,
  permissions: documentVersionPermissionsSchema,
});
export type DocumentVersionHistoryItem = z.infer<typeof documentVersionHistoryItemSchema>;

export const documentVersionHistoryListResponseSchema = createApiResponseSchema(
  z.array(documentVersionHistoryItemSchema),
);
export type DocumentVersionHistoryListResponse = z.infer<
  typeof documentVersionHistoryListResponseSchema
>;

export const restoreDocumentVersionRequestSchema = z.object({
  expectedVersion: z.number().int().min(1),
  changeNote: z
    .string()
    .trim()
    .max(1000, "A observação da restauração deve ter no máximo 1000 caracteres.")
    .nullable()
    .optional(),
});
export type RestoreDocumentVersionRequest = z.infer<typeof restoreDocumentVersionRequestSchema>;

export const documentDetailSchema = documentRecordSchema.extend({
  category: z.object({
    id: uuidSchema,
    name: z.string().trim().min(1).max(120),
    color: categoryHexColorSchema.nullable(),
    icon: z.string().trim().min(1).max(64).nullable(),
    textIndexingMode: categoryTextIndexingModeSchema.default("NEVER"),
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

export const moveDocumentRequestSchema = z.object({
  expectedVersion: z.number().int().min(1),
  targetFolderId: uuidSchema.nullable(),
});
export type MoveDocumentRequest = z.infer<typeof moveDocumentRequestSchema>;

export const archiveDocumentRequestSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z
    .string()
    .trim()
    .max(500, "O motivo do arquivamento deve ter no máximo 500 caracteres.")
    .nullable()
    .optional(),
});
export type ArchiveDocumentRequest = z.infer<typeof archiveDocumentRequestSchema>;

export const trashDocumentRequestSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z
    .string()
    .trim()
    .max(500, "O motivo da exclusão deve ter no máximo 500 caracteres.")
    .nullable()
    .optional(),
});
export type TrashDocumentRequest = z.infer<typeof trashDocumentRequestSchema>;

export const documentMutationResponseSchema = createApiResponseSchema(documentRecordSchema);
export type DocumentMutationResponse = z.infer<typeof documentMutationResponseSchema>;

export const expirationStateSchema = z.enum(["EXPIRED", "EXPIRING_SOON", "UP_TO_DATE", "NO_DATE"]);
export type ExpirationState = z.infer<typeof expirationStateSchema>;

export const expirationBucketSchema = z.enum([
  "ALL",
  "EXPIRED",
  "EXPIRING_SOON",
  "UP_TO_DATE",
  "NO_DATE",
]);
export type ExpirationBucket = z.infer<typeof expirationBucketSchema>;

export const ianaTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Fuso horário IANA inválido.");

export const documentExpirationsSortFieldSchema = z.enum([
  "expirationDate",
  "title",
  "status",
  "updatedAt",
]);
export type DocumentExpirationsSortField = z.infer<typeof documentExpirationsSortFieldSchema>;

export const documentExpirationsQuerySchema = paginationQuerySchema.extend({
  bucket: expirationBucketSchema.default("ALL"),
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
  timezone: ianaTimezoneSchema.optional(),
  categoryId: uuidSchema.optional(),
  folderId: uuidSchema.optional(),
  ownerUserId: uuidSchema.optional(),
  search: z.string().trim().max(200).optional(),
  includeArchived: z.coerce.boolean().default(false),
  sortBy: documentExpirationsSortFieldSchema.default("expirationDate"),
  sortDirection: sortDirectionSchema.default("asc"),
});
export type DocumentExpirationsQuery = z.infer<typeof documentExpirationsQuerySchema>;

export const documentExpirationItemSchema = documentListItemSchema.extend({
  expirationState: expirationStateSchema,
  daysUntilExpiration: z.number().int().nullable(),
  categoryName: z.string().nullable().optional(),
  ownerName: z.string().nullable().optional(),
});
export type DocumentExpirationItem = z.infer<typeof documentExpirationItemSchema>;

export const documentExpirationSummarySchema = z.object({
  expiredCount: z.number().int().min(0),
  expiringSoonCount: z.number().int().min(0),
  upToDateCount: z.number().int().min(0),
  noExpirationCount: z.number().int().min(0),
});
export type DocumentExpirationSummary = z.infer<typeof documentExpirationSummarySchema>;

export const documentExpirationsListDataSchema = z.object({
  items: z.array(documentExpirationItemSchema),
  pagination: paginationMetaSchema,
  summary: documentExpirationSummarySchema,
  timezone: z.string().min(1),
  referenceDate: isoDateSchema,
  windowDays: z.number().int().min(1),
});
export type DocumentExpirationsListData = z.infer<typeof documentExpirationsListDataSchema>;

export const documentExpirationsResponseSchema = createApiResponseSchema(
  documentExpirationsListDataSchema,
);
export type DocumentExpirationsResponse = z.infer<typeof documentExpirationsResponseSchema>;

export const restoreTrashedDocumentTargetStatusSchema = z.enum(["DRAFT", "ARCHIVED"]);
export type RestoreTrashedDocumentTargetStatus = z.infer<
  typeof restoreTrashedDocumentTargetStatusSchema
>;

export const restoreTrashedDocumentRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  targetStatus: restoreTrashedDocumentTargetStatusSchema.default("DRAFT"),
  reason: z.string().trim().max(500).nullable().optional(),
});
export type RestoreTrashedDocumentRequest = z.infer<typeof restoreTrashedDocumentRequestSchema>;

export const trashDocumentsSortFieldSchema = z.enum(["deletedAt", "title", "updatedAt"]);
export type TrashDocumentsSortField = z.infer<typeof trashDocumentsSortFieldSchema>;

export const trashDocumentsQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(200).optional(),
  categoryId: uuidSchema.optional(),
  folderId: uuidSchema.optional(),
  sortBy: trashDocumentsSortFieldSchema.default("deletedAt"),
  sortDirection: sortDirectionSchema.default("desc"),
});
export type TrashDocumentsQuery = z.infer<typeof trashDocumentsQuerySchema>;

export const trashDocumentListItemSchema = documentListItemSchema.extend({
  categoryName: z.string().nullable().optional(),
  ownerName: z.string().nullable().optional(),
  deletedAt: isoDateTimeSchema.nullable(),
  trashGraceDays: z.number().int().min(0),
  restoreDeadlineAt: isoDateTimeSchema.nullable(),
  canRestore: z.boolean(),
});
export type TrashDocumentListItem = z.infer<typeof trashDocumentListItemSchema>;

export const trashDocumentsListResponseSchema = createPaginatedResponseSchema(
  trashDocumentListItemSchema,
);
export type TrashDocumentsListResponse = z.infer<typeof trashDocumentsListResponseSchema>;

export const MAX_BULK_DOCUMENT_ITEMS = 50;

export const bulkDocumentActionTypeSchema = z.enum(["MOVE", "ARCHIVE", "TRASH", "ATTACH_TAG"]);
export type BulkDocumentActionType = z.infer<typeof bulkDocumentActionTypeSchema>;

const bulkDocumentIdsSchema = z
  .array(uuidSchema)
  .min(1, "Selecione ao menos um documento.")
  .max(
    MAX_BULK_DOCUMENT_ITEMS,
    `Selecione no máximo ${MAX_BULK_DOCUMENT_ITEMS} documentos por operação.`,
  );

export const bulkDocumentActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("MOVE"),
    documentIds: bulkDocumentIdsSchema,
    targetFolderId: uuidSchema.nullable(),
  }),
  z.object({
    action: z.literal("ARCHIVE"),
    documentIds: bulkDocumentIdsSchema,
    reason: z.string().trim().max(500).nullable().optional(),
  }),
  z.object({
    action: z.literal("TRASH"),
    documentIds: bulkDocumentIdsSchema,
    reason: z.string().trim().max(500).nullable().optional(),
  }),
  z.object({
    action: z.literal("ATTACH_TAG"),
    documentIds: bulkDocumentIdsSchema,
    tagId: uuidSchema,
  }),
]);
export type BulkDocumentActionRequest = z.infer<typeof bulkDocumentActionRequestSchema>;

export const bulkDocumentActionItemStatusSchema = z.enum(["SUCCEEDED", "FAILED"]);
export type BulkDocumentActionItemStatus = z.infer<typeof bulkDocumentActionItemStatusSchema>;

export const bulkDocumentActionItemResultSchema = z.object({
  documentId: uuidSchema,
  status: bulkDocumentActionItemStatusSchema,
  errorCode: z.string().optional(),
  message: z.string().optional(),
});
export type BulkDocumentActionItemResult = z.infer<typeof bulkDocumentActionItemResultSchema>;

export const bulkDocumentActionSummarySchema = z.object({
  action: bulkDocumentActionTypeSchema,
  totalRequested: z.number().int().min(1),
  succeededCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  results: z.array(bulkDocumentActionItemResultSchema),
});
export type BulkDocumentActionSummary = z.infer<typeof bulkDocumentActionSummarySchema>;

export const bulkDocumentActionResponseSchema = createApiResponseSchema(
  bulkDocumentActionSummarySchema,
);
export type BulkDocumentActionResponse = z.infer<typeof bulkDocumentActionResponseSchema>;

export const bulkDocumentDownloadRequestSchema = z.object({
  documentIds: bulkDocumentIdsSchema,
});
export type BulkDocumentDownloadRequest = z.infer<typeof bulkDocumentDownloadRequestSchema>;
