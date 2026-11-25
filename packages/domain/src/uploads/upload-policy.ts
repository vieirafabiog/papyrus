import { createAuditWriter } from "../audit/audit-writer.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";

export const DOMAIN_MIN_UPLOAD_MAX_BYTES = 1024;
export const DOMAIN_DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const DOMAIN_MAX_SYSTEM_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const DOMAIN_DEFAULT_PROXY_MAX_BODY_BYTES = 52 * 1024 * 1024;

export interface SafeDomainFormatRule {
  readonly extension: string;
  readonly mimeTypes: readonly string[];
  readonly label: string;
}

export const DOMAIN_SAFE_UPLOAD_FORMAT_CATALOG: readonly SafeDomainFormatRule[] = [
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
  { extension: ".doc", mimeTypes: ["application/x-ole-storage"], label: "Word legado (.doc)" },
  { extension: ".xls", mimeTypes: ["application/x-ole-storage"], label: "Excel legado (.xls)" },
  {
    extension: ".ppt",
    mimeTypes: ["application/x-ole-storage"],
    label: "PowerPoint legado (.ppt)",
  },
];

export const DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS: readonly string[] = [
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

const DANGEROUS_EXTENSIONS = new Set<string>([
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

const SAFE_FORMAT_BY_EXTENSION: ReadonlyMap<string, SafeDomainFormatRule> = new Map(
  DOMAIN_SAFE_UPLOAD_FORMAT_CATALOG.map((entry) => [entry.extension, entry]),
);

const MIME_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-ms-bmp": "image/bmp",
  "image/x-bmp": "image/bmp",
  "application/x-pdf": "application/pdf",
  "application/acrobat": "application/pdf",
  "application/csv": "text/csv",
  "text/x-csv": "text/csv",
  "application/vnd.ms-excel": "text/csv",
  "text/json": "application/json",
  "text/markdown": "text/plain",
  "text/x-markdown": "text/plain",
};

export interface StoredUploadLimitsRecord {
  readonly organizationId: string;
  readonly maxFileSizeBytes: number | null;
  readonly allowedExtensions: readonly string[] | null;
  readonly enforceDeclaredExtensionMatch: boolean | null;
  readonly updatedAt: string;
}

export interface UploadLimitsConfig {
  readonly maxFileSizeBytes: number;
  readonly allowedExtensions: readonly string[];
  readonly enforceDeclaredExtensionMatch: boolean;
}

export interface EffectiveUploadPolicy {
  readonly maxFileSizeBytes: number;
  readonly allowedExtensions: readonly string[];
  readonly allowedMimeTypes: readonly string[];
  readonly enforceDeclaredExtensionMatch: boolean;
  readonly systemMaxUploadBytes: number;
  readonly proxyMaxBodyBytes: number;
  readonly effectiveMaxWithProxyBytes: number;
}

export interface UploadLimitsView {
  readonly configured: UploadLimitsConfig;
  readonly effective: EffectiveUploadPolicy;
  readonly updatedAt: string;
}

export interface UploadPolicyRepositoryPort {
  getUploadLimits(
    organizationId: string,
    tx?: TransactionContext,
  ): Promise<StoredUploadLimitsRecord | null>;
  saveUploadLimits(
    organizationId: string,
    input: UploadLimitsConfig & { readonly updatedAt: Date },
    tx?: TransactionContext,
  ): Promise<StoredUploadLimitsRecord | null>;
}

export interface UpdateUploadLimitsCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly maxFileSizeBytes?: number | undefined;
  readonly allowedExtensions?: readonly string[] | undefined;
  readonly enforceDeclaredExtensionMatch?: boolean | undefined;
}

export interface UploadLimitsServiceDependencies {
  readonly repository: UploadPolicyRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly systemMaxUploadBytes?: number | undefined;
  readonly proxyMaxBodyBytes?: number | undefined;
  readonly defaultAllowedExtensions?: readonly string[] | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface UploadLimitsService {
  getLimits(organizationId: string): Promise<UploadLimitsView>;
  getEffectivePolicy(organizationId: string): Promise<EffectiveUploadPolicy>;
  updateLimits(command: UpdateUploadLimitsCommand): Promise<UploadLimitsView>;
}

/**
 * Extracts and normalizes a lowercase dot-prefixed extension from a file name.
 */
export function extractNormalizedFileExtension(fileName: string): string {
  const baseName = fileName.trim().split(/[/\\]/).pop() ?? "";
  const dotIdx = baseName.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === baseName.length - 1) {
    return "";
  }
  return baseName.slice(dotIdx).toLowerCase();
}

/**
 * Resolves the canonical MIME type list for a validated set of extensions.
 */
export function resolveMimeTypesForExtensions(extensions: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const mimes: string[] = [];
  for (const rawExt of extensions) {
    const ext = rawExt.trim().toLowerCase();
    const rule = SAFE_FORMAT_BY_EXTENSION.get(ext);
    if (!rule) {
      continue;
    }
    for (const mime of rule.mimeTypes) {
      if (!seen.has(mime)) {
        seen.add(mime);
        mimes.push(mime);
      }
    }
  }
  return mimes;
}

export function normalizeDeclaredUploadMimeType(rawMime: string): string | null {
  const base = rawMime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base) {
    return null;
  }
  return MIME_ALIASES[base] ?? base;
}

function validateAndNormalizeExtensions(rawExtensions: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of rawExtensions) {
    const trimmed = item.trim().toLowerCase();
    const ext = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (!/^\.[a-z0-9]{1,16}$/.test(ext)) {
      throw new DomainError("INVALID_UPLOAD_LIMITS", `Formato de extensão inválido: "${item}".`);
    }
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      throw new DomainError(
        "INVALID_UPLOAD_LIMITS",
        `A extensão "${ext}" é proibida pela política de segurança e não pode ser habilitada.`,
      );
    }
    if (!SAFE_FORMAT_BY_EXTENSION.has(ext)) {
      throw new DomainError(
        "INVALID_UPLOAD_LIMITS",
        `A extensão "${ext}" não é suportada pelo catálogo seguro de formatos.`,
      );
    }
    if (!seen.has(ext)) {
      seen.add(ext);
      normalized.push(ext);
    }
  }

  if (normalized.length === 0) {
    throw new DomainError(
      "INVALID_UPLOAD_LIMITS",
      "Selecione ao menos uma extensão permitida para upload.",
    );
  }
  return normalized;
}

/**
 * Domain service for reading, validating, and updating organization upload size
 * and allowed file extension limits consistently with API and proxy bounds.
 */
export function createUploadLimitsService(
  deps: UploadLimitsServiceDependencies,
): UploadLimitsService {
  const auditWriter = createAuditWriter({ repository: deps.audit });
  const nowFn = deps.now ?? (() => new Date());
  const systemMaxUploadBytes = Math.min(
    DOMAIN_MAX_SYSTEM_UPLOAD_BYTES,
    Math.max(
      DOMAIN_MIN_UPLOAD_MAX_BYTES,
      deps.systemMaxUploadBytes ?? DOMAIN_DEFAULT_UPLOAD_MAX_BYTES,
    ),
  );
  const proxyMaxBodyBytes = Math.max(
    DOMAIN_MIN_UPLOAD_MAX_BYTES,
    deps.proxyMaxBodyBytes ?? Math.max(systemMaxUploadBytes, DOMAIN_DEFAULT_PROXY_MAX_BODY_BYTES),
  );
  const fallbackExtensions = deps.defaultAllowedExtensions
    ? validateAndNormalizeExtensions(deps.defaultAllowedExtensions)
    : DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS;

  const toView = (stored: StoredUploadLimitsRecord): UploadLimitsView => {
    const configuredMax =
      stored.maxFileSizeBytes !== null &&
      Number.isInteger(stored.maxFileSizeBytes) &&
      stored.maxFileSizeBytes >= DOMAIN_MIN_UPLOAD_MAX_BYTES
        ? stored.maxFileSizeBytes
        : systemMaxUploadBytes;

    let configuredExtensions: readonly string[] = fallbackExtensions;
    if (stored.allowedExtensions && stored.allowedExtensions.length > 0) {
      const validStored = stored.allowedExtensions.filter((ext) =>
        SAFE_FORMAT_BY_EXTENSION.has(ext.trim().toLowerCase()),
      );
      if (validStored.length > 0) {
        configuredExtensions = validStored.map((ext) => ext.trim().toLowerCase());
      }
    }

    const enforceMatch = stored.enforceDeclaredExtensionMatch ?? true;
    const effectiveMaxWithProxy = Math.min(configuredMax, systemMaxUploadBytes, proxyMaxBodyBytes);
    const allowedMimeTypes = resolveMimeTypesForExtensions(configuredExtensions);

    return {
      configured: {
        maxFileSizeBytes: configuredMax,
        allowedExtensions: configuredExtensions,
        enforceDeclaredExtensionMatch: enforceMatch,
      },
      effective: {
        maxFileSizeBytes: effectiveMaxWithProxy,
        allowedExtensions: configuredExtensions,
        allowedMimeTypes,
        enforceDeclaredExtensionMatch: enforceMatch,
        systemMaxUploadBytes,
        proxyMaxBodyBytes,
        effectiveMaxWithProxyBytes: effectiveMaxWithProxy,
      },
      updatedAt: stored.updatedAt,
    };
  };

  return {
    async getLimits(organizationId: string): Promise<UploadLimitsView> {
      const stored = await deps.repository.getUploadLimits(organizationId);
      if (!stored) {
        throw new DomainError("ORGANIZATION_NOT_FOUND", "Organização não encontrada.");
      }
      return toView(stored);
    },

    async getEffectivePolicy(organizationId: string): Promise<EffectiveUploadPolicy> {
      const view = await this.getLimits(organizationId);
      return view.effective;
    },

    async updateLimits(command: UpdateUploadLimitsCommand): Promise<UploadLimitsView> {
      if (
        command.maxFileSizeBytes === undefined &&
        command.allowedExtensions === undefined &&
        command.enforceDeclaredExtensionMatch === undefined
      ) {
        throw new DomainError(
          "INVALID_UPLOAD_LIMITS",
          "Informe ao menos uma configuração de upload para atualizar.",
        );
      }

      if (command.maxFileSizeBytes !== undefined) {
        if (
          !Number.isInteger(command.maxFileSizeBytes) ||
          command.maxFileSizeBytes < DOMAIN_MIN_UPLOAD_MAX_BYTES
        ) {
          throw new DomainError(
            "INVALID_UPLOAD_LIMITS",
            `O tamanho máximo por arquivo deve ser um inteiro de pelo menos ${DOMAIN_MIN_UPLOAD_MAX_BYTES} bytes.`,
          );
        }
        const ceiling = Math.min(systemMaxUploadBytes, proxyMaxBodyBytes);
        if (command.maxFileSizeBytes > ceiling) {
          throw new DomainError(
            "INVALID_UPLOAD_LIMITS",
            `O limite solicitado (${command.maxFileSizeBytes} bytes) excede o teto permitido pela API/proxy (${ceiling} bytes).`,
          );
        }
      }

      const normalizedExtensions =
        command.allowedExtensions !== undefined
          ? validateAndNormalizeExtensions(command.allowedExtensions)
          : undefined;

      const updatedAt = nowFn();

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.repository.getUploadLimits(command.organizationId, tx);
        if (!existing) {
          throw new DomainError("ORGANIZATION_NOT_FOUND", "Organização não encontrada.");
        }

        const currentView = toView(existing);
        const nextConfig: UploadLimitsConfig = {
          maxFileSizeBytes: command.maxFileSizeBytes ?? currentView.configured.maxFileSizeBytes,
          allowedExtensions: normalizedExtensions ?? currentView.configured.allowedExtensions,
          enforceDeclaredExtensionMatch:
            command.enforceDeclaredExtensionMatch ??
            currentView.configured.enforceDeclaredExtensionMatch,
        };

        const saved = await deps.repository.saveUploadLimits(
          command.organizationId,
          {
            ...nextConfig,
            updatedAt,
          },
          tx,
        );
        if (!saved) {
          throw new DomainError("ORGANIZATION_NOT_FOUND", "Organização não encontrada.");
        }

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "UPLOAD_LIMITS_UPDATED",
            resourceType: "ORGANIZATION",
            resourceId: command.organizationId,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              maxFileSizeBytes: nextConfig.maxFileSizeBytes,
              allowedExtensions: nextConfig.allowedExtensions.join(","),
              enforceDeclaredExtensionMatch: nextConfig.enforceDeclaredExtensionMatch,
            },
          },
          tx,
        );

        return toView(saved);
      });
    },
  };
}
