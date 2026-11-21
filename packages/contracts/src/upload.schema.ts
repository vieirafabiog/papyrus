import { z } from "zod";
import { createApiResponseSchema, isoDateTimeSchema, uuidSchema } from "./common.schema.js";
import { fileObjectStatusSchema, sha256ChecksumSchema } from "./document.schema.js";

export const MIN_UPLOAD_MAX_BYTES = 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_SYSTEM_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_PROXY_MAX_BODY_BYTES = 52 * 1024 * 1024;

export interface UploadFormatCatalogEntry {
  readonly extension: string;
  readonly mimeTypes: readonly string[];
  readonly label: string;
}

export const SAFE_UPLOAD_FORMAT_CATALOG: readonly UploadFormatCatalogEntry[] = [
  { extension: ".pdf", mimeTypes: ["application/pdf"], label: "Documento PDF (.pdf)" },
  { extension: ".png", mimeTypes: ["image/png"], label: "Imagem PNG (.png)" },
  { extension: ".jpg", mimeTypes: ["image/jpeg"], label: "Imagem JPEG (.jpg)" },
  { extension: ".jpeg", mimeTypes: ["image/jpeg"], label: "Imagem JPEG (.jpeg)" },
  { extension: ".webp", mimeTypes: ["image/webp"], label: "Imagem WebP (.webp)" },
  { extension: ".gif", mimeTypes: ["image/gif"], label: "Imagem GIF (.gif)" },
  { extension: ".tif", mimeTypes: ["image/tiff"], label: "Imagem TIFF (.tif)" },
  { extension: ".tiff", mimeTypes: ["image/tiff"], label: "Imagem TIFF (.tiff)" },
  { extension: ".bmp", mimeTypes: ["image/bmp"], label: "Imagem BMP (.bmp)" },
  { extension: ".txt", mimeTypes: ["text/plain"], label: "Texto simples (.txt)" },
  { extension: ".log", mimeTypes: ["text/plain"], label: "Arquivo de log (.log)" },
  { extension: ".md", mimeTypes: ["text/plain"], label: "Documento Markdown (.md)" },
  { extension: ".csv", mimeTypes: ["text/csv"], label: "Planilha CSV (.csv)" },
  { extension: ".json", mimeTypes: ["application/json"], label: "Dados JSON (.json)" },
  {
    extension: ".docx",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    label: "Microsoft Word (.docx)",
  },
  {
    extension: ".xlsx",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    label: "Microsoft Excel (.xlsx)",
  },
  {
    extension: ".pptx",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    label: "Microsoft PowerPoint (.pptx)",
  },
  {
    extension: ".doc",
    mimeTypes: ["application/x-ole-storage"],
    label: "Word legado (.doc)",
  },
  {
    extension: ".xls",
    mimeTypes: ["application/x-ole-storage"],
    label: "Excel legado (.xls)",
  },
  {
    extension: ".ppt",
    mimeTypes: ["application/x-ole-storage"],
    label: "PowerPoint legado (.ppt)",
  },
];

export const DEFAULT_UPLOAD_ALLOWED_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".txt",
  ".csv",
  ".docx",
  ".xlsx",
  ".pptx",
];

export const DANGEROUS_UPLOAD_EXTENSIONS: readonly string[] = [
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
];

const SAFE_EXTENSION_MAP: ReadonlyMap<string, UploadFormatCatalogEntry> = new Map(
  SAFE_UPLOAD_FORMAT_CATALOG.map((entry) => [entry.extension, entry]),
);

const DANGEROUS_EXTENSION_SET = new Set<string>(DANGEROUS_UPLOAD_EXTENSIONS);

export function normalizeUploadExtensionContract(rawExt: string): string {
  const trimmed = rawExt.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

export function resolveAllowedMimeTypesForExtensions(
  extensions: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawExt of extensions) {
    const ext = normalizeUploadExtensionContract(rawExt);
    const entry = SAFE_EXTENSION_MAP.get(ext);
    if (!entry) {
      continue;
    }
    for (const mime of entry.mimeTypes) {
      if (!seen.has(mime)) {
        seen.add(mime);
        result.push(mime);
      }
    }
  }
  return result;
}

export const allowedUploadExtensionSchema = z
  .string()
  .trim()
  .min(2, "Extensão inválida.")
  .max(17, "Extensão muito longa.")
  .transform((value) => normalizeUploadExtensionContract(value))
  .refine((ext) => /^\.[a-z0-9]{1,16}$/.test(ext), "Formato de extensão inválido.")
  .refine(
    (ext) => !DANGEROUS_EXTENSION_SET.has(ext),
    "Extensão potencialmente executável ou perigosa não pode ser permitida.",
  )
  .refine((ext) => SAFE_EXTENSION_MAP.has(ext), "Extensão não suportada pelo catálogo seguro.");

export const uploadFormatOptionSchema = z.object({
  extension: z.string(),
  mimeTypes: z.array(z.string()),
  label: z.string(),
});

export const uploadLimitsConfigSchema = z.object({
  maxFileSizeBytes: z
    .number()
    .int()
    .min(MIN_UPLOAD_MAX_BYTES, "O tamanho mínimo configurável é 1024 bytes (1 KB).")
    .max(MAX_SYSTEM_UPLOAD_BYTES, "O tamanho máximo não pode exceder 1 GB."),
  allowedExtensions: z
    .array(allowedUploadExtensionSchema)
    .min(1, "Selecione ao menos uma extensão de arquivo permitida."),
  enforceDeclaredExtensionMatch: z.boolean(),
});
export type UploadLimitsConfigContract = z.infer<typeof uploadLimitsConfigSchema>;

export const effectiveUploadLimitsSchema = z.object({
  maxFileSizeBytes: z.number().int().positive(),
  allowedExtensions: z.array(z.string()),
  allowedMimeTypes: z.array(z.string()),
  enforceDeclaredExtensionMatch: z.boolean(),
  systemMaxUploadBytes: z.number().int().positive(),
  proxyMaxBodyBytes: z.number().int().positive(),
  effectiveMaxWithProxyBytes: z.number().int().positive(),
});
export type EffectiveUploadLimitsContract = z.infer<typeof effectiveUploadLimitsSchema>;

export const uploadLimitsViewSchema = z.object({
  configured: uploadLimitsConfigSchema,
  effective: effectiveUploadLimitsSchema,
  supportedCatalog: z.array(uploadFormatOptionSchema),
  canEdit: z.boolean(),
  updatedAt: isoDateTimeSchema,
});
export type UploadLimitsViewContract = z.infer<typeof uploadLimitsViewSchema>;

export const uploadLimitsResponseSchema = createApiResponseSchema(uploadLimitsViewSchema);
export type UploadLimitsResponseContract = z.infer<typeof uploadLimitsResponseSchema>;

export const updateUploadLimitsRequestSchema = z
  .object({
    maxFileSizeBytes: uploadLimitsConfigSchema.shape.maxFileSizeBytes.optional(),
    allowedExtensions: uploadLimitsConfigSchema.shape.allowedExtensions.optional(),
    enforceDeclaredExtensionMatch: z.boolean().optional(),
  })
  .strict()
  .refine(
    (payload) =>
      payload.maxFileSizeBytes !== undefined ||
      payload.allowedExtensions !== undefined ||
      payload.enforceDeclaredExtensionMatch !== undefined,
    "Informe ao menos uma configuração de limite ou extensão para atualizar.",
  );
export type UpdateUploadLimitsRequestContract = z.infer<typeof updateUploadLimitsRequestSchema>;

export const uploadSessionStatusSchema = z.enum([
  "PENDING",
  "UPLOADED",
  "FINALIZED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
]);
export type UploadSessionStatusContract = z.infer<typeof uploadSessionStatusSchema>;

export const createUploadSessionRequestSchema = z.object({
  documentId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  folderId: uuidSchema.nullable().optional(),
  storageConnectionId: uuidSchema.optional(),
  originalFileName: z.string().trim().min(1).max(255),
  declaredSizeBytes: z.number().int().positive(),
  declaredContentType: z.string().trim().min(1).max(255),
  declaredChecksumSha256: sha256ChecksumSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
  expiresInSeconds: z.number().int().min(60).max(3_600).optional(),
});
export type CreateUploadSessionRequestContract = z.infer<typeof createUploadSessionRequestSchema>;

export const uploadSessionRecordSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  userId: uuidSchema,
  storageConnectionId: uuidSchema,
  fileObjectId: uuidSchema,
  objectKey: z.string().min(1).max(512),
  declaredSizeBytes: z.number().int().positive(),
  declaredContentType: z.string().min(1).max(255),
  idempotencyKey: z.string().min(1).max(128),
  status: uploadSessionStatusSchema,
  expiresAt: isoDateTimeSchema,
  finalizedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type UploadSessionRecordContract = z.infer<typeof uploadSessionRecordSchema>;

export const uploadContentResponseSchema = z.object({
  sessionId: uuidSchema,
  fileObjectId: uuidSchema,
  storageConnectionId: uuidSchema,
  status: uploadSessionStatusSchema,
  fileObjectStatus: fileObjectStatusSchema,
  bytesReceived: z.number().int().positive(),
  expectedBytes: z.number().int().positive(),
  progressPercent: z.number().int().min(0).max(100),
  checksumSha256: sha256ChecksumSchema,
});
export type UploadContentResponseContract = z.infer<typeof uploadContentResponseSchema>;

export const createSignedUploadTargetRequestSchema = z
  .object({
    expiresInSeconds: z.number().int().min(10).max(900).optional(),
  })
  .strict();
export type CreateSignedUploadTargetRequestContract = z.infer<
  typeof createSignedUploadTargetRequestSchema
>;

export const signedUploadTargetSchema = z.object({
  url: z.string().url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDateTimeSchema,
});
export type SignedUploadTargetContract = z.infer<typeof signedUploadTargetSchema>;

export const signedUploadTargetResponseSchema = z.object({
  sessionId: uuidSchema,
  fileObjectId: uuidSchema,
  storageConnectionId: uuidSchema,
  uploadMode: z.literal("SIGNED_UPLOAD"),
  finalizationRequired: z.literal(true),
  status: uploadSessionStatusSchema,
  fileObjectStatus: fileObjectStatusSchema,
  target: signedUploadTargetSchema,
});
export type SignedUploadTargetResponseContract = z.infer<typeof signedUploadTargetResponseSchema>;
