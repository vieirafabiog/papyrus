import { z } from "zod";
import {
  createApiResponseSchema,
  createPaginatedResponseSchema,
  createSortSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema.js";

export const categoryFieldTypeSchema = z.enum([
  "TEXT",
  "NUMBER",
  "DATE",
  "BOOLEAN",
  "SINGLE_SELECT",
  "MULTI_SELECT",
]);
export type CategoryFieldType = z.infer<typeof categoryFieldTypeSchema>;

export const categoryFieldKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "Chave do campo deve usar snake_case minúsculo.");

function validateSelectFieldOptions(
  type: CategoryFieldType,
  options: readonly string[] | undefined,
  ctx: z.RefinementCtx,
): void {
  const isSelect = type === "SINGLE_SELECT" || type === "MULTI_SELECT";
  if (isSelect) {
    if (!options || options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Campos de seleção devem definir ao menos uma opção.",
      });
      return;
    }
    const unique = new Set(options);
    if (unique.size !== options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Opções de seleção não podem ser duplicadas.",
      });
    }
    return;
  }

  if (options !== undefined && options.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Apenas campos de seleção podem definir opções.",
    });
  }
}

export const categoryFieldDefinitionSchema = z
  .object({
    id: uuidSchema,
    key: categoryFieldKeySchema,
    label: z.string().trim().min(1).max(120),
    type: categoryFieldTypeSchema,
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(120)).optional(),
    sortOrder: z.number().int().min(0).default(0),
  })
  .superRefine((field, ctx) => {
    validateSelectFieldOptions(field.type, field.options, ctx);
  });
export type CategoryFieldDefinition = z.infer<typeof categoryFieldDefinitionSchema>;

const fieldMetadataDefaultValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

export const fieldMigrationStrategySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NONE") }),
  z.object({
    type: z.literal("BACKFILL_DEFAULT"),
    defaultValue: fieldMetadataDefaultValueSchema,
  }),
  z.object({
    type: z.literal("RESET_TO_DEFAULT"),
    defaultValue: fieldMetadataDefaultValueSchema,
  }),
  z.object({ type: z.literal("REMOVE_FROM_DOCUMENTS") }),
]);
export type FieldMigrationStrategy = z.infer<typeof fieldMigrationStrategySchema>;

export const createCategoryFieldInputSchema = z
  .object({
    key: categoryFieldKeySchema,
    label: z
      .string()
      .trim()
      .min(1, "Rótulo do campo é obrigatório.")
      .max(120, "Rótulo do campo deve ter no máximo 120 caracteres."),
    type: categoryFieldTypeSchema,
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(120)).optional(),
    sortOrder: z.number().int().min(0).default(0),
    migrationStrategy: fieldMigrationStrategySchema.optional(),
  })
  .superRefine((field, ctx) => {
    validateSelectFieldOptions(field.type, field.options, ctx);
  });
export type CreateCategoryFieldInput = z.infer<typeof createCategoryFieldInputSchema>;

export const updateCategoryFieldInputSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Rótulo do campo é obrigatório.")
    .max(120, "Rótulo do campo deve ter no máximo 120 caracteres.")
    .optional(),
  type: categoryFieldTypeSchema.optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(120)).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  migrationStrategy: fieldMigrationStrategySchema.optional(),
});
export type UpdateCategoryFieldInput = z.infer<typeof updateCategoryFieldInputSchema>;

export const deleteCategoryFieldInputSchema = z.object({
  migrationStrategy: fieldMigrationStrategySchema.optional(),
});
export type DeleteCategoryFieldInput = z.infer<typeof deleteCategoryFieldInputSchema>;

export const categoryFieldRecordSchema = z.object({
  id: uuidSchema,
  categoryId: uuidSchema,
  key: categoryFieldKeySchema,
  label: z.string().trim().min(1).max(120),
  type: categoryFieldTypeSchema,
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(120)).nullable(),
  sortOrder: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type CategoryFieldRecord = z.infer<typeof categoryFieldRecordSchema>;

export const CATEGORY_TEXT_INDEXING_MODES = ["NEVER", "ALWAYS", "ASK"] as const;

export const categoryTextIndexingModeSchema = z.enum(CATEGORY_TEXT_INDEXING_MODES);
export type CategoryTextIndexingMode = z.infer<typeof categoryTextIndexingModeSchema>;

export const categoryHexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Cor hexadecimal inválida.");

export const categorySummarySchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  color: categoryHexColorSchema.nullable(),
  icon: z.string().trim().min(1).max(64).nullable(),
  isActive: z.boolean(),
  textIndexingMode: categoryTextIndexingModeSchema.default("NEVER"),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type CategorySummaryRecord = z.infer<typeof categorySummarySchema>;

export const categorySchema = categorySummarySchema.extend({
  fields: z.array(categoryFieldDefinitionSchema),
});
export type CategoryRecord = z.infer<typeof categorySchema>;

export const createCategoryInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nome da categoria é obrigatório.")
    .max(120, "Nome da categoria deve ter no máximo 120 caracteres."),
  description: z
    .string()
    .trim()
    .max(500, "Descrição deve ter no máximo 500 caracteres.")
    .nullable()
    .optional(),
  color: categoryHexColorSchema.nullable().optional(),
  icon: z
    .string()
    .trim()
    .min(1, "Nome do ícone é inválido.")
    .max(64, "Nome do ícone deve ter no máximo 64 caracteres.")
    .nullable()
    .optional(),
  textIndexingMode: categoryTextIndexingModeSchema.optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>;

export const updateCategoryInputSchema = createCategoryInputSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategoryInputSchema>;

const booleanQueryParamSchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const categoryListSortSchema = createSortSchema([
  "name",
  "isActive",
  "createdAt",
  "updatedAt",
  "id",
]);

export const categoryListQuerySchema = paginationQuerySchema.merge(categoryListSortSchema).extend({
  isActive: booleanQueryParamSchema.optional(),
  search: z.string().trim().max(120).optional(),
});
export type CategoryListQuery = z.infer<typeof categoryListQuerySchema>;

export const categorySummaryResponseSchema = createApiResponseSchema(categorySummarySchema);
export type CategorySummaryResponse = z.infer<typeof categorySummaryResponseSchema>;

export const categoryDetailResponseSchema = createApiResponseSchema(categorySchema);
export type CategoryDetailResponse = z.infer<typeof categoryDetailResponseSchema>;

export const categoryListResponseSchema = createApiResponseSchema(
  createPaginatedResponseSchema(categorySummarySchema),
);
export type CategoryListResponse = z.infer<typeof categoryListResponseSchema>;

export const categoryFieldResponseSchema = createApiResponseSchema(categoryFieldRecordSchema);
export type CategoryFieldResponse = z.infer<typeof categoryFieldResponseSchema>;

export const categoryFieldListResponseSchema = createApiResponseSchema(
  z.array(categoryFieldRecordSchema),
);
export type CategoryFieldListResponse = z.infer<typeof categoryFieldListResponseSchema>;
