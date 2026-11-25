import { z } from "zod";
import { createApiResponseSchema, isoDateTimeSchema, uuidSchema } from "./common.schema.js";

export const MIN_SHARE_LINK_TTL_MINUTES = 5;
export const MAX_SHARE_LINK_TTL_MINUTES = 30 * 24 * 60;
export const DEFAULT_SHARE_LINK_TTL_MINUTES = 24 * 60;
export const MAX_SHARE_LINK_MAX_USES = 1000;
export const MIN_SHARE_PASSCODE_LENGTH = 6;
export const MAX_SHARE_PASSCODE_LENGTH = 128;

export const DOCUMENT_SHARE_LINK_STATUSES = ["ACTIVE", "EXPIRED", "REVOKED", "EXHAUSTED"] as const;

export const documentShareLinkStatusSchema = z.enum(DOCUMENT_SHARE_LINK_STATUSES);
export type DocumentShareLinkStatus = z.infer<typeof documentShareLinkStatusSchema>;

export const createDocumentShareLinkRequestSchema = z.object({
  expiresInMinutes: z
    .number()
    .int("A validade deve ser um número inteiro de minutos.")
    .min(
      MIN_SHARE_LINK_TTL_MINUTES,
      `A validade mínima é de ${MIN_SHARE_LINK_TTL_MINUTES} minutos.`,
    )
    .max(
      MAX_SHARE_LINK_TTL_MINUTES,
      "A validade máxima permitida para links temporários é de 30 dias.",
    )
    .default(DEFAULT_SHARE_LINK_TTL_MINUTES),
  maxUses: z
    .number()
    .int("O limite de acessos deve ser um número inteiro positivo.")
    .min(1, "O limite mínimo de acessos é 1.")
    .max(MAX_SHARE_LINK_MAX_USES, `O limite máximo permitido é ${MAX_SHARE_LINK_MAX_USES}.`)
    .nullable()
    .optional(),
  allowDownload: z.boolean().default(true),
  passcode: z
    .string()
    .min(
      MIN_SHARE_PASSCODE_LENGTH,
      `A senha do link deve ter ao menos ${MIN_SHARE_PASSCODE_LENGTH} caracteres.`,
    )
    .max(MAX_SHARE_PASSCODE_LENGTH, "A senha do link excede o tamanho máximo permitido.")
    .nullable()
    .optional(),
  label: z
    .string()
    .trim()
    .max(120, "O rótulo deve ter no máximo 120 caracteres.")
    .nullable()
    .optional(),
  versionId: uuidSchema.nullable().optional(),
});
export type CreateDocumentShareLinkRequest = z.infer<typeof createDocumentShareLinkRequestSchema>;

export const documentShareLinkRecordSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
  documentVersionId: uuidSchema,
  label: z.string().nullable(),
  allowDownload: z.boolean(),
  requiresPasscode: z.boolean(),
  maxUses: z.number().int().min(1).nullable(),
  useCount: z.number().int().min(0),
  expiresAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
  lastAccessedAt: isoDateTimeSchema.nullable(),
  status: documentShareLinkStatusSchema,
  createdBy: z.object({
    id: uuidSchema,
    fullName: z.string().min(1).max(160),
  }),
  createdAt: isoDateTimeSchema,
});
export type DocumentShareLinkRecord = z.infer<typeof documentShareLinkRecordSchema>;

export const createdDocumentShareLinkResponseSchema = createApiResponseSchema(
  z.object({
    link: documentShareLinkRecordSchema,
    shareToken: z.string().min(32),
  }),
);
export type CreatedDocumentShareLinkResponse = z.infer<
  typeof createdDocumentShareLinkResponseSchema
>;

export const documentShareLinkListResponseSchema = createApiResponseSchema(
  z.object({
    items: z.array(documentShareLinkRecordSchema),
  }),
);
export type DocumentShareLinkListResponse = z.infer<typeof documentShareLinkListResponseSchema>;

export const revokeDocumentShareLinkResponseSchema = createApiResponseSchema(
  z.object({
    revoked: z.literal(true),
    shareLinkId: uuidSchema,
  }),
);
export type RevokeDocumentShareLinkResponse = z.infer<typeof revokeDocumentShareLinkResponseSchema>;

export const publicShareMetadataSchema = z.object({
  title: z.string().min(1).max(255),
  originalFileName: z.string().min(1).max(255),
  detectedContentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  allowDownload: z.boolean(),
  requiresPasscode: z.boolean(),
  unlocked: z.boolean(),
  expiresAt: isoDateTimeSchema,
  maxUses: z.number().int().min(1).nullable(),
  remainingUses: z.number().int().min(0).nullable(),
});
export type PublicShareMetadata = z.infer<typeof publicShareMetadataSchema>;

export const publicShareMetadataResponseSchema = createApiResponseSchema(publicShareMetadataSchema);
export type PublicShareMetadataResponse = z.infer<typeof publicShareMetadataResponseSchema>;

export const unlockPublicShareRequestSchema = z.object({
  passcode: z
    .string()
    .min(1, "Informe a senha de proteção do link.")
    .max(MAX_SHARE_PASSCODE_LENGTH),
});
export type UnlockPublicShareRequest = z.infer<typeof unlockPublicShareRequestSchema>;

export const unlockPublicShareResponseSchema = createApiResponseSchema(
  z.object({
    unlockToken: z.string().min(16),
    expiresInSeconds: z.number().int().positive(),
  }),
);
export type UnlockPublicShareResponse = z.infer<typeof unlockPublicShareResponseSchema>;
