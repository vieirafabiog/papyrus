import { z } from "zod";
import { categoryHexColorSchema } from "./category.schema.js";
import {
  createApiResponseSchema,
  createPaginatedResponseSchema,
  createSortSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema.js";

export const tagRecordSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  name: z.string().trim().min(1).max(64),
  normalizedName: z.string().trim().min(1).max(64),
  color: categoryHexColorSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type TagRecord = z.infer<typeof tagRecordSchema>;

export const createTagInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nome da etiqueta é obrigatório.")
    .max(64, "Nome da etiqueta deve ter no máximo 64 caracteres."),
  color: categoryHexColorSchema.nullable().optional(),
});
export type CreateTagInput = z.infer<typeof createTagInputSchema>;

export const attachDocumentTagInputSchema = z.object({
  tagId: uuidSchema,
});
export type AttachDocumentTagInput = z.infer<typeof attachDocumentTagInputSchema>;

export const tagListSortSchema = createSortSchema(["name", "createdAt", "id"]);

export const tagListQuerySchema = paginationQuerySchema.merge(tagListSortSchema).extend({
  search: z.string().trim().max(64).optional(),
});
export type TagListQuery = z.infer<typeof tagListQuerySchema>;

export const tagResponseSchema = createApiResponseSchema(tagRecordSchema);
export type TagResponse = z.infer<typeof tagResponseSchema>;

export const tagListResponseSchema = createApiResponseSchema(
  createPaginatedResponseSchema(tagRecordSchema),
);
export type TagListResponse = z.infer<typeof tagListResponseSchema>;

export const documentTagListResponseSchema = createApiResponseSchema(z.array(tagRecordSchema));
export type DocumentTagListResponse = z.infer<typeof documentTagListResponseSchema>;
