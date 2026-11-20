import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./common.schema.js";

export const storageConnectionKindSchema = z.enum(["local", "s3", "azure_blob", "google_cloud"]);
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

export const createStorageConnectionContractSchema = z.union([
  createLocalStorageConnectionContractSchema,
  createS3StorageConnectionContractSchema,
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
    credentials: s3CredentialsContractSchema.optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "Informe ao menos um campo para atualização.",
  });
export type UpdateStorageConnectionContract = z.infer<typeof updateStorageConnectionContractSchema>;
