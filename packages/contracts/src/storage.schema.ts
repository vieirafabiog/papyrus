import { z } from "zod";
import { createApiResponseSchema, isoDateTimeSchema, uuidSchema } from "./common.schema.js";

export const storageConnectionKindSchema = z.enum([
  "local",
  "s3",
  "sharepoint",
  "azure_blob",
  "google_cloud",
]);
export type StorageConnectionKindContract = z.infer<typeof storageConnectionKindSchema>;

export const storageConnectionStatusSchema = z.enum(["ACTIVE", "INACTIVE", "ERROR"]);
export type StorageConnectionStatusContract = z.infer<typeof storageConnectionStatusSchema>;

export const storageNonSecretConfigValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const storageConnectionViewSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  name: z.string().min(1).max(120),
  kind: storageConnectionKindSchema,
  isDefault: z.boolean(),
  status: storageConnectionStatusSchema,
  nonSecretConfig: z.record(storageNonSecretConfigValueSchema),
  hasCredentials: z.boolean(),
  lastHealthCheckAt: isoDateTimeSchema.nullable(),
  lastHealthMessage: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type StorageConnectionViewContract = z.infer<typeof storageConnectionViewSchema>;

export const storageHealthStatusSchema = z.object({
  healthy: z.boolean(),
  message: z.string().min(1),
  checkedAt: isoDateTimeSchema,
});

export const storageConnectionTestResultSchema = z.object({
  connection: storageConnectionViewSchema,
  health: storageHealthStatusSchema,
});
export type StorageConnectionTestResultContract = z.infer<typeof storageConnectionTestResultSchema>;

export const localRootDirectoryContractSchema = z
  .string()
  .trim()
  .min(2)
  .max(512)
  .refine((value) => value.startsWith("/") && value !== "/", {
    message: "Informe um diretório absoluto válido distinto da raiz do sistema.",
  });

export const s3CredentialsContractSchema = z.object({
  accessKeyId: z
    .string()
    .trim()
    .min(3)
    .max(256)
    .refine((val) => !/\s/.test(val), "accessKeyId não pode conter espaços."),
  secretAccessKey: z.string().min(8).max(512),
  sessionToken: z.string().min(1).max(4096).optional(),
});

export const s3TlsContractSchema = z.object({
  rejectUnauthorized: z.boolean().default(true),
  allowInsecureHttp: z.boolean().default(false),
  caCertificatePem: z.string().trim().min(1).max(65_536).optional(),
});

export const s3TimeoutsContractSchema = z.object({
  connectionTimeoutMs: z.number().int().min(500).max(60_000).default(5_000),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

export const sharePointCredentialsContractSchema = z.object({
  clientSecret: z.string().min(4).max(512),
});

export const sharePointTimeoutsContractSchema = z.object({
  connectionTimeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
});

export const createLocalStorageConnectionContractSchema = z.object({
  kind: z.literal("local").default("local"),
  name: z.string().trim().min(1).max(120),
  rootDirectory: localRootDirectoryContractSchema,
  isDefault: z.boolean().optional(),
  maxObjectSizeBytes: z.number().int().positive().optional(),
  minFreeBytes: z.number().int().nonnegative().optional(),
});

export const createS3StorageConnectionContractSchema = z.object({
  kind: z.literal("s3"),
  name: z.string().trim().min(1).max(120),
  endpoint: z.string().trim().min(1).max(512),
  region: z.string().trim().min(2).max(64),
  bucket: z.string().trim().min(3).max(63),
  forcePathStyle: z.boolean().default(false),
  keyPrefix: z.string().trim().max(256).optional(),
  tls: s3TlsContractSchema.optional(),
  timeouts: s3TimeoutsContractSchema.optional(),
  credentials: s3CredentialsContractSchema,
  isDefault: z.boolean().optional(),
});

export const createSharePointStorageConnectionContractSchema = z.object({
  kind: z.literal("sharepoint"),
  name: z.string().trim().min(1).max(120),
  tenantId: z
    .string()
    .trim()
    .min(3)
    .max(128)
    .refine((val) => !/\s/.test(val), "tenantId não pode conter espaços."),
  clientId: z
    .string()
    .trim()
    .min(8)
    .max(64)
    .refine((val) => !/\s/.test(val), "clientId não pode conter espaços."),
  siteUrl: z.string().trim().min(12).max(512),
  libraryName: z.string().trim().min(1).max(200).optional(),
  driveId: z.string().trim().min(4).max(200).optional(),
  baseFolderPath: z.string().trim().max(256).optional(),
  timeouts: sharePointTimeoutsContractSchema.optional(),
  credentials: sharePointCredentialsContractSchema,
  isDefault: z.boolean().optional(),
});

export const createStorageConnectionContractSchema = z.union([
  createLocalStorageConnectionContractSchema,
  createS3StorageConnectionContractSchema,
  createSharePointStorageConnectionContractSchema,
]);
export type CreateStorageConnectionContract = z.infer<typeof createStorageConnectionContractSchema>;

export const updateStorageConnectionContractSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isDefault: z.boolean().optional(),
    rootDirectory: localRootDirectoryContractSchema.optional(),
    maxObjectSizeBytes: z.number().int().positive().optional(),
    minFreeBytes: z.number().int().nonnegative().optional(),
    endpoint: z.string().trim().min(1).max(512).optional(),
    region: z.string().trim().min(2).max(64).optional(),
    bucket: z.string().trim().min(3).max(63).optional(),
    forcePathStyle: z.boolean().optional(),
    keyPrefix: z.string().trim().max(256).nullable().optional(),
    tls: s3TlsContractSchema.partial().optional(),
    timeouts: s3TimeoutsContractSchema.partial().optional(),
    tenantId: z
      .string()
      .trim()
      .min(3)
      .max(128)
      .refine((val) => !/\s/.test(val), "tenantId não pode conter espaços.")
      .optional(),
    clientId: z
      .string()
      .trim()
      .min(8)
      .max(64)
      .refine((val) => !/\s/.test(val), "clientId não pode conter espaços.")
      .optional(),
    siteUrl: z.string().trim().min(12).max(512).optional(),
    libraryName: z.string().trim().min(1).max(200).nullable().optional(),
    driveId: z.string().trim().min(4).max(200).nullable().optional(),
    baseFolderPath: z.string().trim().max(256).nullable().optional(),
    credentials: z
      .union([s3CredentialsContractSchema, sharePointCredentialsContractSchema])
      .optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "Informe ao menos um campo para atualização.",
  });
export type UpdateStorageConnectionContract = z.infer<typeof updateStorageConnectionContractSchema>;

export const storageConnectionResponseSchema = createApiResponseSchema(storageConnectionViewSchema);
export type StorageConnectionResponseContract = z.infer<typeof storageConnectionResponseSchema>;

export const storageConnectionListResponseSchema = createApiResponseSchema(
  z.array(storageConnectionViewSchema),
);
export type StorageConnectionListResponseContract = z.infer<
  typeof storageConnectionListResponseSchema
>;

export const storageConnectionTestResponseSchema = createApiResponseSchema(
  storageConnectionTestResultSchema,
);
export type StorageConnectionTestResponseContract = z.infer<
  typeof storageConnectionTestResponseSchema
>;

export const storageRoutingRuleViewSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  categoryId: uuidSchema.nullable(),
  storageConnectionId: uuidSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type StorageRoutingRuleViewContract = z.infer<typeof storageRoutingRuleViewSchema>;

export const storageRoutingRuleListResponseSchema = createApiResponseSchema(
  z.array(storageRoutingRuleViewSchema),
);
export type StorageRoutingRuleListResponseContract = z.infer<
  typeof storageRoutingRuleListResponseSchema
>;

export const storageRoutingRuleResponseSchema = createApiResponseSchema(
  storageRoutingRuleViewSchema,
);
export type StorageRoutingRuleResponseContract = z.infer<typeof storageRoutingRuleResponseSchema>;

export const upsertStorageRoutingRuleRequestSchema = z.object({
  categoryId: uuidSchema.nullable(),
  storageConnectionId: uuidSchema,
});
export type UpsertStorageRoutingRuleRequest = z.infer<typeof upsertStorageRoutingRuleRequestSchema>;
