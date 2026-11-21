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

export const smtpSecurityModeSchema = z.enum(["NONE", "STARTTLS", "TLS"]);

export const smtpEnvConfigSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !/[\r\n\0]/.test(value), "Host SMTP inválido."),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  securityMode: smtpSecurityModeSchema.default("STARTTLS"),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().min(1).max(1024).optional(),
  from: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .refine((value) => !/[\r\n\0]/.test(value), "Remetente SMTP inválido."),
  timeoutMs: z.coerce.number().int().min(500).max(60_000).default(10_000),
});

export const webConfigSchema = z.object({
  apiBaseUrl: z.string().url(),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type SmtpSecurityModeConfig = z.infer<typeof smtpSecurityModeSchema>;
export type SmtpEnvConfig = z.infer<typeof smtpEnvConfigSchema>;
export type WebConfig = z.infer<typeof webConfigSchema>;

/**
 * Parses optional SMTP fallback settings from environment variables.
 * Returns `null` when `SMTP_HOST` is omitted, because SMTP is strictly optional.
 */
export function parseOptionalSmtpEnvConfig(
  env: Readonly<Record<string, string | undefined>>,
): SmtpEnvConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) {
    return null;
  }

  const secureRaw = env.SMTP_SECURE?.trim().toLowerCase();
  const explicitMode = env.SMTP_SECURITY_MODE?.trim().toUpperCase();
  const inferredMode =
    explicitMode === "NONE" || explicitMode === "STARTTLS" || explicitMode === "TLS"
      ? explicitMode
      : secureRaw === "true"
        ? "TLS"
        : "STARTTLS";

  const username = env.SMTP_USER?.trim();
  const password = env.SMTP_PASS;

  return smtpEnvConfigSchema.parse({
    host,
    port: env.SMTP_PORT,
    securityMode: inferredMode,
    username: username && username.length > 0 ? username : undefined,
    password: password !== undefined && password.length > 0 ? password : undefined,
    from: env.SMTP_FROM,
    timeoutMs: env.SMTP_TIMEOUT_MS,
  });
}

export function getSafeSmtpConfigSummary(
  config: SmtpEnvConfig | null,
): Readonly<Record<string, unknown>> {
  if (!config) {
    return { enabled: false };
  }
  return {
    enabled: true,
    host: config.host,
    port: config.port,
    securityMode: config.securityMode,
    from: config.from,
    authConfigured: Boolean(config.username && config.password),
    timeoutMs: config.timeoutMs,
  };
}

export function parseApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  return apiConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    appUrl: env.APP_URL,
    databaseUrl: env.DATABASE_URL,
    sessionSecretRef: env.SESSION_SECRET,
    encryptionKeyRef: env.ENCRYPTION_KEY,
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
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

export {
  type LoadedMasterKeyring,
  loadMasterEncryptionKey,
  loadMasterKeyring,
  MasterKeyConfigError,
  parseMasterKeyMaterial,
} from "./secrets.js";
