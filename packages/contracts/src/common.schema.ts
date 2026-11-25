import { z } from "zod";

export const uuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof uuidSchema>;

export const isoDateTimeSchema = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [yearRaw, monthRaw, dayRaw] = value.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "Data ISO inválida.");
export type IsoDate = z.infer<typeof isoDateSchema>;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

export const sortDirectionSchema = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

export function createSortSchema<const TFields extends readonly [string, ...string[]]>(
  allowedFields: TFields,
) {
  return z.object({
    sortBy: z.enum(allowedFields).optional(),
    sortDirection: sortDirectionSchema.default("desc"),
  });
}

export function createPaginatedResponseSchema<TItem extends z.ZodTypeAny>(itemSchema: TItem) {
  return z.object({
    items: z.array(itemSchema),
    pagination: paginationMetaSchema,
  });
}

export const errorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "DOCUMENT_VERSION_CONFLICT",
  "UPLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "FILE_QUARANTINED",
  "FILE_REJECTED",
  "STORAGE_UNAVAILABLE",
  "PREVIEW_CONVERTER_UNAVAILABLE",
  "PREVIEW_CONVERSION_FAILED",
  "RETENTION_HOLD_ACTIVE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    requestId: uuidSchema,
    details: z.record(z.unknown()).optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export function createApiResponseSchema<TData extends z.ZodTypeAny>(dataSchema: TData) {
  return z.object({
    data: dataSchema,
  });
}
