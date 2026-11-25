import { z } from "zod";

export const nodeEnvSchema = z.enum(["development", "test", "production"]);

export const MIN_UPLOAD_MAX_BYTES = 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_SYSTEM_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_PROXY_BODY_OVERHEAD_BYTES = 2 * 1024 * 1024;

export const DEFAULT_UPLOAD_ALLOWED_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".bmp",
  ".txt",
  ".log",
  ".md",
  ".csv",
  ".json",
  ".docx",
  ".xlsx",
  ".pptx",
];

export const SUPPORTED_UPLOAD_EXTENSIONS: readonly string[] = [
  ...DEFAULT_UPLOAD_ALLOWED_EXTENSIONS,
  ".doc",
  ".xls",
  ".ppt",
];

export const DANGEROUS_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".msp",
  ".scr",
  ".pif",
  ".lnk",
  ".hta",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".mjs",
  ".cjs",
  ".wsf",
  ".wsh",
  ".ps1",
  ".psm1",
  ".sh",
  ".bash",
  ".zsh",
  ".php",
  ".phtml",
  ".asp",
  ".aspx",
  ".jsp",
  ".py",
  ".rb",
  ".pl",
  ".cgi",
  ".jar",
  ".war",
  ".html",
  ".htm",
  ".xhtml",
  ".svg",
  ".swf",
]);

export function normalizeConfiguredUploadExtension(rawExt: string): string {
  const trimmed = rawExt.trim().toLowerCase();
  const prefixed = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  if (!/^\.[a-z0-9]{1,16}$/.test(prefixed)) {
    throw new Error(`Extensão de upload inválida na configuração: "${rawExt}".`);
  }
  if (DANGEROUS_UPLOAD_EXTENSIONS.has(prefixed)) {
    throw new Error(`Extensão perigosa proibida na configuração de upload: "${prefixed}".`);
  }
  if (!SUPPORTED_UPLOAD_EXTENSIONS.includes(prefixed)) {
    throw new Error(`Extensão não suportada na configuração de upload: "${prefixed}".`);
  }
  return prefixed;
}

export function parseUploadAllowedExtensionsEnv(rawValue: string | undefined): readonly string[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [...DEFAULT_UPLOAD_ALLOWED_EXTENSIONS];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of rawValue.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = normalizeConfiguredUploadExtension(trimmed);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  if (result.length === 0) {
    throw new Error("UPLOAD_ALLOWED_EXTENSIONS deve conter ao menos uma extensão permitida.");
  }
  return result;
}

export const uploadEnvPolicySchema = z
  .object({
    uploadMaxBytes: z.coerce
      .number()
      .int()
      .min(MIN_UPLOAD_MAX_BYTES)
      .max(MAX_SYSTEM_UPLOAD_BYTES)
      .default(DEFAULT_UPLOAD_MAX_BYTES),
    proxyMaxBodyBytes: z.coerce
      .number()
      .int()
      .min(MIN_UPLOAD_MAX_BYTES)
      .max(MAX_SYSTEM_UPLOAD_BYTES + DEFAULT_PROXY_BODY_OVERHEAD_BYTES * 4)
      .optional(),
    allowedExtensions: z
      .array(z.string())
      .min(1)
      .default([...DEFAULT_UPLOAD_ALLOWED_EXTENSIONS]),
    enforceDeclaredExtensionMatch: z.boolean().default(true),
  })
  .transform((parsed) => ({
    uploadMaxBytes: parsed.uploadMaxBytes,
    proxyMaxBodyBytes:
      parsed.proxyMaxBodyBytes ?? parsed.uploadMaxBytes + DEFAULT_PROXY_BODY_OVERHEAD_BYTES,
    allowedExtensions: parsed.allowedExtensions,
    enforceDeclaredExtensionMatch: parsed.enforceDeclaredExtensionMatch,
  }))
  .refine((parsed) => parsed.proxyMaxBodyBytes >= parsed.uploadMaxBytes, {
    message: "PROXY_MAX_BODY_BYTES não pode ser menor que UPLOAD_MAX_BYTES.",
  });

export type UploadEnvPolicyConfig = z.infer<typeof uploadEnvPolicySchema>;

export function parseUploadEnvPolicy(
  env: Readonly<Record<string, string | undefined>>,
): UploadEnvPolicyConfig {
  const enforceRaw = env.UPLOAD_ENFORCE_EXTENSION_MATCH?.trim().toLowerCase();
  const enforceDeclaredExtensionMatch = enforceRaw !== "false";
  return uploadEnvPolicySchema.parse({
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
    proxyMaxBodyBytes: env.PROXY_MAX_BODY_BYTES,
    allowedExtensions: parseUploadAllowedExtensionsEnv(env.UPLOAD_ALLOWED_EXTENSIONS),
    enforceDeclaredExtensionMatch,
  });
}

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
    .min(MIN_UPLOAD_MAX_BYTES)
    .max(MAX_SYSTEM_UPLOAD_BYTES)
    .default(DEFAULT_UPLOAD_MAX_BYTES),
  proxyMaxBodyBytes: z.coerce
    .number()
    .int()
    .min(MIN_UPLOAD_MAX_BYTES)
    .default(DEFAULT_UPLOAD_MAX_BYTES + DEFAULT_PROXY_BODY_OVERHEAD_BYTES),
  uploadAllowedExtensions: z
    .array(z.string())
    .min(1)
    .default([...DEFAULT_UPLOAD_ALLOWED_EXTENSIONS]),
});

export const workerConfigSchema = z.object({
  nodeEnv: nodeEnvSchema.default("development"),
  databaseUrl: z.string().min(1),
  encryptionKeyRef: z.string().min(32),
  concurrency: z.coerce.number().int().min(1).max(64).default(4),
  uploadMaxBytes: z.coerce
    .number()
    .int()
    .min(MIN_UPLOAD_MAX_BYTES)
    .max(MAX_SYSTEM_UPLOAD_BYTES)
    .default(DEFAULT_UPLOAD_MAX_BYTES),
  uploadAllowedExtensions: z
    .array(z.string())
    .min(1)
    .default([...DEFAULT_UPLOAD_ALLOWED_EXTENSIONS]),
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
  const uploadPolicy = parseUploadEnvPolicy(env);
  return apiConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    appUrl: env.APP_URL,
    databaseUrl: env.DATABASE_URL,
    sessionSecretRef: env.SESSION_SECRET,
    encryptionKeyRef: env.ENCRYPTION_KEY,
    uploadMaxBytes: uploadPolicy.uploadMaxBytes,
    proxyMaxBodyBytes: uploadPolicy.proxyMaxBodyBytes,
    uploadAllowedExtensions: uploadPolicy.allowedExtensions,
  });
}

export function getSafeApiConfigSummary(config: ApiConfig): Readonly<Record<string, unknown>> {
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    host: config.host,
    appUrl: config.appUrl,
    uploadMaxBytes: config.uploadMaxBytes,
    proxyMaxBodyBytes: config.proxyMaxBodyBytes,
    uploadAllowedExtensions: config.uploadAllowedExtensions,
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
