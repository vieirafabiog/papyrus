import { z } from "zod";
import { createApiResponseSchema, isoDateTimeSchema, uuidSchema } from "./common.schema.js";

export const retentionActionSchema = z.enum(["ARCHIVE", "TRASH", "PURGE"]);
export type RetentionActionContract = z.infer<typeof retentionActionSchema>;

export const retentionPolicyRecordSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  categoryId: uuidSchema.nullable(),
  name: z.string().min(1).max(120),
  retentionDays: z.number().int().min(1),
  trashGraceDays: z.number().int().min(1),
  actionOnExpiry: retentionActionSchema,
  isActive: z.boolean(),
  createdBy: uuidSchema.nullable(),
  updatedBy: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RetentionPolicyRecordContract = z.infer<typeof retentionPolicyRecordSchema>;

export const createRetentionPolicyRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "O nome da política de retenção é obrigatório.")
    .max(120, "O nome da política deve ter no máximo 120 caracteres."),
  categoryId: uuidSchema.nullable().optional(),
  retentionDays: z
    .number()
    .int("O prazo de retenção deve ser um número inteiro em dias.")
    .min(1, "O prazo de retenção deve ser de pelo menos 1 dia.")
    .max(36500, "O prazo de retenção não pode exceder 36500 dias."),
  trashGraceDays: z
    .number()
    .int("O prazo da lixeira deve ser um número inteiro em dias.")
    .min(1, "O prazo da lixeira deve ser de pelo menos 1 dia.")
    .max(3650, "O prazo da lixeira não pode exceder 3650 dias.")
    .default(30),
  actionOnExpiry: retentionActionSchema.default("TRASH"),
  isActive: z.boolean().default(true),
});
export type CreateRetentionPolicyRequestContract = z.infer<
  typeof createRetentionPolicyRequestSchema
>;

export const updateRetentionPolicyRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "O nome da política de retenção é obrigatório.")
      .max(120, "O nome da política deve ter no máximo 120 caracteres.")
      .optional(),
    categoryId: uuidSchema.nullable().optional(),
    retentionDays: z
      .number()
      .int("O prazo de retenção deve ser um número inteiro em dias.")
      .min(1, "O prazo de retenção deve ser de pelo menos 1 dia.")
      .max(36500, "O prazo de retenção não pode exceder 36500 dias.")
      .optional(),
    trashGraceDays: z
      .number()
      .int("O prazo da lixeira deve ser um número inteiro em dias.")
      .min(1, "O prazo da lixeira deve ser de pelo menos 1 dia.")
      .max(3650, "O prazo da lixeira não pode exceder 3650 dias.")
      .optional(),
    actionOnExpiry: retentionActionSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "Informe ao menos um campo para atualizar a política de retenção.",
  });
export type UpdateRetentionPolicyRequestContract = z.infer<
  typeof updateRetentionPolicyRequestSchema
>;

export const retentionPolicyResponseSchema = createApiResponseSchema(retentionPolicyRecordSchema);
export const retentionPolicyListResponseSchema = createApiResponseSchema(
  z.object({
    items: z.array(retentionPolicyRecordSchema),
  }),
);

export const documentRetentionHoldSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  documentId: uuidSchema,
  reason: z.string().min(1).max(500),
  placedByUserId: uuidSchema,
  placedAt: isoDateTimeSchema,
  releasedByUserId: uuidSchema.nullable(),
  releasedAt: isoDateTimeSchema.nullable(),
  releaseReason: z.string().max(500).nullable(),
});
export type DocumentRetentionHoldContract = z.infer<typeof documentRetentionHoldSchema>;

export const placeDocumentHoldRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "A justificativa do bloqueio (hold) é obrigatória.")
    .max(500, "A justificativa do bloqueio deve ter no máximo 500 caracteres."),
});
export type PlaceDocumentHoldRequestContract = z.infer<typeof placeDocumentHoldRequestSchema>;

export const releaseDocumentHoldRequestSchema = z.object({
  releaseReason: z
    .string()
    .trim()
    .min(1, "A justificativa para liberação do bloqueio é obrigatória.")
    .max(500, "A justificativa de liberação deve ter no máximo 500 caracteres."),
});
export type ReleaseDocumentHoldRequestContract = z.infer<typeof releaseDocumentHoldRequestSchema>;

export const documentRetentionHoldResponseSchema = createApiResponseSchema(
  documentRetentionHoldSchema,
);

export const purgeEligibilitySchema = z.object({
  eligible: z.boolean(),
  blockReasons: z.array(
    z.enum([
      "DOCUMENT_NOT_FOUND",
      "NOT_IN_TRASH",
      "ACTIVE_HOLD",
      "TRASH_GRACE_WINDOW_NOT_ELAPSED",
      "RETENTION_WINDOW_NOT_ELAPSED",
    ]),
  ),
  activeHoldCount: z.number().int().min(0),
  applicablePolicyId: uuidSchema.nullable(),
  trashGraceEndsAt: isoDateTimeSchema.nullable(),
  retentionEndsAt: isoDateTimeSchema.nullable(),
});
export type PurgeEligibilityContract = z.infer<typeof purgeEligibilitySchema>;

export const documentRetentionHoldsStateResponseSchema = createApiResponseSchema(
  z.object({
    holds: z.array(documentRetentionHoldSchema),
    purgeEligibility: purgeEligibilitySchema,
  }),
);
