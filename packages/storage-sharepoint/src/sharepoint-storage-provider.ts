import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import {
  type StorageCapabilities,
  type StorageDownload,
  StorageError,
  type StorageHealthCheckResult,
  type StorageObjectKey,
  type StorageProvider,
  type StorageUploadInput,
  type StoredObject,
  normalizeStorageError,
  sanitizeStorageErrorMessage,
} from "@papyrus/storage-core";
import {
  type SharePointSecurityPolicy,
  type SharePointStorageConfigInput,
  type ValidatedSharePointStorageConfig,
  buildSharePointDriveItemPath,
  parseSharePointStorageConfig,
} from "./sharepoint-config.js";

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_LOGIN_BASE_URL = "https://login.microsoftonline.com";
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
// Microsoft Graph resumable upload chunks must be multiples of 320 KiB.
const RESUMABLE_CHUNK_SIZE_BYTES = 10 * 320 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const PLACEHOLDER_SHA256 = "0".repeat(64);

export interface SharePointStorageProviderOptions {
  readonly securityPolicy?: SharePointSecurityPolicy | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly simpleUploadMaxBytes?: number | undefined;
  readonly chunkSizeBytes?: number | undefined;
}

interface CachedAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

interface GraphDriveItemResponse {
  readonly id?: string;
  readonly name?: string;
  readonly size?: number;
  readonly eTag?: string;
  readonly file?: {
    readonly mimeType?: string;
    readonly hashes?: {
      readonly sha256Hash?: string;
    };
  };
  readonly "@microsoft.graph.downloadUrl"?: string;
}

function isAbortOrTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "TimeoutError" || error.name === "AbortError";
}

function buildTimedSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!externalSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([timeoutSignal, externalSignal]);
}

function mapHttpStatusToStorageError(status: number, contextMessage: string): StorageError {
  if (status === 401 || status === 403) {
    return new StorageError(
      "UNAUTHORIZED",
      `${contextMessage}: acesso negado pelo Microsoft Entra ID / SharePoint.`,
      "sharepoint",
    );
  }
  if (status === 404) {
    return new StorageError(
      "NOT_FOUND",
      `${contextMessage}: recurso não encontrado no SharePoint.`,
      "sharepoint",
    );
  }
  if (status === 408 || status === 504) {
    return new StorageError(
      "TIMEOUT",
      `${contextMessage}: tempo limite excedido ao comunicar com o SharePoint.`,
      "sharepoint",
    );
  }
  if (status === 429) {
    return new StorageError(
      "THROTTLED",
      `${contextMessage}: limite de requisições do Microsoft Graph atingido.`,
      "sharepoint",
    );
  }
  if (status === 409 || status === 412) {
    return new StorageError(
      "CONFLICT",
      `${contextMessage}: conflito de versão ou bloqueio no SharePoint.`,
      "sharepoint",
    );
  }
  if (status >= 500) {
    return new StorageError(
      "UNAVAILABLE",
      `${contextMessage}: serviço Microsoft Graph / SharePoint temporariamente indisponível.`,
      "sharepoint",
    );
  }
  return new StorageError(
    "UNKNOWN",
    `${contextMessage}: resposta HTTP inesperada (${status}).`,
    "sharepoint",
  );
}

function normalizeSha256OrNull(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized) || normalized === PLACEHOLDER_SHA256) {
    return null;
  }
  return normalized;
}

function matchLibraryDrive(
  drives: readonly { readonly id?: string; readonly name?: string; readonly webUrl?: string }[],
  libraryName: string,
): string | null {
  const target = libraryName.trim().toLowerCase();
  for (const drive of drives) {
    if (!drive.id) {
      continue;
    }
    const name = (drive.name ?? "").trim().toLowerCase();
    if (name === target) {
      return drive.id;
    }
  }
  for (const drive of drives) {
    if (!drive.id || !drive.webUrl) {
      continue;
    }
    try {
      const urlPath = decodeURIComponent(new URL(drive.webUrl).pathname).replace(/\/+$/, "");
      const lastSegment = urlPath.split("/").pop()?.trim().toLowerCase();
      if (lastSegment && lastSegment === target) {
        return drive.id;
      }
    } catch {
      // Ignore malformed webUrl entries when matching library fallback
    }
  }
  return null;
}

async function computeStreamSha256(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return hash.digest("hex");
}

function responseBodyToReadable(response: Response): Readable {
  if (!response.body) {
    return Readable.from([]);
  }
  return Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
}

/**
 * Microsoft SharePoint Online / Microsoft 365 storage provider backed by Microsoft Graph API v1.0
 * using Azure AD (Entra ID) OAuth2 Client Credentials and opaque object keys.
 */
export function createSharePointStorageProvider(
  configInput: SharePointStorageConfigInput,
  options: SharePointStorageProviderOptions = {},
): StorageProvider {
  const config: ValidatedSharePointStorageConfig = parseSharePointStorageConfig(
    configInput,
    options.securityPolicy,
  );
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const nowFn = options.now ?? (() => Date.now());
  const graphBaseUrl = (options.securityPolicy?.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const loginBaseUrl = (options.securityPolicy?.loginBaseUrl ?? DEFAULT_LOGIN_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const simpleUploadMaxBytes = options.simpleUploadMaxBytes ?? SIMPLE_UPLOAD_MAX_BYTES;
  const chunkSizeBytes = options.chunkSizeBytes ?? RESUMABLE_CHUNK_SIZE_BYTES;

  let cachedToken: CachedAccessToken | null = null;
  let cachedDriveId: string | null = config.driveId;

  const capabilities: StorageCapabilities = {
    streamingRead: true,
    streamingWrite: true,
    signedUpload: false,
    signedDownload: false,
    multipartUpload: true,
    serverSideCopy: false,
  };

  async function executeFetch(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetchImpl(url, {
        ...init,
        signal: buildTimedSignal(timeoutMs, externalSignal),
      });
    } catch (error) {
      if (isAbortOrTimeoutError(error)) {
        throw new StorageError(
          "TIMEOUT",
          "Tempo limite excedido na comunicação com o SharePoint.",
          "sharepoint",
        );
      }
      throw normalizeStorageError(error, "sharepoint");
    }
  }

  async function getAccessToken(externalSignal?: AbortSignal): Promise<string> {
    const now = nowFn();
    if (cachedToken && cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now) {
      return cachedToken.token;
    }

    const tokenUrl = `${loginBaseUrl}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.credentials.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });

    const response = await executeFetch(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      },
      config.timeouts.connectionTimeoutMs,
      externalSignal,
    );

    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new StorageError(
          "UNAUTHORIZED",
          "Falha na autenticação com o aplicativo Azure AD (verifique Tenant ID, Client ID e Client Secret).",
          "sharepoint",
        );
      }
      throw mapHttpStatusToStorageError(response.status, "Falha ao obter token OAuth2");
    }

    const parsed = (await response.json()) as {
      readonly access_token?: unknown;
      readonly expires_in?: unknown;
    };
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      throw new StorageError(
        "UNAUTHORIZED",
        "Resposta de autenticação do Microsoft Entra ID não retornou token válido.",
        "sharepoint",
      );
    }

    const expiresInSeconds =
      typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in
        : 3_600;

    cachedToken = {
      token: parsed.access_token,
      expiresAtMs: now + Math.max(120, expiresInSeconds) * 1000,
    };
    return cachedToken.token;
  }

  async function graphRequest(
    pathWithQuery: string,
    init: RequestInit = {},
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const token = await getAccessToken(externalSignal);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    return executeFetch(
      `${graphBaseUrl}${pathWithQuery}`,
      { ...init, headers },
      config.timeouts.requestTimeoutMs,
      externalSignal,
    );
  }

  async function resolveDriveId(externalSignal?: AbortSignal): Promise<string> {
    if (cachedDriveId) {
      return cachedDriveId;
    }

    const siteEndpoint = config.sitePath
      ? `/sites/${encodeURIComponent(config.siteHostname)}:${config.sitePath}`
      : `/sites/${encodeURIComponent(config.siteHostname)}`;

    const siteRes = await graphRequest(`${siteEndpoint}?$select=id,webUrl`, {}, externalSignal);
    if (!siteRes.ok) {
      throw mapHttpStatusToStorageError(siteRes.status, "Site SharePoint não acessível");
    }
    const siteJson = (await siteRes.json()) as { readonly id?: unknown };
    if (typeof siteJson.id !== "string" || siteJson.id.length === 0) {
      throw new StorageError(
        "NOT_FOUND",
        "Não foi possível resolver o identificador do site SharePoint.",
        "sharepoint",
      );
    }

    const drivesRes = await graphRequest(
      `/sites/${encodeURIComponent(siteJson.id)}/drives?$select=id,name,webUrl`,
      {},
      externalSignal,
    );
    if (!drivesRes.ok) {
      throw mapHttpStatusToStorageError(drivesRes.status, "Falha ao listar bibliotecas do site");
    }
    const drivesJson = (await drivesRes.json()) as {
      readonly value?: readonly {
        readonly id?: string;
        readonly name?: string;
        readonly webUrl?: string;
      }[];
    };
    const drives = drivesJson.value ?? [];
    const targetLibrary = config.libraryName ?? "Documents";
    const matchedDriveId = matchLibraryDrive(drives, targetLibrary);
    if (!matchedDriveId) {
      throw new StorageError(
        "NOT_FOUND",
        `Biblioteca "${targetLibrary}" não encontrada no site SharePoint informado.`,
        "sharepoint",
      );
    }

    cachedDriveId = matchedDriveId;
    return matchedDriveId;
  }

  async function deletePathSilently(
    driveId: string,
    encodedPath: string,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    try {
      await graphRequest(
        `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}`,
        { method: "DELETE" },
        externalSignal,
      );
    } catch {
      // Best-effort cleanup on checksum failure
    }
  }

  async function getObjectInternal(key: StorageObjectKey): Promise<StorageDownload> {
    const encodedPath = buildSharePointDriveItemPath(key.value, config.baseFolderPath);
    const driveId = await resolveDriveId();

    const metaRes = await graphRequest(
      `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}?$select=id,size,eTag,file,@microsoft.graph.downloadUrl`,
    );
    if (!metaRes.ok) {
      throw mapHttpStatusToStorageError(metaRes.status, "Falha ao localizar objeto no SharePoint");
    }
    const item = (await metaRes.json()) as GraphDriveItemResponse;

    let downloadRes: Response;
    const preAuthUrl = item["@microsoft.graph.downloadUrl"];
    if (typeof preAuthUrl === "string" && preAuthUrl.startsWith("https://")) {
      downloadRes = await executeFetch(
        preAuthUrl,
        { method: "GET" },
        config.timeouts.requestTimeoutMs,
      );
    } else {
      downloadRes = await graphRequest(
        `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}:/content`,
        { method: "GET", redirect: "follow" },
      );
    }

    if (!downloadRes.ok) {
      throw mapHttpStatusToStorageError(downloadRes.status, "Falha ao baixar objeto do SharePoint");
    }

    const declaredLen = typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0;
    const contentType = item.file?.mimeType ?? "application/octet-stream";
    const checksumSha256 = normalizeSha256OrNull(item.file?.hashes?.sha256Hash) ?? "";

    return {
      body: responseBodyToReadable(downloadRes),
      metadata: {
        contentType,
        contentLength: declaredLen,
        checksumSha256,
      },
    };
  }

  return {
    kind: "sharepoint",
    capabilities,

    async checkHealth(): Promise<StorageHealthCheckResult> {
      try {
        cachedDriveId = config.driveId;
        const driveId = await resolveDriveId();
        const rootRes = await graphRequest(
          `/drives/${encodeURIComponent(driveId)}/root?$select=id,name`,
        );
        if (!rootRes.ok) {
          throw mapHttpStatusToStorageError(
            rootRes.status,
            "Falha ao validar acesso à biblioteca SharePoint",
          );
        }
        return {
          healthy: true,
          checkedAt: new Date(nowFn()),
          message: "Conexão com SharePoint e biblioteca validada com sucesso.",
        };
      } catch (error) {
        const message =
          error instanceof StorageError
            ? error.message
            : sanitizeStorageErrorMessage(
                error instanceof Error ? error.message : "Falha ao validar conexão com SharePoint.",
              );
        return {
          healthy: false,
          checkedAt: new Date(nowFn()),
          message,
        };
      }
    },

    async putObject(input: StorageUploadInput): Promise<StoredObject> {
      const encodedPath = buildSharePointDriveItemPath(input.key.value, config.baseFolderPath);
      const declaredLength = input.metadata.contentLength;
      if (!Number.isInteger(declaredLength) || declaredLength < 0) {
        throw new StorageError(
          "INVALID_KEY",
          "Tamanho declarado do objeto é inválido para envio ao SharePoint.",
          "sharepoint",
        );
      }

      const expectedChecksum = normalizeSha256OrNull(input.metadata.checksumSha256);
      const driveId = await resolveDriveId(input.abortSignal);
      const hasher = createHash("sha256");

      if (declaredLength <= simpleUploadMaxBytes) {
        const chunks: Buffer[] = [];
        let totalRead = 0;
        for await (const rawChunk of input.body) {
          const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          totalRead += buf.length;
          if (totalRead > simpleUploadMaxBytes) {
            throw new StorageError(
              "CONFLICT",
              "O fluxo enviado ultrapassou o tamanho declarado na sessão.",
              "sharepoint",
            );
          }
          hasher.update(buf);
          chunks.push(buf);
        }

        if (totalRead !== declaredLength) {
          throw new StorageError(
            "CONFLICT",
            "O tamanho efetivo do objeto diverge do tamanho declarado.",
            "sharepoint",
          );
        }

        const actualChecksum = hasher.digest("hex");
        if (expectedChecksum && actualChecksum !== expectedChecksum) {
          throw new StorageError(
            "CHECKSUM_MISMATCH",
            "O checksum SHA-256 do arquivo diverge do esperado antes do envio ao SharePoint.",
            "sharepoint",
          );
        }

        const payloadBuffer = Buffer.concat(chunks, totalRead);
        const putRes = await graphRequest(
          `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}:/content`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
            },
            body: payloadBuffer,
          },
          input.abortSignal,
        );

        if (!putRes.ok) {
          throw mapHttpStatusToStorageError(putRes.status, "Falha ao gravar objeto no SharePoint");
        }

        const item = (await putRes.json()) as GraphDriveItemResponse;
        return {
          key: { value: input.key.value },
          contentType: input.metadata.contentType,
          contentLength: totalRead,
          checksumSha256: actualChecksum,
          ...(item.eTag ? { etag: item.eTag } : {}),
        };
      }

      // Resumable Upload Session for files > 4 MiB (aligned to 320 KiB chunks, streaming without full-file buffering)
      const sessionRes = await graphRequest(
        `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}:/createUploadSession`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item: {
              "@microsoft.graph.conflictBehavior": "replace",
            },
          }),
        },
        input.abortSignal,
      );

      if (!sessionRes.ok) {
        throw mapHttpStatusToStorageError(
          sessionRes.status,
          "Falha ao iniciar sessão de upload no SharePoint",
        );
      }

      const sessionJson = (await sessionRes.json()) as { readonly uploadUrl?: unknown };
      if (
        typeof sessionJson.uploadUrl !== "string" ||
        !sessionJson.uploadUrl.startsWith("https://")
      ) {
        throw new StorageError(
          "UNAVAILABLE",
          "Sessão de upload do Microsoft Graph não retornou URL válida.",
          "sharepoint",
        );
      }
      const uploadUrl = sessionJson.uploadUrl;

      let pending = Buffer.alloc(0);
      let uploadedOffset = 0;
      let finalItem: GraphDriveItemResponse | null = null;

      const sendChunk = async (chunkBuf: Buffer): Promise<void> => {
        const start = uploadedOffset;
        const end = uploadedOffset + chunkBuf.length - 1;
        if (end >= declaredLength) {
          throw new StorageError(
            "CONFLICT",
            "O fluxo enviado ultrapassou o tamanho declarado para o SharePoint.",
            "sharepoint",
          );
        }
        const chunkRes = await executeFetch(
          uploadUrl,
          {
            method: "PUT",
            headers: {
              "Content-Length": String(chunkBuf.length),
              "Content-Range": `bytes ${start}-${end}/${declaredLength}`,
            },
            body: chunkBuf,
          },
          config.timeouts.requestTimeoutMs,
          input.abortSignal,
        );
        if (!chunkRes.ok) {
          throw mapHttpStatusToStorageError(
            chunkRes.status,
            "Falha ao enviar bloco do arquivo ao SharePoint",
          );
        }
        uploadedOffset += chunkBuf.length;
        if (chunkRes.status === 200 || chunkRes.status === 201) {
          finalItem = (await chunkRes.json()) as GraphDriveItemResponse;
        }
      };

      for await (const rawChunk of input.body) {
        const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        hasher.update(buf);
        pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
        while (pending.length >= chunkSizeBytes) {
          const slice = pending.subarray(0, chunkSizeBytes);
          pending = pending.subarray(chunkSizeBytes);
          await sendChunk(slice);
        }
      }

      if (pending.length > 0) {
        await sendChunk(pending);
      }

      if (uploadedOffset !== declaredLength) {
        await deletePathSilently(driveId, encodedPath, input.abortSignal);
        throw new StorageError(
          "CONFLICT",
          "O tamanho total enviado ao SharePoint diverge do tamanho declarado.",
          "sharepoint",
        );
      }

      const actualChecksum = hasher.digest("hex");
      if (expectedChecksum && actualChecksum !== expectedChecksum) {
        await deletePathSilently(driveId, encodedPath, input.abortSignal);
        throw new StorageError(
          "CHECKSUM_MISMATCH",
          "O checksum SHA-256 do arquivo diverge do esperado após envio ao SharePoint.",
          "sharepoint",
        );
      }

      const completedEtag = (finalItem as GraphDriveItemResponse | null)?.eTag;
      return {
        key: { value: input.key.value },
        contentType: input.metadata.contentType,
        contentLength: uploadedOffset,
        checksumSha256: actualChecksum,
        ...(completedEtag ? { etag: completedEtag } : {}),
      };
    },

    async getObject(key: StorageObjectKey): Promise<StorageDownload> {
      return getObjectInternal(key);
    },

    async headObject(key: StorageObjectKey): Promise<StoredObject | null> {
      const encodedPath = buildSharePointDriveItemPath(key.value, config.baseFolderPath);
      const driveId = await resolveDriveId();

      const res = await graphRequest(
        `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}?$select=id,size,eTag,file`,
      );
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw mapHttpStatusToStorageError(
          res.status,
          "Falha ao consultar metadados do objeto no SharePoint",
        );
      }

      const item = (await res.json()) as GraphDriveItemResponse;
      const contentLength =
        typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0;
      const contentType = item.file?.mimeType ?? "application/octet-stream";

      let checksumSha256 = normalizeSha256OrNull(item.file?.hashes?.sha256Hash);
      if (!checksumSha256) {
        // SharePoint Online often returns only quickXorHash; compute real SHA-256 via streaming
        // so FinalizeUploadService always verifies cryptographic integrity without buffering in RAM.
        const downloaded = await getObjectInternal(key);
        checksumSha256 = await computeStreamSha256(downloaded.body);
      }

      return {
        key: { value: key.value },
        contentType,
        contentLength,
        checksumSha256,
        ...(item.eTag ? { etag: item.eTag } : {}),
      };
    },

    async deleteObject(key: StorageObjectKey): Promise<void> {
      const encodedPath = buildSharePointDriveItemPath(key.value, config.baseFolderPath);
      const driveId = await resolveDriveId();

      const res = await graphRequest(
        `/drives/${encodeURIComponent(driveId)}/root:/${encodedPath}`,
        { method: "DELETE" },
      );
      if (res.status === 404 || res.status === 204 || res.ok) {
        return;
      }
      throw mapHttpStatusToStorageError(res.status, "Falha ao excluir objeto no SharePoint");
    },
  };
}
