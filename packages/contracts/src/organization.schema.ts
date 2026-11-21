import { z } from "zod";
import { createApiResponseSchema, isoDateTimeSchema, uuidSchema } from "./common.schema.js";
import { ianaTimezoneSchema } from "./document.schema.js";

export const ORGANIZATION_LANGUAGES = ["pt-BR", "en-US", "es-ES"] as const;
export const organizationLanguageSchema = z.enum(ORGANIZATION_LANGUAGES);
export type OrganizationLanguage = z.infer<typeof organizationLanguageSchema>;

export const ORGANIZATION_DATE_FORMATS = ["DD/MM/YYYY", "YYYY-MM-DD", "MM/DD/YYYY"] as const;
export const organizationDateFormatSchema = z.enum(ORGANIZATION_DATE_FORMATS);
export type OrganizationDateFormat = z.infer<typeof organizationDateFormatSchema>;

export const ORGANIZATION_LIST_PAGE_SIZES = [10, 20, 50] as const;
export const organizationListPageSizeSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(50),
]);
export type OrganizationListPageSize = z.infer<typeof organizationListPageSizeSchema>;

export const organizationPreferencesSchema = z
  .object({
    defaultExpirationWindowDays: z.number().int().min(1).max(365),
    trashGraceDays: z.number().int().min(1).max(3650),
    dateFormat: organizationDateFormatSchema,
    defaultListPageSize: organizationListPageSizeSchema,
    auditDocumentViews: z.boolean(),
    auditDocumentDownloads: z.boolean(),
  })
  .strict();
export type OrganizationPreferencesContract = z.infer<typeof organizationPreferencesSchema>;

export const organizationPreferencesPatchSchema = organizationPreferencesSchema.partial().strict();
export type OrganizationPreferencesPatchContract = z.infer<
  typeof organizationPreferencesPatchSchema
>;

export const organizationRecordSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().min(1).max(80),
  defaultLanguage: organizationLanguageSchema,
  timezone: ianaTimezoneSchema,
  logoObjectKey: z.string().nullable(),
  preferences: organizationPreferencesSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type OrganizationRecordContract = z.infer<typeof organizationRecordSchema>;

export const organizationSettingsViewSchema = z.object({
  organization: organizationRecordSchema,
  canEdit: z.boolean(),
});
export type OrganizationSettingsViewContract = z.infer<typeof organizationSettingsViewSchema>;

export const organizationSettingsResponseSchema = createApiResponseSchema(
  organizationSettingsViewSchema,
);
export type OrganizationSettingsResponseContract = z.infer<
  typeof organizationSettingsResponseSchema
>;

export const updateOrganizationSettingsRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "O nome da organização deve ter pelo menos 2 caracteres.")
      .max(160, "O nome da organização deve ter no máximo 160 caracteres.")
      .optional(),
    defaultLanguage: organizationLanguageSchema.optional(),
    timezone: ianaTimezoneSchema.optional(),
    preferences: organizationPreferencesPatchSchema.optional(),
  })
  .strict()
  .refine(
    (payload) =>
      payload.name !== undefined ||
      payload.defaultLanguage !== undefined ||
      payload.timezone !== undefined ||
      (payload.preferences !== undefined && Object.keys(payload.preferences).length > 0),
    "Informe ao menos uma configuração da organização para atualizar.",
  );
export type UpdateOrganizationSettingsRequest = z.infer<
  typeof updateOrganizationSettingsRequestSchema
>;
