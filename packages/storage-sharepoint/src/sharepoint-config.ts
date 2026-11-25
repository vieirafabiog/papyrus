import { StorageError } from "@papyrus/storage-core";

const MAX_OBJECT_KEY_LENGTH = 512;
const MAX_KEY_SEGMENTS = 16;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const TENANT_ID_PATTERN = /^[0-9a-zA-Z.-]{3,128}$/;
const CLIENT_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_!-]{4,200}$/;
const SHAREPOINT_HOST_PATTERN = /(?:^|\.)sharepoint(?:-mil)?\.(?:com|us|de|cn)$/i;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export interface SharePointTimeoutsConfig {
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface SharePointCredentialsConfig {
  readonly clientSecret: string;
}

export interface SharePointStorageConfigInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly siteUrl: string;
  readonly libraryName?: string | undefined;
  readonly driveId?: string | undefined;
  readonly baseFolderPath?: string | undefined;
  readonly timeouts?: Partial<SharePointTimeoutsConfig> | undefined;
  readonly credentials: SharePointCredentialsConfig;
}

export interface ValidatedSharePointStorageConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly siteUrl: string;
  readonly siteHostname: string;
  readonly sitePath: string;
  readonly libraryName: string | null;
  readonly driveId: string | null;
  readonly baseFolderPath: string | null;
  readonly timeouts: SharePointTimeoutsConfig;
  readonly credentials: SharePointCredentialsConfig;
}

export interface SharePointSecurityPolicy {
  readonly allowCustomHosts?: boolean | undefined;
  readonly graphBaseUrl?: string | undefined;
  readonly loginBaseUrl?: string | undefined;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizeRelativeFolderPath(rawPath: string | undefined): string | null {
  if (rawPath === undefined) {
    return null;
  }
  const trimmed = rawPath.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed.length === 0) {
    return null;
  }
  if (
    trimmed.length > 256 ||
    hasControlChars(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.includes(":") ||
    trimmed.includes("%")
  ) {
    throw new StorageError(
      "INVALID_KEY",
      "Pasta raiz do SharePoint contém caracteres inválidos.",
      "sharepoint",
    );
  }
  const segments = trimmed.split("/");
  if (segments.length > 8) {
    throw new StorageError(
      "INVALID_KEY",
      "Pasta raiz do SharePoint excede a profundidade máxima permitida.",
      "sharepoint",
    );
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      WINDOWS_RESERVED_NAME_PATTERN.test(segment)
    ) {
      throw new StorageError(
        "INVALID_KEY",
        "Pasta raiz do SharePoint contém segmento proibido.",
        "sharepoint",
      );
    }
  }
  return segments.join("/");
}

/**
 * Validates and normalizes opaque object keys destined for SharePoint Document Libraries.
 */
export function validateSharePointObjectKey(rawKey: string): string {
  if (typeof rawKey !== "string" || rawKey.length === 0 || rawKey.length > MAX_OBJECT_KEY_LENGTH) {
    throw new StorageError(
      "INVALID_KEY",
      "Chave de objeto ausente ou fora do tamanho permitido.",
      "sharepoint",
    );
  }
  if (
    rawKey.trim() !== rawKey ||
    hasControlChars(rawKey) ||
    rawKey.includes("\\") ||
    rawKey.includes(":") ||
    rawKey.includes("%") ||
    rawKey.startsWith("/") ||
    rawKey.endsWith("/")
  ) {
    throw new StorageError(
      "INVALID_KEY",
      "Chave de objeto contém caracteres ou prefixos não permitidos.",
      "sharepoint",
    );
  }

  const segments = rawKey.split("/");
  if (segments.length === 0 || segments.length > MAX_KEY_SEGMENTS) {
    throw new StorageError(
      "INVALID_KEY",
      "Chave de objeto excede a profundidade máxima permitida.",
      "sharepoint",
    );
  }

  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      !SAFE_SEGMENT_PATTERN.test(segment) ||
      WINDOWS_RESERVED_NAME_PATTERN.test(segment)
    ) {
      throw new StorageError(
        "INVALID_KEY",
        "Chave de objeto contém segmento inválido ou proibido.",
        "sharepoint",
      );
    }
  }

  return segments.join("/");
}

/**
 * Builds the URL-encoded Graph drive root path for an opaque object key.
 */
export function buildSharePointDriveItemPath(
  rawKey: string,
  baseFolderPath: string | null,
): string {
  const normalizedKey = validateSharePointObjectKey(rawKey);
  const fullPath = baseFolderPath ? `${baseFolderPath}/${normalizedKey}` : normalizedKey;
  return fullPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Validates Azure AD / Entra ID App Registration + SharePoint Site & Library configuration
 * while blocking SSRF targets and non-HTTPS site URLs.
 */
export function parseSharePointStorageConfig(
  input: SharePointStorageConfigInput,
  policy: SharePointSecurityPolicy = {},
): ValidatedSharePointStorageConfig {
  const tenantId = input.tenantId.trim();
  if (!TENANT_ID_PATTERN.test(tenantId) || tenantId.includes("..")) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Tenant ID do Azure AD inválido. Informe o GUID do tenant ou domínio verificado.",
      "sharepoint",
    );
  }

  const clientId = input.clientId.trim();
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Client ID (Application ID) do aplicativo Azure AD inválido.",
      "sharepoint",
    );
  }

  const clientSecret = input.credentials?.clientSecret ?? "";
  if (clientSecret.length < 6 || clientSecret.length > 512) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Client Secret do aplicativo Azure AD é obrigatório e deve ter entre 6 e 512 caracteres.",
      "sharepoint",
    );
  }

  const rawSiteUrl = input.siteUrl.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawSiteUrl);
  } catch {
    throw new StorageError(
      "INVALID_KEY",
      "URL do site SharePoint inválida. Utilize um endereço HTTPS completo.",
      "sharepoint",
    );
  }

  if (parsedUrl.protocol !== "https:") {
    throw new StorageError(
      "INVALID_KEY",
      "A URL do site SharePoint deve utilizar HTTPS.",
      "sharepoint",
    );
  }

  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new StorageError(
      "INVALID_KEY",
      "A URL do site SharePoint não pode conter credenciais, query string ou fragmento.",
      "sharepoint",
    );
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!policy.allowCustomHosts && !SHAREPOINT_HOST_PATTERN.test(hostname)) {
    throw new StorageError(
      "INVALID_KEY",
      "Host do site SharePoint inválido. Utilize um domínio oficial *.sharepoint.com.",
      "sharepoint",
    );
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, "");
  if (normalizedPath.includes("..")) {
    throw new StorageError("INVALID_KEY", "Caminho do site SharePoint inválido.", "sharepoint");
  }

  const libraryName =
    input.libraryName !== undefined && input.libraryName.trim().length > 0
      ? input.libraryName.trim()
      : null;
  if (libraryName !== null && (libraryName.length > 128 || hasControlChars(libraryName))) {
    throw new StorageError(
      "INVALID_KEY",
      "Nome da biblioteca (Library) do SharePoint inválido.",
      "sharepoint",
    );
  }

  const driveId =
    input.driveId !== undefined && input.driveId.trim().length > 0 ? input.driveId.trim() : null;
  if (driveId !== null && !DRIVE_ID_PATTERN.test(driveId)) {
    throw new StorageError(
      "INVALID_KEY",
      "Drive ID do SharePoint contém formato inválido.",
      "sharepoint",
    );
  }

  if (libraryName === null && driveId === null) {
    throw new StorageError(
      "INVALID_KEY",
      "Informe o nome da Biblioteca (Library) ou o Drive ID do SharePoint.",
      "sharepoint",
    );
  }

  const baseFolderPath = normalizeRelativeFolderPath(input.baseFolderPath);

  const connectionTimeoutMs = input.timeouts?.connectionTimeoutMs ?? 5_000;
  const requestTimeoutMs = input.timeouts?.requestTimeoutMs ?? 30_000;
  if (
    !Number.isInteger(connectionTimeoutMs) ||
    connectionTimeoutMs < 500 ||
    connectionTimeoutMs > 60_000 ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 ||
    requestTimeoutMs > 300_000
  ) {
    throw new StorageError(
      "INVALID_KEY",
      "Timeouts de conexão/requisição do SharePoint estão fora dos limites permitidos.",
      "sharepoint",
    );
  }

  return {
    tenantId,
    clientId,
    siteUrl: `${parsedUrl.origin}${normalizedPath}`,
    siteHostname: hostname,
    sitePath: normalizedPath,
    libraryName,
    driveId,
    baseFolderPath,
    timeouts: {
      connectionTimeoutMs,
      requestTimeoutMs,
    },
    credentials: {
      clientSecret,
    },
  };
}
