import { z } from "zod";
import {
  createApiResponseSchema,
  createPaginatedResponseSchema,
  createSortSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema.js";

export const folderStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export type FolderStatus = z.infer<typeof folderStatusSchema>;

export const folderRecordSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  parentId: uuidSchema.nullable(),
  name: z.string().trim().min(1).max(120),
  materializedPath: z.string().min(1),
  status: folderStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type FolderRecord = z.infer<typeof folderRecordSchema>;

export const createFolderRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nome da pasta é obrigatório.")
    .max(120, "Nome da pasta deve ter no máximo 120 caracteres."),
  parentId: uuidSchema.nullable().optional(),
});
export type CreateFolderRequest = z.infer<typeof createFolderRequestSchema>;

export const renameFolderRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nome da pasta é obrigatório.")
    .max(120, "Nome da pasta deve ter no máximo 120 caracteres."),
});
export type RenameFolderRequest = z.infer<typeof renameFolderRequestSchema>;

export const moveFolderRequestSchema = z.object({
  targetParentId: uuidSchema.nullable(),
});
export type MoveFolderRequest = z.infer<typeof moveFolderRequestSchema>;

export const folderListSortSchema = createSortSchema([
  "name",
  "status",
  "createdAt",
  "updatedAt",
  "id",
]);

export const folderListQuerySchema = paginationQuerySchema.merge(folderListSortSchema).extend({
  parentId: uuidSchema.optional(),
  rootOnly: z.coerce.boolean().optional(),
  status: folderStatusSchema.optional(),
  search: z.string().trim().max(120).optional(),
});
export type FolderListQuery = z.infer<typeof folderListQuerySchema>;

export const folderResponseSchema = createApiResponseSchema(folderRecordSchema);
export type FolderResponse = z.infer<typeof folderResponseSchema>;

export const folderListResponseSchema = createApiResponseSchema(
  createPaginatedResponseSchema(folderRecordSchema),
);
export type FolderListResponse = z.infer<typeof folderListResponseSchema>;
