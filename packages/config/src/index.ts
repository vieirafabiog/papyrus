import { z } from "zod";

export const nodeEnvSchema = z.enum(["development", "test", "production"]);

export const apiConfigSchema = z.object({
  nodeEnv: nodeEnvSchema.default("development"),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().min(1).default("0.0.0.0"),
  appUrl: z.string().url(),
  databaseUrl: z.string().min(1),
  sessionSecretRef: z.string().min(32),
  encryptionKeyRef: z.string().min(32),
  uploadMaxBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
});

export const workerConfigSchema = z.object({
  nodeEnv: nodeEnvSchema.default("development"),
  databaseUrl: z.string().min(1),
  encryptionKeyRef: z.string().min(32),
  concurrency: z.coerce.number().int().min(1).max(64).default(4),
});

export const storageConfigSchema = z.object({
  defaultConnectionId: z.string().min(1),
  localRootPath: z.string().min(1).optional(),
});

export const webConfigSchema = z.object({
  apiBaseUrl: z.string().url(),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type WebConfig = z.infer<typeof webConfigSchema>;

export function parseApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  return apiConfigSchema.parse({
    nodeEnv: env["NODE_ENV"],
    port: env["PORT"],
    host: env["HOST"],
    appUrl: env["APP_URL"],
    databaseUrl: env["DATABASE_URL"],
    sessionSecretRef: env["SESSION_SECRET"],
    encryptionKeyRef: env["ENCRYPTION_KEY"],
    uploadMaxBytes: env["UPLOAD_MAX_BYTES"],
  });
}

export function getSafeApiConfigSummary(config: ApiConfig): Readonly<Record<string, unknown>> {
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    host: config.host,
    appUrl: config.appUrl,
    uploadMaxBytes: config.uploadMaxBytes,
    databaseConfigured: config.databaseUrl.length > 0,
    sessionSecretConfigured: config.sessionSecretRef.length >= 32,
    encryptionKeyConfigured: config.encryptionKeyRef.length >= 32,
  };
}
