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
    const isSelect = field.type === "SINGLE_SELECT" || field.type === "MULTI_SELECT";
    if (isSelect) {
      if (!field.options || field.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "Campos de seleção devem definir ao menos uma opção.",
        });
        return;
      }
      const unique = new Set(field.options);
      if (unique.size !== field.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "Opções de seleção não podem ser duplicadas.",
        });
      }
    } else if (field.options !== undefined && field.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Apenas campos de seleção podem definir opções.",
      });
    }
  });
export type CategoryFieldDefinition = z.infer<typeof categoryFieldDefinitionSchema>;

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

export const categoryListResponseSchema = createApiResponseSchema(
  createPaginatedResponseSchema(categorySummarySchema),
);
export type CategoryListResponse = z.infer<typeof categoryListResponseSchema>;
