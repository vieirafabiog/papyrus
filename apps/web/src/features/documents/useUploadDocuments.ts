import {
  CONTRACTS_API_PREFIX,
  apiErrorResponseSchema,
  createApiResponseSchema,
  createUploadSessionRequestSchema,
  fileObjectStatusSchema,
  signedUploadTargetResponseSchema,
  uploadContentResponseSchema,
  uploadSessionRecordSchema,
} from "@docuflow/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

const uploadSessionEnvelopeSchema = createApiResponseSchema(uploadSessionRecordSchema);
const signedTargetEnvelopeSchema = createApiResponseSchema(signedUploadTargetResponseSchema);
const uploadContentEnvelopeSchema = createApiResponseSchema(uploadContentResponseSchema);
const finalizeEnvelopeSchema = createApiResponseSchema(
  uploadSessionRecordSchema
    .pick({ id: true, status: true })
    .extend({ fileObjectStatus: fileObjectStatusSchema.optional() }),
);

export type UploadItemStatus =
  | "READY"
  | "CREATING_SESSION"
  | "UPLOADING"
  | "FINALIZING"
  | "QUARANTINED"
  | "AVAILABLE"
  | "REJECTED"
  | "CANCELLED"
  | "ERROR";

export interface UploadMetadataFormValues {
  readonly title: string;
  readonly categoryId: string;
  readonly folderId: string | null;
  readonly expirationDate: string;
  readonly changeNote: string;
}

export interface UploadQueueItem {
  readonly localId: string;
  readonly file: File;
  readonly suggestedTitle: string;
  readonly status: UploadItemStatus;
  readonly progressPercent: number;
  readonly bytesUploaded: number;
  readonly sessionId: string | null;
  readonly errorMessage: string | null;
}

export interface BinaryUploadRequest {
  readonly url: string;
  readonly method: "PUT" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: File;
  readonly withCredentials: boolean;
  readonly signal: AbortSignal;
  readonly onProgress: (loadedBytes: number, totalBytes: number) => void;
}

export interface BinaryUploadResponse {
  readonly status: number;
  readonly responseText: string;
}

export type BinaryUploadExecutor = (request: BinaryUploadRequest) => Promise<BinaryUploadResponse>;

export interface UseUploadDocumentsOptions {
  readonly documentId?: string | undefined;
  readonly createDocumentOnFinalize?: boolean | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly binaryUploader?: BinaryUploadExecutor | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

export class UploadCancelledError extends Error {
  public constructor() {
    super("Envio cancelado pelo usuário.");
    this.name = "UploadCancelledError";
  }
}

function readCookieValue(cookieName: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return null;
  }
  const cookies = document.cookie.split(";");
  for (const part of cookies) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${cookieName}=`)) {
      return decodeURIComponent(trimmed.slice(cookieName.length + 1));
    }
  }
  return null;
}

function deriveTitleFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^/.]+$/, "").trim();
  return withoutExt.length > 0 ? withoutExt : fileName.trim();
}

function generateLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function computeFileSha256IfSupported(file: File): Promise<string | undefined> {
  if (
    typeof crypto === "undefined" ||
    !crypto.subtle ||
    typeof crypto.subtle.digest !== "function" ||
    typeof file.arrayBuffer !== "function" ||
    file.size > 20 * 1024 * 1024
  ) {
    return undefined;
  }

  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

async function parseSafeApiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const raw: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.error.message;
    }
  } catch {
    // Mantém fallback seguro quando o corpo não é JSON válido.
  }
  return fallback;
}

export function defaultXhrBinaryUploader(
  request: BinaryUploadRequest,
): Promise<BinaryUploadResponse> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new UploadCancelledError());
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.url, true);
    xhr.withCredentials = request.withCredentials;

    for (const [key, value] of Object.entries(request.headers)) {
      xhr.setRequestHeader(key, value);
    }

    const onAbort = (): void => {
      xhr.abort();
      reject(new UploadCancelledError());
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    xhr.upload.onprogress = (event: ProgressEvent<EventTarget>) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : request.body.size;
      request.onProgress(event.loaded, total);
    };

    xhr.onload = () => {
      request.signal.removeEventListener("abort", onAbort);
      resolve({
        status: xhr.status,
        responseText: xhr.responseText ?? "",
      });
    };

    xhr.onerror = () => {
      request.signal.removeEventListener("abort", onAbort);
      reject(new Error("Falha de rede durante a transferência do arquivo."));
    };

    xhr.onabort = () => {
      request.signal.removeEventListener("abort", onAbort);
      reject(new UploadCancelledError());
    };

    xhr.send(request.body);
  });
}

export function formatBytesPtBr(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1).replace(".", ",")} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1).replace(".", ",")} MB`;
}

export function useUploadDocuments(options: UseUploadDocumentsOptions = {}) {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const binaryUploader = options.binaryUploader ?? defaultXhrBinaryUploader;
  const fetchImpl = options.fetchFn ?? globalThis.fetch;

  const [items, setItems] = useState<readonly UploadQueueItem[]>([]);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const updateItem = useCallback(
    (localId: string, updater: (prev: UploadQueueItem) => UploadQueueItem): void => {
      setItems((prevItems) =>
        prevItems.map((item) => (item.localId === localId ? updater(item) : item)),
      );
    },
    [],
  );

  const ensureCsrfToken = useCallback(
    async (signal: AbortSignal): Promise<string | null> => {
      const existing = readCookieValue(CSRF_COOKIE_NAME);
      if (existing) {
        return existing;
      }

      try {
        const response = await fetchImpl(`${CONTRACTS_API_PREFIX}/auth/csrf-token`, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          signal,
        });
        if (!response.ok) {
          return readCookieValue(CSRF_COOKIE_NAME);
        }
        const rawJson: unknown = await response.json();
        if (
          typeof rawJson === "object" &&
          rawJson !== null &&
          "data" in rawJson &&
          typeof rawJson.data === "object" &&
          rawJson.data !== null &&
          "csrfToken" in rawJson.data &&
          typeof rawJson.data.csrfToken === "string"
        ) {
          return rawJson.data.csrfToken;
        }
      } catch {
        // Fallback para token em cookie caso endpoint CSRF não esteja disponível no ambiente de teste.
      }
      return readCookieValue(CSRF_COOKIE_NAME);
    },
    [fetchImpl],
  );

  const addFiles = useCallback(
    (files: readonly File[] | FileList): void => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) {
        return;
      }

      const nextItems: UploadQueueItem[] = fileArray.map((file) => {
        const localId = generateLocalId();
        const suggestedTitle = deriveTitleFromFileName(file.name);

        if (file.size <= 0) {
          return {
            localId,
            file,
            suggestedTitle,
            status: "ERROR",
            progressPercent: 0,
            bytesUploaded: 0,
            sessionId: null,
            errorMessage: "Arquivo vazio não é permitido para envio.",
          };
        }

        if (file.size > maxFileBytes) {
          return {
            localId,
            file,
            suggestedTitle,
            status: "ERROR",
            progressPercent: 0,
            bytesUploaded: 0,
            sessionId: null,
            errorMessage: `Arquivo excede o limite máximo permitido (${formatBytesPtBr(maxFileBytes)}).`,
          };
        }

        if (file.name.trim().length === 0 || file.name.length > 255) {
          return {
            localId,
            file,
            suggestedTitle,
            status: "ERROR",
            progressPercent: 0,
            bytesUploaded: 0,
            sessionId: null,
            errorMessage: "Nome de arquivo inválido para envio.",
          };
        }

        return {
          localId,
          file,
          suggestedTitle,
          status: "READY",
          progressPercent: 0,
          bytesUploaded: 0,
          sessionId: null,
          errorMessage: null,
        };
      });

      setItems((prev) => [...prev, ...nextItems]);
    },
    [maxFileBytes],
  );

  const removeItem = useCallback((localId: string): void => {
    const activeController = abortControllersRef.current.get(localId);
    if (activeController) {
      activeController.abort();
      abortControllersRef.current.delete(localId);
    }
    setItems((prev) => prev.filter((item) => item.localId !== localId));
  }, []);

  const cancelItem = useCallback(
    (localId: string): void => {
      const controller = abortControllersRef.current.get(localId);
      if (controller) {
        controller.abort();
        abortControllersRef.current.delete(localId);
      }
      updateItem(localId, (prev) => {
        if (
          prev.status === "CREATING_SESSION" ||
          prev.status === "UPLOADING" ||
          prev.status === "FINALIZING"
        ) {
          return {
            ...prev,
            status: "CANCELLED",
            errorMessage: "Envio cancelado pelo usuário.",
          };
        }
        return prev;
      });
    },
    [updateItem],
  );

  const cancelAll = useCallback((): void => {
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();

    setItems((prev) =>
      prev.map((item) =>
        item.status === "CREATING_SESSION" ||
        item.status === "UPLOADING" ||
        item.status === "FINALIZING"
          ? {
              ...item,
              status: "CANCELLED",
              errorMessage: "Envio cancelado pelo usuário.",
            }
          : item,
      ),
    );
  }, []);

  const clearAll = useCallback((): void => {
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    setItems([]);
  }, []);

  const uploadSingleItem = useCallback(
    async (item: UploadQueueItem, metadata: UploadMetadataFormValues): Promise<void> => {
      if (item.file.size <= 0 || item.file.size > maxFileBytes) {
        return;
      }

      const controller = new AbortController();
      abortControllersRef.current.set(item.localId, controller);

      updateItem(item.localId, (prev) => ({
        ...prev,
        status: "CREATING_SESSION",
        progressPercent: 0,
        bytesUploaded: 0,
        errorMessage: null,
      }));

      try {
        const csrfToken = await ensureCsrfToken(controller.signal);
        const declaredChecksumSha256 = await computeFileSha256IfSupported(item.file);
        const declaredContentType =
          item.file.type.trim().length > 0 ? item.file.type.trim() : "application/octet-stream";

        const requestPayload = createUploadSessionRequestSchema.parse({
          ...(options.documentId ? { documentId: options.documentId } : {}),
          ...(metadata.categoryId.trim().length > 0 ? { categoryId: metadata.categoryId } : {}),
          ...(metadata.folderId ? { folderId: metadata.folderId } : {}),
          originalFileName: item.file.name,
          declaredSizeBytes: item.file.size,
          declaredContentType,
          ...(declaredChecksumSha256 ? { declaredChecksumSha256 } : {}),
          idempotencyKey: generateLocalId(),
        });

        const baseJsonHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        if (csrfToken) {
          baseJsonHeaders[CSRF_HEADER_NAME] = csrfToken;
        }

        const sessionRes = await fetchImpl(`${CONTRACTS_API_PREFIX}/uploads/sessions`, {
          method: "POST",
          credentials: "include",
          headers: baseJsonHeaders,
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        });

        if (!sessionRes.ok) {
          const message = await parseSafeApiErrorMessage(
            sessionRes,
            "Não foi possível iniciar a sessão de upload.",
          );
          throw new Error(message);
        }

        const parsedSession = uploadSessionEnvelopeSchema.safeParse(await sessionRes.json());
        if (!parsedSession.success) {
          throw new Error("Resposta inválida ao iniciar sessão de upload.");
        }

        const sessionId = parsedSession.data.data.id;
        updateItem(item.localId, (prev) => ({
          ...prev,
          sessionId,
          status: "UPLOADING",
        }));

        // Solicita destino assinado S3; se o storage for local (409), envia via streaming na API.
        const signedHeaders: Record<string, string> = { Accept: "application/json" };
        if (csrfToken) {
          signedHeaders[CSRF_HEADER_NAME] = csrfToken;
        }

        const targetRes = await fetchImpl(
          `${CONTRACTS_API_PREFIX}/uploads/sessions/${sessionId}/signed-target`,
          {
            method: "POST",
            credentials: "include",
            headers: signedHeaders,
            signal: controller.signal,
          },
        );

        const handleProgress = (loaded: number, total: number): void => {
          const safeTotal = total > 0 ? total : item.file.size;
          const pct = Math.min(100, Math.max(0, Math.round((loaded / safeTotal) * 100)));
          updateItem(item.localId, (prev) => ({
            ...prev,
            bytesUploaded: loaded,
            progressPercent: pct,
          }));
        };

        if (targetRes.ok) {
          const parsedTarget = signedTargetEnvelopeSchema.safeParse(await targetRes.json());
          if (!parsedTarget.success) {
            throw new Error("Resposta inválida ao gerar destino de upload.");
          }
          const target = parsedTarget.data.data.target;
          const putRes = await binaryUploader({
            url: target.url,
            method: target.method,
            headers: target.headers,
            body: item.file,
            withCredentials: false,
            signal: controller.signal,
            onProgress: handleProgress,
          });
          if (putRes.status < 200 || putRes.status >= 300) {
            throw new Error("Falha ao enviar o arquivo para o armazenamento configurado.");
          }
        } else if (targetRes.status === 409) {
          const streamHeaders: Record<string, string> = {
            "content-type": declaredContentType,
          };
          if (csrfToken) {
            streamHeaders[CSRF_HEADER_NAME] = csrfToken;
          }

          const streamRes = await binaryUploader({
            url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${sessionId}/content`,
            method: "PUT",
            headers: streamHeaders,
            body: item.file,
            withCredentials: true,
            signal: controller.signal,
            onProgress: handleProgress,
          });

          if (streamRes.status < 200 || streamRes.status >= 300) {
            throw new Error("Falha ao transmitir o arquivo para o servidor.");
          }

          const parsedStream = uploadContentEnvelopeSchema.safeParse(
            JSON.parse(streamRes.responseText) as unknown,
          );
          if (!parsedStream.success) {
            throw new Error("Resposta inválida ao concluir o envio do arquivo.");
          }
        } else {
          const message = await parseSafeApiErrorMessage(
            targetRes,
            "Não foi possível preparar o destino de envio.",
          );
          throw new Error(message);
        }

        updateItem(item.localId, (prev) => ({
          ...prev,
          status: "FINALIZING",
          progressPercent: 100,
          bytesUploaded: item.file.size,
        }));

        const finalizePayload: Record<string, unknown> = {};
        if (options.documentId) {
          finalizePayload.documentId = options.documentId;
        }
        if (metadata.changeNote.trim().length > 0) {
          finalizePayload.changeNote = metadata.changeNote.trim();
        }
        if (declaredChecksumSha256) {
          finalizePayload.expectedChecksumSha256 = declaredChecksumSha256;
        }

        const finalizeRes = await fetchImpl(
          `${CONTRACTS_API_PREFIX}/uploads/sessions/${sessionId}/finalize`,
          {
            method: "POST",
            credentials: "include",
            headers: baseJsonHeaders,
            body: JSON.stringify(finalizePayload),
            signal: controller.signal,
          },
        );

        if (!finalizeRes.ok) {
          const message = await parseSafeApiErrorMessage(
            finalizeRes,
            "Não foi possível finalizar e confirmar o envio do arquivo.",
          );
          throw new Error(message);
        }

        let finalStatus: UploadItemStatus = "QUARANTINED";
        try {
          const parsedFinalize = finalizeEnvelopeSchema.safeParse(await finalizeRes.json());
          if (parsedFinalize.success) {
            const foStatus = parsedFinalize.data.data.fileObjectStatus;
            if (foStatus === "AVAILABLE") {
              finalStatus = "AVAILABLE";
            } else if (foStatus === "REJECTED") {
              finalStatus = "REJECTED";
            }
          }
        } catch {
          // Mantém estado de análise quando resposta 2xx não traz corpo detalhado.
        }

        updateItem(item.localId, (prev) => ({
          ...prev,
          status: finalStatus,
          progressPercent: 100,
          bytesUploaded: item.file.size,
          errorMessage:
            finalStatus === "REJECTED" ? "Arquivo rejeitado na verificação de segurança." : null,
        }));

        if (options.createDocumentOnFinalize && !options.documentId) {
          const documentTitle =
            metadata.title.trim().length > 0 ? metadata.title.trim() : item.suggestedTitle;
          const createDocPayload = {
            title: documentTitle,
            categoryId: metadata.categoryId,
            folderId: metadata.folderId,
            issueDate: null,
            expirationDate:
              metadata.expirationDate.trim().length > 0 ? metadata.expirationDate.trim() : null,
            metadata: {},
            uploadSessionId: sessionId,
            ...(metadata.changeNote.trim().length > 0
              ? { changeNote: metadata.changeNote.trim() }
              : {}),
          };

          const createDocRes = await fetchImpl(`${CONTRACTS_API_PREFIX}/documents`, {
            method: "POST",
            credentials: "include",
            headers: baseJsonHeaders,
            body: JSON.stringify(createDocPayload),
            signal: controller.signal,
          });
          if (!createDocRes.ok) {
            const message = await parseSafeApiErrorMessage(
              createDocRes,
              "O arquivo foi enviado, mas não foi possível registrar o documento.",
            );
            throw new Error(message);
          }
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
          error instanceof UploadCancelledError ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          updateItem(item.localId, (prev) => ({
            ...prev,
            status: "CANCELLED",
            errorMessage: "Envio cancelado pelo usuário.",
          }));
          return;
        }

        const safeMessage =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Falha ao enviar o arquivo. Tente novamente.";

        updateItem(item.localId, (prev) => ({
          ...prev,
          status: "ERROR",
          errorMessage: safeMessage,
        }));
      } finally {
        abortControllersRef.current.delete(item.localId);
      }
    },
    [
      binaryUploader,
      ensureCsrfToken,
      fetchImpl,
      maxFileBytes,
      options.createDocumentOnFinalize,
      options.documentId,
      updateItem,
    ],
  );

  const startBatchUpload = useCallback(
    async (metadata: UploadMetadataFormValues): Promise<void> => {
      const readyItems = items.filter((item) => item.status === "READY");
      if (readyItems.length === 0) {
        return;
      }
      await Promise.all(readyItems.map((item) => uploadSingleItem(item, metadata)));
    },
    [items, uploadSingleItem],
  );

  const retryItem = useCallback(
    async (localId: string, metadata: UploadMetadataFormValues): Promise<void> => {
      const target = items.find((item) => item.localId === localId);
      if (!target || (target.status !== "ERROR" && target.status !== "CANCELLED")) {
        return;
      }
      await uploadSingleItem(target, metadata);
    },
    [items, uploadSingleItem],
  );

  const summary = useMemo(() => {
    let ready = 0;
    let active = 0;
    let succeeded = 0;
    let failed = 0;
    let cancelled = 0;

    for (const item of items) {
      if (item.status === "READY") {
        ready += 1;
      } else if (
        item.status === "CREATING_SESSION" ||
        item.status === "UPLOADING" ||
        item.status === "FINALIZING"
      ) {
        active += 1;
      } else if (item.status === "QUARANTINED" || item.status === "AVAILABLE") {
        succeeded += 1;
      } else if (item.status === "CANCELLED") {
        cancelled += 1;
      } else {
        failed += 1;
      }
    }

    return {
      total: items.length,
      ready,
      active,
      succeeded,
      failed,
      cancelled,
      isUploading: active > 0,
    };
  }, [items]);

  return {
    items,
    summary,
    maxFileBytes,
    addFiles,
    removeItem,
    cancelItem,
    cancelAll,
    clearAll,
    startBatchUpload,
    retryItem,
  };
}
